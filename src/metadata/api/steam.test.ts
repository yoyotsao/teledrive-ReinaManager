import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./http", () => ({ default: { get } }));
vi.mock("i18next", () => ({ default: { language: "zh-TW" } }));

import { steamAdapter } from "../adapters/steamAdapter";
import {
	fetchSteamById,
	normalizeSteamId,
	parseSteamDate,
	searchSteam,
	steamHtmlToText,
} from "./steam";

describe("parseSteamDate", () => {
	it.each([
		["2025 年 2 月 21 日", "2025-02-21"],
		["2025年2月1日", "2025-02-01"],
		["Feb 21, 2025", "2025-02-21"],
		["21 Feb, 2025", "2025-02-21"],
		["Sept 3, 2024", "2024-09-03"],
		["即將推出", undefined],
		["", undefined],
		[undefined, undefined],
	])("%s → %s", (raw, expected) => {
		expect(parseSteamDate(raw)).toBe(expected);
	});
});

describe("steamHtmlToText", () => {
	it("保留段落換行並移除標籤與圖片", () => {
		const html =
			'<h2 class="bb_tag">簡介</h2>第一段<br>第二段<img src="x.gif"><p>第三段</p><ul><li>甲</li><li>乙</li></ul>';
		expect(steamHtmlToText(html)).toBe("簡介\n第一段\n第二段第三段\n甲\n乙");
	});

	it("沒有文字時回 undefined", () => {
		expect(steamHtmlToText('<img src="x.gif">')).toBeUndefined();
		expect(steamHtmlToText(undefined)).toBeUndefined();
	});
});

describe("normalizeSteamId", () => {
	it("接受數字與商店網址", () => {
		expect(normalizeSteamId("3329430")).toBe("3329430");
		expect(
			normalizeSteamId(
				"https://store.steampowered.com/app/3329430/Adventuring_With_Matilda/?l=tchinese",
			),
		).toBe("3329430");
		expect(normalizeSteamId("abc")).toBeUndefined();
	});
});

describe("Steam API", () => {
	beforeEach(() => {
		get.mockReset();
	});

	it("搜尋用英文，只回 app 類型並帶縮圖", async () => {
		get.mockResolvedValue({
			data: {
				items: [
					{
						id: 3329430,
						name: "Adventuring With Matilda!",
						type: "app",
						tiny_image: "https://shared.akamai.steamstatic.com/t.jpg",
					},
					{ id: 1, name: "某個 bundle", type: "sub" },
				],
			},
		});

		const candidates = await steamAdapter.searchByName(
			"Adventuring With Matilda!",
			{ spoilerLevel: 0, limit: 5 },
		);

		expect(get).toHaveBeenCalledWith(
			"https://store.steampowered.com/api/storesearch/",
			expect.objectContaining({
				params: expect.objectContaining({
					term: "Adventuring With Matilda!",
					l: "english",
				}),
				rateLimit: { source: "steam" },
			}),
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			source: "steam",
			externalId: "3329430",
			display: {
				name: "Adventuring With Matilda!",
				image: "https://shared.akamai.steamstatic.com/t.jpg",
			},
		});
	});

	it("依 ID 取詳細資料：描述、標籤、開發商、發售日、封面", async () => {
		get.mockResolvedValue({
			data: {
				"3329430": {
					success: true,
					data: {
						type: "game",
						name: "Adventuring With Matilda!",
						about_the_game: "<p>下地城冒險</p>",
						short_description: "短描述",
						header_image: "https://shared.akamai.steamstatic.com/h.jpg",
						developers: ["INU ORANGE"],
						genres: [{ description: "休閒" }, { description: "角色扮演" }],
						release_date: { coming_soon: false, date: "2025 年 2 月 21 日" },
						required_age: 0,
						content_descriptors: { ids: [] },
					},
				},
			},
		});

		const draft = await fetchSteamById("3329430");

		expect(get.mock.calls[0][1].params).toMatchObject({
			appids: "3329430",
			l: "tchinese",
		});
		expect(draft.id_type).toBe("steam");
		expect(draft.sources[0]).toMatchObject({
			source: "steam",
			external_id: "3329430",
			data: {
				name: "Adventuring With Matilda!",
				summary: "下地城冒險",
				tags: ["休閒", "角色扮演"],
				developer: "INU ORANGE",
				date: "2025-02-21",
				image: "https://shared.akamai.steamstatic.com/h.jpg",
			},
		});
	});

	it("成人內容描述或年齡限制會標記 nsfw", async () => {
		const entry = (extra: object) => ({
			data: {
				"1": { success: true, data: { type: "game", name: "X", ...extra } },
			},
		});
		get.mockResolvedValueOnce(entry({ content_descriptors: { ids: [3] } }));
		expect((await fetchSteamById("1")).sources[0].data).toMatchObject({
			nsfw: true,
		});

		get.mockResolvedValueOnce(entry({ required_age: "18" }));
		expect((await fetchSteamById("1")).sources[0].data).toMatchObject({
			nsfw: true,
		});
	});

	it("查無資料、非遊戲本體、ID 無效都丟錯", async () => {
		get.mockResolvedValueOnce({ data: { "1": { success: false } } });
		await expect(fetchSteamById("1")).rejects.toMatchObject({
			code: "metadata_not_found",
		});

		get.mockResolvedValueOnce({
			data: { "2": { success: true, data: { type: "music", name: "OST" } } },
		});
		await expect(fetchSteamById("2")).rejects.toMatchObject({
			code: "metadata_not_found",
		});

		await expect(fetchSteamById("abc")).rejects.toMatchObject({
			code: "invalid_game_id",
		});
	});

	it("空關鍵字不發請求", async () => {
		await expect(searchSteam("  ")).resolves.toEqual([]);
		expect(get).not.toHaveBeenCalled();
	});
});
