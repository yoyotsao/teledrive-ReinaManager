/**
 * @file 雲端掃描用的嚴格標題比對
 * @description 只在完全相同或別名完全相同時自動套用；包含關係只列為待確認。
 */

export type TitleMatchLevel = "exact" | "candidate" | "none";

export interface TitleMatch {
	level: TitleMatchLevel;
	matched?: string;
}

const MIN_CANDIDATE_LENGTH = 4;
const MIN_CANDIDATE_RATIO = 0.8;

/** DLsite 的遊戲類 work_type。SOU、MNG、ICG 等非遊戲類型不接受。 */
const DLSITE_GAME_WORK_TYPES = new Set([
	"ACN",
	"QIZ",
	"ADV",
	"RPG",
	"TBL",
	"DNV",
	"SLN",
	"TYP",
	"STG",
	"PZL",
	"ETC",
]);

export function normalizeTitle(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function length(value: string): number {
	return [...value].length;
}

export function classifyTitleMatch(
	query: string,
	titles: readonly (string | undefined | null)[],
): TitleMatch {
	const normalizedQuery = normalizeTitle(query);
	if (!normalizedQuery) return { level: "none" };

	let candidate: string | undefined;
	for (const title of titles) {
		if (!title) continue;
		const normalizedTitle = normalizeTitle(title);
		if (!normalizedTitle) continue;

		if (normalizedTitle === normalizedQuery) {
			return { level: "exact", matched: title };
		}

		const [short, long] =
			length(normalizedTitle) < length(normalizedQuery)
				? [normalizedTitle, normalizedQuery]
				: [normalizedQuery, normalizedTitle];
		if (
			!candidate &&
			long.includes(short) &&
			length(short) >= MIN_CANDIDATE_LENGTH &&
			length(short) / length(long) >= MIN_CANDIDATE_RATIO
		) {
			candidate = title;
		}
	}

	return candidate
		? { level: "candidate", matched: candidate }
		: { level: "none" };
}

export function isDlsiteGameWorkType(workType: string | undefined): boolean {
	return workType ? DLSITE_GAME_WORK_TYPES.has(workType.toUpperCase()) : false;
}
