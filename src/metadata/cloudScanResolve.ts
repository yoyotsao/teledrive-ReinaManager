/**
 * @file 雲端掃描的單一名稱解析
 * @description 依序處理 RJ 號碼、Steam App ID、名稱嚴格比對。
 */

import type { GameMetadataDraft, SourceType } from "@/types";
import { isApiRateLimitError } from "@/utils/errors";
import type { SourceCandidate } from "./sourceCandidate";
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
}

const RJ_NAME = /^(?:RJ)?(\d{6}|\d{8})$/i;
const STEAM_NAME = /^\d{3,7}$/;
const SEARCH_LIMIT = 5;

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

	const candidates: ScanCandidate[] = [];
	let searchError: unknown = null;

	for (const source of sources) {
		let results: SourceCandidate[];
		try {
			results = await deps.searchByName({
				query: trimmed,
				source,
				limit: SEARCH_LIMIT,
			});
		} catch (error) {
			rethrowRateLimit(error);
			searchError ??= error;
			continue;
		}

		for (const result of results) {
			if (!result.externalId) continue;
			const match = classifyTitleMatch(trimmed, candidateTitles(result));
			if (match.level === "exact") {
				return {
					kind: "accepted",
					draft: await deps.getGameById(result.externalId, source),
				};
			}
			if (match.level === "candidate") {
				candidates.push({
					source,
					externalId: result.externalId,
					name: result.display.name ?? match.matched ?? trimmed,
					...(result.display.image ? { image: result.display.image } : {}),
				});
			}
		}
	}

	if (candidates.length > 0) {
		return { kind: "needs_confirmation", candidates };
	}
	if (searchError !== null) {
		return { kind: "failed", error: searchError };
	}
	return { kind: "not_found", reason: "no_match" };
}
