import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { gameKeys } from "@/hooks/queries/useGames";
import { checkServerVersion } from "@/hooks/queries/useServerVersion";
import { fetchDlsiteWorkType } from "@/metadata/api/dlsite";
import { findHgamefreeByExternalId } from "@/metadata/api/hgamefree";
import { fetchVndbIdBySteamAppId } from "@/metadata/api/vndb";
import {
	type CloudScanDeps,
	resolveCloudScanName,
	type ScanCandidate,
} from "@/metadata/cloudScanResolve";
import { buildMetadataUpdatePayload } from "@/metadata/data/metadata";
import { gameService } from "@/services/invoke";
import {
	createMetadataSession,
	getNetworkRequestContext,
} from "@/services/requestContext";
import { setSourceCover } from "@/services/web/covers";
import {
	getScanPending,
	type ScanPendingItem,
	startCloudScan,
} from "@/services/web/scan";
import type {
	CustomData,
	GameMetadataDraft,
	JsonValue,
	SourceType,
} from "@/types";
import { isApiRateLimitError } from "@/utils/errors";

// hgamefree 放第一个：用户的资料夹名来自这个下载站，压缩包文件名能精确命中（本机索引，最快）。
// 命中后 resolveCloudScanName 会用文章里的 Steam／DLsite ID 与标题去其他来源补完整资料。
// steam 第二个：资料夹名常是 Steam 英文名，VNDB 等偏 galgame 的库收不到非 VN 的游戏。
export const CLOUD_SCAN_SOURCES: readonly SourceType[] = [
	"hgamefree",
	"steam",
	"vndb",
	"bgm",
	"ymgal",
];

function draftCoverImage(draft: GameMetadataDraft): string | null {
	const ordered = [
		...draft.sources.filter((record) => record.source === draft.id_type),
		...draft.sources.filter((record) => record.source !== draft.id_type),
	];
	for (const record of ordered) {
		const image = (record.data as { image?: string } | undefined)?.image;
		if (image) return image;
	}
	return null;
}

/** 背景自動掃描的間隔；頁面切到背景也照常計時。 */
export const CLOUD_SCAN_INTERVAL_MS = 60 * 60_000;
/**
 * 檢查是否到期的頻率。不直接用掃描間隔當計時器：lastScanAt 在掃描結束才記錄，
 * 到點時常差幾秒未到期而整輪跳過；瀏覽器對背景分頁的計時器節流也會讓觸發延後。
 */
const CLOUD_SCAN_CHECK_MS = 5 * 60_000;

/** 匯入的套用建議：把待確認的遊戲 `id` 套用指定來源的條目。 */
export interface ScanDecision {
	id: number;
	source: SourceType;
	externalId: string;
}

export interface ApplyDecisionsResult {
	applied: number;
	/** 已不在待確認清單（已處理或已刪除）而略過的筆數 */
	skipped: number;
	failed: number;
}

/** 解析使用者貼上的建議 JSON；格式不對時回傳 null。 */
export function parseScanDecisions(text: string): ScanDecision[] | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(value)) return null;
	const decisions: ScanDecision[] = [];
	for (const entry of value) {
		const { id, source, externalId } = (entry ?? {}) as Record<string, unknown>;
		if (
			typeof id !== "number" ||
			typeof source !== "string" ||
			typeof externalId !== "string" ||
			!externalId
		) {
			return null;
		}
		decisions.push({ id, source: source as SourceType, externalId });
	}
	return decisions;
}

export interface CloudScanOptions {
	/**
	 * 只解析新加入（`pending`）的條目。背景自動掃描用：已列入待確認的條目
	 * 若每次都重查，會反覆打外部來源、容易觸發限流；手動「立即掃描」才全部重跑。
	 */
	onlyNew?: boolean;
}

interface CloudScanState {
	running: boolean;
	progress: { done: number; total: number };
	pending: ScanPendingItem[];
	error: unknown;
	failedCount: number;
	/** 最近一次掃描結束的時間（毫秒），尚未掃描過為 null */
	lastScanAt: number | null;
}

const INITIAL_CLOUD_SCAN_STATE: CloudScanState = {
	running: false,
	progress: { done: 0, total: 0 },
	pending: [],
	error: null,
	failedCount: 0,
	lastScanAt: null,
};

let scanCancelled = false;

// 掃描狀態放在模組層級：背景自動掃描（App 掛載）與新增對話框共用同一份進度和待確認清單，
// 也避免兩邊同時各跑一次掃描。
export const useCloudScanStore = create<CloudScanState>(() => ({
	...INITIAL_CLOUD_SCAN_STATE,
}));

/** 測試用：還原為初始狀態 */
export function resetCloudScanState() {
	useCloudScanStore.setState({ ...INITIAL_CLOUD_SCAN_STATE });
	scanCancelled = false;
}

function defaultDeps(): CloudScanDeps {
	const session = createMetadataSession();
	return {
		searchByName: (params) => session.searchByName(params),
		getGameById: (id, source) => session.getGameById(id, source),
		getDlsiteWorkType: (rjId) =>
			fetchDlsiteWorkType(rjId, getNetworkRequestContext()),
		findVndbIdBySteamAppId: (appId) =>
			fetchVndbIdBySteamAppId(appId, getNetworkRequestContext()),
		findHgamefreeByExternalId: (id) =>
			findHgamefreeByExternalId(id, getNetworkRequestContext()),
	};
}

export function useCloudScan(overrides: Partial<CloudScanDeps> = {}) {
	const queryClient = useQueryClient();
	const state = useCloudScanStore();
	const overridesRef = useRef(overrides);
	overridesRef.current = overrides;

	const deps = useCallback(
		(): CloudScanDeps => ({
			...defaultDeps(),
			...overridesRef.current,
		}),
		[],
	);

	const saveAccepted = useCallback(
		async (item: ScanPendingItem, draft: GameMetadataDraft) => {
			const placeholderName =
				item.teledrive_path
					.replaceAll("\\", "/")
					.split("/")
					.filter(Boolean)
					.at(-1) ?? "";
			let customData: CustomData | undefined;

			// 掃描建立時 custom_data.name 只是目錄名佔位。只有它仍等於原始
			// TeleDrive 名稱時才清掉；使用者在掃描期間手動改名則必須保留。
			if (placeholderName && item.name === placeholderName) {
				const current = await gameService.getGameById(item.id);
				if (current?.custom_data?.name === placeholderName) {
					customData = {
						...current.custom_data,
						name: null,
					};
				}
			}

			await gameService.updateGame(item.id, {
				...buildMetadataUpdatePayload(draft),
				...(customData ? { custom_data: customData } : {}),
				scan_status: "complete",
				scan_candidates: null,
			});

			const image = draftCoverImage(draft);
			if (image) {
				await setSourceCover(item.id, image).catch(() => undefined);
			}
		},
		[],
	);

	const refresh = useCallback(async () => {
		useCloudScanStore.setState({ pending: await getScanPending() });
		await queryClient.invalidateQueries({
			queryKey: gameKeys.all,
		});
		await checkServerVersion();
	}, [queryClient]);

	const scan = useCallback(
		async ({ onlyNew = false }: CloudScanOptions = {}) => {
			// 背景與手動掃描共用狀態，已在跑時不重複啟動
			if (useCloudScanStore.getState().running) return;
			scanCancelled = false;
			useCloudScanStore.setState({
				running: true,
				error: null,
				failedCount: 0,
				progress: { done: 0, total: 0 },
			});
			try {
				await startCloudScan();
				// 手動掃描時待確認項目也重跑：新增的來源或索引更新後，舊候選可能已經過時，
				// 例如之前只查到 bgm 候選，現在下載站索引能精確命中而自動套用。
				// 重跑只會覆寫候選清單，不會動使用者已確認的遊戲。
				const items = (await getScanPending()).filter(
					(item) =>
						item.scan_status === "pending" ||
						(!onlyNew && item.scan_status === "needs_confirmation"),
				);
				useCloudScanStore.setState({
					progress: { done: 0, total: items.length },
				});
				const resolver = deps();
				let failed = 0;

				for (const [index, item] of items.entries()) {
					if (scanCancelled) break;

					const outcome = await resolveCloudScanName(
						item.name,
						resolver,
						CLOUD_SCAN_SOURCES,
					);
					if (outcome.kind === "accepted") {
						await saveAccepted(item, outcome.draft);
					} else if (outcome.kind === "failed") {
						failed += 1;
						useCloudScanStore.setState({ failedCount: failed });
					} else {
						await gameService.updateGame(item.id, {
							scan_status: "needs_confirmation",
							scan_candidates:
								outcome.kind === "needs_confirmation"
									? outcome.candidates.map(
											(candidate): JsonValue => ({
												source: candidate.source,
												externalId: candidate.externalId,
												name: candidate.name,
												...(candidate.image
													? {
															image: candidate.image,
														}
													: {}),
											}),
										)
									: [],
						});
					}
					useCloudScanStore.setState({
						progress: { done: index + 1, total: items.length },
					});
				}
			} catch (scanError) {
				useCloudScanStore.setState({ error: scanError });
			} finally {
				useCloudScanStore.setState({
					running: false,
					lastScanAt: Date.now(),
				});
				await refresh().catch(() => undefined);
			}
		},
		[deps, refresh, saveAccepted],
	);

	const confirm = useCallback(
		async (item: ScanPendingItem, candidate: ScanCandidate) => {
			const draft = await deps().getGameById(
				candidate.externalId,
				candidate.source,
			);
			await saveAccepted(item, draft);
			await refresh();
		},
		[deps, refresh, saveAccepted],
	);

	/**
	 * 依匯入的建議逐筆套用，流程與手動按「套用」相同（抓完整資料、寫入、設封面）。
	 * 與掃描共用 running 狀態，避免同時寫入同一批遊戲；限流時停止，其餘留待之後再匯入。
	 */
	const applyDecisions = useCallback(
		async (decisions: ScanDecision[]): Promise<ApplyDecisionsResult> => {
			const result = { applied: 0, skipped: 0, failed: 0 };
			if (useCloudScanStore.getState().running) return result;
			scanCancelled = false;
			useCloudScanStore.setState({
				running: true,
				error: null,
				failedCount: 0,
				progress: { done: 0, total: decisions.length },
			});
			try {
				const pendingById = new Map(
					(await getScanPending()).map((item) => [item.id, item]),
				);
				const resolver = deps();
				for (const [index, decision] of decisions.entries()) {
					if (scanCancelled) break;
					const item = pendingById.get(decision.id);
					if (!item) {
						result.skipped += 1;
					} else {
						try {
							const draft = await resolver.getGameById(
								decision.externalId,
								decision.source,
							);
							await saveAccepted(item, draft);
							result.applied += 1;
						} catch (error) {
							if (isApiRateLimitError(error)) throw error;
							result.failed += 1;
							useCloudScanStore.setState({ failedCount: result.failed });
						}
					}
					useCloudScanStore.setState({
						progress: { done: index + 1, total: decisions.length },
					});
				}
			} catch (error) {
				useCloudScanStore.setState({ error });
			} finally {
				useCloudScanStore.setState({ running: false });
				await refresh().catch(() => undefined);
			}
			return result;
		},
		[deps, refresh, saveAccepted],
	);

	const dismiss = useCallback(
		async (item: ScanPendingItem) => {
			await gameService.updateGame(item.id, {
				scan_status: "complete",
				scan_candidates: null,
			});
			await refresh();
		},
		[refresh],
	);

	const cancel = useCallback(() => {
		scanCancelled = true;
	}, []);

	const loadPending = useCallback(async () => {
		useCloudScanStore.setState({ pending: await getScanPending() });
	}, []);

	return {
		scan,
		confirm,
		applyDecisions,
		dismiss,
		cancel,
		loadPending,
		...state,
	};
}

/**
 * 網頁版背景自動掃描：啟動時掃一次，之後每 {@link CLOUD_SCAN_INTERVAL_MS} 掃一次，
 * 頁面切到背景也不暫停（只要分頁還開著）。電腦睡眠等情況計時器會停住，
 * 所以回到前景時再檢查一次，已到期就補掃。只解析新加入的條目，
 * 無法自動套用的會留在待確認清單，使用者打開「添加遊戲」即可直接挑選。
 */
export function useCloudScanAutoRun(): void {
	const { scan } = useCloudScan();
	const scanRef = useRef(scan);
	scanRef.current = scan;

	useEffect(() => {
		const runIfDue = () => {
			const { lastScanAt } = useCloudScanStore.getState();
			if (
				lastScanAt !== null &&
				Date.now() - lastScanAt < CLOUD_SCAN_INTERVAL_MS
			) {
				return;
			}
			void scanRef.current({ onlyNew: true }).catch((error) => {
				console.warn("自动云端扫描失败:", error);
			});
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") runIfDue();
		};

		runIfDue();
		const timer = setInterval(runIfDue, CLOUD_SCAN_CHECK_MS);
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, []);
}
