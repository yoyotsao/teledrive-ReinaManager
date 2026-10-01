/**
 * @file 雲端掃描的單一名稱解析
 * @description 依序處理 RJ 號碼、數字編號（Getchu／Steam）、名稱嚴格比對。
 * 命中 HGameFree 下載站文章時，再用文章裡的外部 ID 與標題補其他來源的完整資料。
 */

import type { GameMetadataDraft, HgamefreeData, SourceType } from "@/types";
import { isApiRateLimitError } from "@/utils/errors";
import {
	createGameCandidate,
	mergeCandidateSources,
	type SourceCandidate,
} from "./sourceCandidate";
import { classifyTitleMatch, isDlsiteGameWorkType } from "./strictMatch";

export interface ScanCandidate {
	source: SourceType;
	externalId: string;
	name: string;
	image?: string;
}

export type CloudScanOutcome =
	| { kind: "accepted"; draft: GameMetadataDraft }
	| { kind: "needs_confirmation"; candidates: ScanCandidate[] }
	| { kind: "not_found"; reason: "no_match" | "dlsite_not_game" }
	| { kind: "failed"; error: unknown };

export interface CloudScanDeps {
	searchByName(params: {
		query: string;
		source: SourceType;
		limit?: number;
	}): Promise<SourceCandidate[]>;
	getGameById(id: string, source: SourceType): Promise<GameMetadataDraft>;
	getDlsiteWorkType(rjId: string): Promise<string | undefined>;
	findVndbIdBySteamAppId(appId: number): Promise<string | null>;
	/**
	 * 依外部作品 ID（`steam:<id>`、`getchu:<id>`、`dlsite:RJxxxxxx`）在 HGameFree
	 * 文章索引裡反查，查不到回 null。沒有索引時（桌面版）不提供。
	 */
	findHgamefreeByExternalId?(id: string): Promise<GameMetadataDraft | null>;
}

const RJ_NAME = /^(?:RJ)?(\d{6}|\d{8})$/i;
const STEAM_NAME = /^\d{3,7}$/;
const NUMERIC_NAME = /^\d{3,8}$/;
const SEARCH_LIMIT = 5;
/** 無嚴格候選時，每個來源最多提供給使用者挑選的搜尋結果數。 */
const FALLBACK_PER_SOURCE = 2;
/** 結尾的版本號，如 ` v1.0.9`、`_Ver1.2`。要有 v/ver 前綴，避免把 `Game 2` 之類的續作誤當版本。 */
const TRAILING_VERSION = /[\s_-]+(?:v|ver\.?)\s*\d+(?:\.\d+)*[a-z]?$/i;
const TRAILING_BRACKETS = /\s*(?:\[[^\]]*\]|［[^］]*］)$/;

function candidateTitles(candidate: SourceCandidate): (string | undefined)[] {
	const display = candidate.display;
	return [
		display.name,
		display.name_cn,
		...(display.all_titles ?? []),
		...(display.aliases ?? []),
	];
}

function rethrowRateLimit(error: unknown): void {
	if (isApiRateLimitError(error)) throw error;
}

/** 補充資料的步驟：出錯視為沒有結果，只有限流會往外拋。 */
async function attempt<T>(step: () => Promise<T | null>): Promise<T | null> {
	try {
		return await step();
	} catch (error) {
		rethrowRateLimit(error);
		return null;
	}
}

/** 去掉資料夾名結尾的版本號與方括號標記，得到搜尋用的名稱。 */
export function cleanScanQuery(name: string): string {
	let query = name.trim();
	for (;;) {
		const next = query
			.replace(TRAILING_BRACKETS, "")
			.replace(TRAILING_VERSION, "")
			.trim();
		if (next === query) break;
		query = next;
	}
	return query || name.trim();
}

const LEVEL_RANK = { exact: 2, candidate: 1, none: 0 } as const;

/** 原名與去版本號後的名稱各比一次，取較好的結果。 */
function classifyEither(
	names: readonly string[],
	titles: readonly (string | undefined)[],
) {
	let best = classifyTitleMatch(names[0], titles);
	for (const name of names.slice(1)) {
		const match = classifyTitleMatch(name, titles);
		if (LEVEL_RANK[match.level] > LEVEL_RANK[best.level]) best = match;
	}
	return best;
}

function mergeDrafts(
	primary: GameMetadataDraft,
	others: readonly GameMetadataDraft[],
): GameMetadataDraft {
	return createGameCandidate({
		idType: primary.id_type,
		sources: mergeCandidateSources([...others, primary]),
		customData: primary.custom_data,
	});
}

function hgamefreeExternalIds(draft: GameMetadataDraft): string[] {
	const record = draft.sources.find((item) => item.source === "hgamefree");
	return (record?.data as HgamefreeData | undefined)?.external_ids ?? [];
}

/**
 * 下載站文章只有標題、封面和下載連結。命中後補其他來源的完整資料：
 * 1. 文章連結到的 Steam／DLsite 作品，直接用 ID 抓；
 * 2. 用文章標題在 VNDB 等來源找精確符合的條目。
 * 主要來源的優先序是：標題命中的資料庫 > Steam > DLsite > 下載站本身；
 * 下載站記錄（含下載連結）一律保留。補資料失敗不影響命中。
 */
async function enrichHgamefreeDraft(
	draft: GameMetadataDraft,
	title: string,
	deps: CloudScanDeps,
	sources: readonly SourceType[],
): Promise<GameMetadataDraft> {
	const ids = hgamefreeExternalIds(draft);
	const steamId = ids.find((id) => id.startsWith("steam:"))?.slice(6);
	const dlsiteId = ids.find((id) => id.startsWith("dlsite:"))?.slice(7);

	const steam = steamId
		? await attempt(() => deps.getGameById(steamId, "steam"))
		: null;
	const dlsite = dlsiteId
		? await attempt(() => deps.getGameById(dlsiteId, "dlsite"))
		: null;

	let titled: GameMetadataDraft | null = null;
	for (const source of sources) {
		if (source === "hgamefree" || (source === "steam" && steam)) continue;
		titled = await attempt(async () => {
			const results = await deps.searchByName({
				query: title,
				source,
				limit: SEARCH_LIMIT,
			});
			const exact = results.find(
				(result) =>
					result.externalId &&
					classifyTitleMatch(title, candidateTitles(result)).level === "exact",
			);
			return exact?.externalId
				? deps.getGameById(exact.externalId, source)
				: null;
		});
		if (titled) break;
	}

	const found = [titled, steam, dlsite].filter(
		(item): item is GameMetadataDraft => item !== null,
	);
	const [primary, ...rest] = found;
	return primary ? mergeDrafts(primary, [draft, ...rest]) : draft;
}

/** 依外部 ID 依序在索引裡反查，回第一個命中的文章（已補完整資料）。 */
async function resolveViaIndex(
	ids: readonly string[],
	deps: CloudScanDeps,
	sources: readonly SourceType[],
): Promise<GameMetadataDraft | null> {
	const find = deps.findHgamefreeByExternalId;
	if (!find) return null;

	for (const id of ids) {
		const post = await attempt(() => find.call(deps, id));
		if (!post) continue;

		const record = post.sources.find((item) => item.source === "hgamefree");
		const title = (record?.data as HgamefreeData | undefined)?.name ?? "";
		return enrichHgamefreeDraft(post, title, deps, sources);
	}
	return null;
}

export async function resolveCloudScanName(
	name: string,
	deps: CloudScanDeps,
	sources: readonly SourceType[],
): Promise<CloudScanOutcome> {
	try {
		return await resolveOrThrow(name, deps, sources);
	} catch (error) {
		rethrowRateLimit(error);
		return { kind: "failed", error };
	}
}

async function resolveOrThrow(
	name: string,
	deps: CloudScanDeps,
	sources: readonly SourceType[],
): Promise<CloudScanOutcome> {
	const trimmed = name.trim();

	const rj = RJ_NAME.exec(trimmed);
	if (rj) {
		const rjId = `RJ${rj[1]}`;
		const workType = await deps.getDlsiteWorkType(rjId);
		if (workType !== undefined) {
			if (!isDlsiteGameWorkType(workType)) {
				return { kind: "not_found", reason: "dlsite_not_game" };
			}
			return {
				kind: "accepted",
				draft: await deps.getGameById(rjId, "dlsite"),
			};
		}
	}

	// 純數字可能是 DLsite RJ 號碼、Getchu 商品編號或 Steam App ID。
	// 先查下載站索引（文章裡有這些外部連結），比只看 VNDB 涵蓋更廣。
	if (NUMERIC_NAME.test(trimmed) || rj) {
		const digits = trimmed.replace(/^RJ/i, "");
		const ids = [
			...(rj ? [`dlsite:RJ${digits}`] : []),
			...(NUMERIC_NAME.test(trimmed)
				? [`getchu:${digits}`, `steam:${digits}`]
				: []),
		];
		const indexed = await resolveViaIndex(ids, deps, sources);
		if (indexed) return { kind: "accepted", draft: indexed };
	}

	if (STEAM_NAME.test(trimmed)) {
		const vnId = await deps.findVndbIdBySteamAppId(Number(trimmed));
		if (vnId) {
			return {
				kind: "accepted",
				draft: await deps.getGameById(vnId, "vndb"),
			};
		}
		return { kind: "not_found", reason: "no_match" };
	}

	// 搜尋用的名稱去掉版本號；下載站索引自己會處理雜訊，仍用原名。
	const query = cleanScanQuery(trimmed);
	const candidates: ScanCandidate[] = [];
	// 嚴格比對不到時的備選：資料夾名常帶社團、版本、漢化標記，
	// 與資料庫標題差異大，此時仍列出搜尋前幾名讓使用者自己挑。
	const fallback: ScanCandidate[] = [];
	let searchError: unknown = null;

	for (const source of sources) {
		let results: SourceCandidate[];
		try {
			results = await deps.searchByName({
				query: source === "hgamefree" ? trimmed : query,
				source,
				limit: SEARCH_LIMIT,
			});
		} catch (error) {
			rethrowRateLimit(error);
			searchError ??= error;
			continue;
		}

		let fallbackCount = 0;
		for (const result of results) {
			if (!result.externalId) continue;
			const match = classifyEither([trimmed, query], candidateTitles(result));
			if (match.level === "exact") {
				const draft = await deps.getGameById(result.externalId, source);
				if (source === "hgamefree") {
					return {
						kind: "accepted",
						draft: await enrichHgamefreeDraft(
							draft,
							result.display.name ?? trimmed,
							deps,
							sources,
						),
					};
				}
				const findPost = deps.findHgamefreeByExternalId;
				if (source === "steam" && findPost) {
					// Steam 名稱精確命中：若下載站有這款，把文章（含下載連結）一併記錄
					const post = await attempt(() =>
						findPost.call(deps, `steam:${result.externalId}`),
					);
					return {
						kind: "accepted",
						draft: post ? mergeDrafts(draft, [post]) : draft,
					};
				}
				return { kind: "accepted", draft };
			}
			const entry: ScanCandidate = {
				source,
				externalId: result.externalId,
				name: result.display.name ?? match.matched ?? trimmed,
				...(result.display.image ? { image: result.display.image } : {}),
			};
			if (match.level === "candidate") {
				candidates.push(entry);
			} else if (fallbackCount < FALLBACK_PER_SOURCE) {
				fallback.push(entry);
				fallbackCount += 1;
			}
		}
	}

	if (candidates.length > 0) {
		return { kind: "needs_confirmation", candidates };
	}
	if (fallback.length > 0) {
		return { kind: "needs_confirmation", candidates: fallback };
	}
	if (searchError !== null) {
		return { kind: "failed", error: searchError };
	}
	return { kind: "not_found", reason: "no_match" };
}
