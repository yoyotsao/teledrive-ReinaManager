import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, isWebRuntime, searchHgamefreeIndex, getHgamefreeIndexPost } =
	vi.hoisted(() => ({
		get: vi.fn(),
		isWebRuntime: vi.fn(() => false),
		searchHgamefreeIndex: vi.fn(),
		getHgamefreeIndexPost: vi.fn(),
	}));
vi.mock("./http", () => ({ default: { get } }));
vi.mock("@/services/platform", () => ({ isWebRuntime }));
vi.mock("./hgamefreeIndex", () => ({
	searchHgamefreeIndex,
	getHgamefreeIndexPost,
}));

import { hgamefreeAdapter } from "../adapters/hgamefreeAdapter";
import { resolveCloudScanName } from "../cloudScanResolve";
import {
	cleanHgamefreeTitle,
	extractHgamefreeDownloadLinks,
	extractHgamefreeFileNames,
	fetchHgamefreeById,
	searchHgamefree,
} from "./hgamefree";

function post(id: number, title: string, content: string, image?: string) {
	return {
		id,
		title: { rendered: title },
		content: { rendered: content },
		_embedded: image ? { "wp:featuredmedia": [{ source_url: image }] } : {},
	};
}

describe("cleanHgamefreeTitle", () => {
	it.each([
		["爆弾解体 [免費空間]", "爆弾解体"],
		[
			"カルティベーター ～引退騎士とモン娘のにぎやか開拓記～ 機翻中文 [3.6G] [會員空間及贊助會員]",
			"カルティベーター ～引退騎士とモン娘のにぎやか開拓記～",
		],
		[
			"イドラの影～The Shadow of Yidhra～官方中文 無修版 [400m][免費空間]",
			"イドラの影～The Shadow of Yidhra～",
		],
		["極品採花郎 v2.1.3 官方中文[版本更新][會員空間及贊助會員]", "極品採花郎"],
		["ThornSin 0.75 官方中文 [630m][補檔][會員空間及贊助會員]", "ThornSin"],
		["發情冒険者カレン AI翻中文 [免費空間]", "發情冒険者カレン"],
		["致曾是勇者的人妻們+DLC 官方中文 無修版[3.3G]", "致曾是勇者的人妻們"],
		["Thrust 8 官方中文 [374m]", "Thrust 8"],
		[
			"【Live2D互動遊戲】兔子小姐 官方中文 [160M]",
			"【Live2D互動遊戲】兔子小姐",
		],
	])("%s → %s", (raw, expected) => {
		expect(cleanHgamefreeTitle(raw)).toBe(expected);
	});

	it("全部被視為標記時保留原標題", () => {
		expect(cleanHgamefreeTitle("[免費空間]")).toBe("[免費空間]");
	});
});

describe("extractHgamefreeFileNames", () => {
	it("取出 k2s 連結的檔名並去掉副檔名", () => {
		const html = `
			<a href="http://k2s.cc/file/623830e25e66a/ThornSin.rar">k2s</a>
			<a href="http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar">k2s</a>`;
		expect(extractHgamefreeFileNames(html)).toEqual([
			"ThornSin",
			"Stranded with You",
		]);
	});

	it("解碼百分比編碼的檔名", () => {
		const html = `<a href="https://k2s.cc/file/3557ebf7eb1f7/%E9%AD%94%E6%B3%95%E5%B0%91%E5%A5%B3%E3%82%AA%E3%83%91%E3%83%BC%E3%83%AB.rar">k2S</a>`;
		expect(extractHgamefreeFileNames(html)).toEqual(["魔法少女オパール"]);
	});

	it("分卷檔去掉 .partN，同名只留一個", () => {
		const html = `
			<a href="http://k2s.cc/file/ab75cd0dffe71/Romantic Escapades.part1.rar">1</a>
			<a href="http://k2s.cc/file/ab75cd0dffe72/Romantic Escapades.part2.rar">2</a>`;
		expect(extractHgamefreeFileNames(html)).toEqual(["Romantic Escapades"]);
	});

	it("MEGA 與其他連結不會產生檔名", () => {
		const html = `
			<a href="https://mega.nz/file/pQ00nT5T#key">MEGA</a>
			<a href="https://store.steampowered.com/app/1576240/The_Shadow_of_Yidhra/">Steam</a>`;
		expect(extractHgamefreeFileNames(html)).toEqual([]);
	});
});

describe("searchHgamefree / fetchHgamefreeById", () => {
	beforeEach(() => {
		get.mockReset();
	});

	it("搜尋結果轉成帶封面與檔名別名的候選", async () => {
		get.mockResolvedValue({
			data: [
				post(
					680535,
					"與你流落荒島 官方中文 無修版 [420m] [會員空間及贊助會員]",
					`<a href="http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar">k2s</a>`,
					"https://hgamefree.info/wp-content/uploads/2026/09/cover.webp",
				),
			],
		});

		const candidates = await hgamefreeAdapter.searchByName(
			"Stranded with You",
			{
				spoilerLevel: 0,
				limit: 5,
			},
		);

		expect(get).toHaveBeenCalledWith(
			"https://hgamefree.info/wp-json/wp/v2/posts",
			expect.objectContaining({
				params: expect.objectContaining({
					search: "Stranded with You",
					per_page: 5,
				}),
				rateLimit: { source: "hgamefree" },
			}),
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			source: "hgamefree",
			externalId: "680535",
			display: {
				name: "與你流落荒島",
				image: "https://hgamefree.info/wp-content/uploads/2026/09/cover.webp",
				aliases: ["Stranded with You"],
			},
		});
	});

	it("標題的 HTML 實體會被解碼", async () => {
		get.mockResolvedValue({
			data: [post(1, "脫衣麻將 &#8211; Venus Returns [免費空間]", "")],
		});
		const [draft] = await searchHgamefree("脫衣麻將");
		expect(draft.sources[0].data).toMatchObject({
			name: "脫衣麻將 – Venus Returns",
		});
	});

	it("空關鍵字不發請求", async () => {
		await expect(searchHgamefree("  ")).resolves.toEqual([]);
		expect(get).not.toHaveBeenCalled();
	});

	it("依 ID 取單篇文章；查無文章時丟 metadata_not_found", async () => {
		get.mockResolvedValueOnce({ data: post(7, "NTREX 官方中文 [1.9G]", "") });
		const draft = await fetchHgamefreeById("7");
		expect(draft.id_type).toBe("hgamefree");
		expect(get.mock.calls[0][0]).toBe(
			"https://hgamefree.info/wp-json/wp/v2/posts/7",
		);

		get.mockResolvedValueOnce({ data: null });
		await expect(fetchHgamefreeById("8")).rejects.toMatchObject({
			code: "metadata_not_found",
		});
		await expect(fetchHgamefreeById("abc")).rejects.toMatchObject({
			code: "invalid_game_id",
		});
	});
});

describe("雲端掃描以壓縮包檔名匹配 HGameFree", () => {
	beforeEach(() => {
		get.mockReset();
	});

	function scanDeps() {
		return {
			searchByName: async ({
				query,
				source,
				limit,
			}: {
				query: string;
				source: string;
				limit?: number;
			}) =>
				source === "hgamefree"
					? hgamefreeAdapter.searchByName(query, { spoilerLevel: 0, limit })
					: [],
			getGameById: vi.fn(async (id: string, source: string) =>
				source === "hgamefree"
					? hgamefreeAdapter.fetchById(id, { spoilerLevel: 0 })
					: ({ id_type: source, sources: [] } as never),
			),
			getDlsiteWorkType: vi.fn(async () => undefined),
			findVndbIdBySteamAppId: vi.fn(async () => null),
		};
	}

	it("zip 名稱等於文章下載檔名時自動套用，即使標題完全不同", async () => {
		const article = post(
			680535,
			"與你流落荒島 官方中文 無修版 [420m]",
			`<a href="http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar">k2s</a>`,
		);
		// 搜尋回陣列，依 ID 取單篇回物件。
		get.mockImplementation(async (url: string) => ({
			data: url.endsWith("/posts") ? [article] : article,
		}));
		const deps = scanDeps();

		const outcome = await resolveCloudScanName("Stranded with You", deps, [
			"hgamefree",
		]);

		expect(outcome.kind).toBe("accepted");
		expect(deps.getGameById).toHaveBeenCalledWith("680535", "hgamefree");
	});

	it("檔名沒對上時只列為備選，不自動套用", async () => {
		get.mockResolvedValue({
			data: [post(1, "別的遊戲 官方中文 [1G]", "")],
		});
		const deps = scanDeps();

		const outcome = await resolveCloudScanName("Stranded with You", deps, [
			"hgamefree",
		]);

		expect(outcome.kind).toBe("needs_confirmation");
		expect(deps.getGameById).not.toHaveBeenCalled();
	});
});

describe("原始下載連結", () => {
	it("只收 k2s 與 MEGA 連結，保留原文並去重", () => {
		const html = `
			<a href="https://store.steampowered.com/app/1/x/">Steam</a>
			<a href="http://k2s.cc/file/a/My Game.part1.rar">1</a>
			<a href="https://mega.nz/folder/LGgFkR4A#88Qa55zcktQB8JwiGqfL6w">MEGA</a>
			<a href="http://k2s.cc/file/a/My Game.part1.rar">重複</a>
			<a href="https://evil.example/file/1/Fake.rar">x</a>`;
		expect(extractHgamefreeDownloadLinks(html)).toEqual([
			"http://k2s.cc/file/a/My Game.part1.rar",
			"https://mega.nz/folder/LGgFkR4A#88Qa55zcktQB8JwiGqfL6w",
		]);
	});

	it("即時搜尋的候選帶有 file_url", async () => {
		isWebRuntime.mockReturnValue(false);
		get.mockReset();
		get.mockResolvedValue({
			data: [
				post(
					1,
					"NTREX 官方中文 [1.9G]",
					`<a href="https://k2s.cc/file/3e261c9c2f6b6/NTREX.rar">k2S</a>
					<a href="https://mega.nz/file/abc#key">MEGA</a>`,
				),
			],
		});
		const [draft] = await searchHgamefree("NTREX");
		expect(draft.sources[0].data).toMatchObject({
			aliases: ["NTREX"],
			file_url: [
				"https://k2s.cc/file/3e261c9c2f6b6/NTREX.rar",
				"https://mega.nz/file/abc#key",
			],
		});
	});
});

describe("網頁版查本機索引", () => {
	const indexItem = {
		id: "680535",
		title: "與你流落荒島 官方中文 無修版 [420m]",
		image: "https://hgamefree.info/c.webp",
		file_names: ["Stranded with You"],
		file_url: ["http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar"],
	};

	beforeEach(() => {
		get.mockReset();
		searchHgamefreeIndex.mockReset();
		getHgamefreeIndexPost.mockReset();
		isWebRuntime.mockReturnValue(true);
	});

	it("索引就緒時直接用索引結果，不打站台", async () => {
		searchHgamefreeIndex.mockResolvedValue([indexItem]);

		const [draft] = await searchHgamefree("Stranded with You", 5);

		expect(searchHgamefreeIndex).toHaveBeenCalledWith(
			"Stranded with You",
			5,
			undefined,
		);
		expect(get).not.toHaveBeenCalled();
		expect(draft.sources[0]).toMatchObject({
			external_id: "680535",
			data: {
				name: "與你流落荒島",
				image: "https://hgamefree.info/c.webp",
				aliases: ["Stranded with You"],
				file_url: ["http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar"],
			},
		});
	});

	it("索引就緒但查無結果時回空，不退回站台", async () => {
		searchHgamefreeIndex.mockResolvedValue([]);
		await expect(searchHgamefree("沒有這款")).resolves.toEqual([]);
		expect(get).not.toHaveBeenCalled();
	});

	it("索引未就緒或請求失敗時退回站台即時搜尋", async () => {
		get.mockResolvedValue({ data: [post(9, "備援 [免費空間]", "")] });

		searchHgamefreeIndex.mockResolvedValueOnce(null);
		expect(await searchHgamefree("備援")).toHaveLength(1);

		searchHgamefreeIndex.mockRejectedValueOnce(new Error("down"));
		expect(await searchHgamefree("備援")).toHaveLength(1);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it("依 ID 取文章先查索引，查不到才打站台", async () => {
		getHgamefreeIndexPost.mockResolvedValueOnce([indexItem]);
		const draft = await fetchHgamefreeById("680535");
		expect(draft.sources[0].external_id).toBe("680535");
		expect(get).not.toHaveBeenCalled();

		getHgamefreeIndexPost.mockResolvedValueOnce([]);
		get.mockResolvedValueOnce({
			data: post(680535, "與你流落荒島 [免費空間]", ""),
		});
		await fetchHgamefreeById("680535");
		expect(get).toHaveBeenCalledTimes(1);
	});
});
