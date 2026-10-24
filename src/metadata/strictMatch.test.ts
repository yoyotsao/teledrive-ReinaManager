import { describe, expect, it } from "vitest";
import {
	classifyTitleMatch,
	isDlsiteGameWorkType,
	normalizeTitle,
} from "./strictMatch";

describe("normalizeTitle", () => {
	it("NFKC、忽略大小寫、壓縮空白", () => {
		expect(normalizeTitle("  ＶｅｎｕｓＢｌｏｏｄ　-GAIA- ")).toBe(
			"venusblood -gaia-",
		);
	});
});

describe("classifyTitleMatch：舊封面腳本的誤配不能再自動套用", () => {
	it("h 不會配到 H+", () => {
		expect(classifyTitleMatch("h", ["H+"]).level).toBe("none");
	});

	it("RANZE 不會配到 RAYZE", () => {
		expect(classifyTitleMatch("RANZE", ["RAYZE"]).level).toBe("none");
	});

	it("Hypnosis App 2 不會配到 Hypnosis", () => {
		expect(classifyTitleMatch("Hypnosis App 2", ["Hypnosis"]).level).toBe(
			"none",
		);
	});
});

describe("classifyTitleMatch：可以自動套用", () => {
	it("主標題完全相同（忽略大小寫）", () => {
		expect(
			classifyTitleMatch("To Be or Not to Be", ["To Be or Not To Be"]),
		).toEqual({
			level: "exact",
			matched: "To Be or Not To Be",
		});
	});

	it("別名完全相同", () => {
		expect(
			classifyTitleMatch("Koikata", [
				"Koi Suru Kimochi no Kasanekata",
				undefined,
				"Koikata",
			]).level,
		).toBe("exact");
	});

	it("全形與半形視為相同", () => {
		expect(
			classifyTitleMatch("ＶｅｎｕｓＢｌｏｏｄ", ["VenusBlood"]).level,
		).toBe("exact");
	});
});

describe("classifyTitleMatch：只能列為待確認", () => {
	it("包含關係且長度比 ≥ 0.8", () => {
		expect(
			classifyTitleMatch("Amaoto ni Michiru Yoru", [
				"Amaoto ni Michiru Yoru EX",
			]).level,
		).toBe("candidate");
	});

	it("包含關係但較短名稱少於 4 字", () => {
		expect(classifyTitleMatch("Rei", ["Rei!"]).level).toBe("none");
	});

	it("完全不相干", () => {
		expect(classifyTitleMatch("黄昏少女", ["昨日の魔女は今日の夢"]).level).toBe(
			"none",
		);
	});
});

describe("isDlsiteGameWorkType", () => {
	it("SOU（音聲）不是遊戲", () => {
		expect(isDlsiteGameWorkType("SOU")).toBe(false);
	});

	it("SLN（模擬）是遊戲", () => {
		expect(isDlsiteGameWorkType("SLN")).toBe(true);
	});

	it("漫畫與未知類型不是遊戲", () => {
		expect(isDlsiteGameWorkType("MNG")).toBe(false);
		expect(isDlsiteGameWorkType(undefined)).toBe(false);
	});
});

describe("classifyTitleMatch：忽略標點與空白差異", () => {
	it.each([
		["Cafe Little Wish", "Cafe・LittleWish"],
		[
			"Re：ゼロから始める異世界生活 偽りの王選候補",
			"Re:ゼロから始める異世界生活 偽りの王選候補",
		],
		[
			"乙女理論とその後の周辺 -Belle Epoque-",
			"乙女理論とその後の周辺 -Belle Époque-",
		],
		["加奈 ～いもうと～", "加奈～いもうと～"],
	])("%s = %s", (query, title) => {
		expect(classifyTitleMatch(query, [title]).level).toBe("exact");
	});

	it("日文濁音不能被當成清音", () => {
		expect(classifyTitleMatch("がっこう", ["かっこう"]).level).toBe("none");
	});

	it("緊縮後過短時不採用", () => {
		expect(classifyTitleMatch("h", ["H+"]).level).toBe("none");
	});
});
