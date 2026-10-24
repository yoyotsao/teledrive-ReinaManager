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

/**
 * 比對「完全相同」用的緊縮形式：再去掉空白、標點與符號，以及拉丁字母的重音。
 * 資料夾名與資料庫標題常只差在 `・`、`～`、`:`／`：`、`-Belle Époque-` 這類寫法。
 * 只去拉丁重音（U+0300–036F），日文濁音拆開後的 U+3099 不能去，否則が會等於か。
 */
export function compactTitle(value: string): string {
	return normalizeTitle(value)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.normalize("NFC")
		.replace(/[\p{P}\p{S}\p{Z}]/gu, "");
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
	const compactQuery = compactTitle(query);

	let candidate: string | undefined;
	for (const title of titles) {
		if (!title) continue;
		const normalizedTitle = normalizeTitle(title);
		if (!normalizedTitle) continue;

		if (
			normalizedTitle === normalizedQuery ||
			// 短名稱差一個符號可能就是不同作品（如 Rei／Rei!），太短時不放寬
			(length(compactQuery) >= MIN_CANDIDATE_LENGTH &&
				compactTitle(title) === compactQuery)
		) {
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
