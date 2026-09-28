import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { gameKeys } from "@/hooks/queries/useGames";
import { checkServerVersion } from "@/hooks/queries/useServerVersion";
import { fetchDlsiteWorkType } from "@/metadata/api/dlsite";
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

export const CLOUD_SCAN_SOURCES: readonly SourceType[] = [
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

function defaultDeps(): CloudScanDeps {
	const session = createMetadataSession();
	return {
		searchByName: (params) => session.searchByName(params),
		getGameById: (id, source) => session.getGameById(id, source),
		getDlsiteWorkType: (rjId) =>
			fetchDlsiteWorkType(rjId, getNetworkRequestContext()),
		findVndbIdBySteamAppId: (appId) =>
			fetchVndbIdBySteamAppId(appId, getNetworkRequestContext()),
	};
}

export function useCloudScan(overrides: Partial<CloudScanDeps> = {}) {
	const queryClient = useQueryClient();
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState({
		done: 0,
		total: 0,
	});
	const [pending, setPending] = useState<ScanPendingItem[]>([]);
	const [error, setError] = useState<unknown>(null);
	const [failedCount, setFailedCount] = useState(0);
	const cancelledRef = useRef(false);
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
		setPending(await getScanPending());
		await queryClient.invalidateQueries({
			queryKey: gameKeys.all,
		});
		await checkServerVersion();
	}, [queryClient]);

	const scan = useCallback(async () => {
		cancelledRef.current = false;
		setRunning(true);
		setError(null);
		try {
			await startCloudScan();
			const items = (await getScanPending()).filter(
				(item) => item.scan_status === "pending",
			);
			setProgress({ done: 0, total: items.length });
			const resolver = deps();
			let failed = 0;
			setFailedCount(0);

			for (const [index, item] of items.entries()) {
				if (cancelledRef.current) break;

				const outcome = await resolveCloudScanName(
					item.name,
					resolver,
					CLOUD_SCAN_SOURCES,
				);
				if (outcome.kind === "accepted") {
					await saveAccepted(item, outcome.draft);
				} else if (outcome.kind === "failed") {
					failed += 1;
					setFailedCount(failed);
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
				setProgress({
					done: index + 1,
					total: items.length,
				});
			}
		} catch (scanError) {
			setError(scanError);
		} finally {
			setRunning(false);
			await refresh().catch(() => undefined);
		}
	}, [deps, refresh, saveAccepted]);

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
		cancelledRef.current = true;
	}, []);

	const loadPending = useCallback(async () => {
		setPending(await getScanPending());
	}, []);

	return {
		scan,
		confirm,
		dismiss,
		cancel,
		loadPending,
		running,
		progress,
		pending,
		error,
		failedCount,
	};
}
