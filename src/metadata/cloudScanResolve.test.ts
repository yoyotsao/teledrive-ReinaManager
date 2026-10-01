import { describe, expect, it, vi } from "vitest";
import { ApiRateLimitError } from "@/utils/errors";
import {
	type CloudScanDeps,
	cleanScanQuery,
	resolveCloudScanName,
} from "./cloudScanResolve";
import type { SourceCandidate } from "./sourceCandidate";

function candidate(
	source: "vndb" | "bgm" | "hgamefree" | "steam",
	externalId: string,
	name: string,
	extra: Partial<SourceCandidate["display"]> = {},
): SourceCandidate {
	return {
		source,
		externalId,
		data: {},
		display: { name, ...extra },
	};
}

function deps(overrides: Partial<CloudScanDeps> = {}): CloudScanDeps {
	return {
		searchByName: vi.fn(async () => []),
		getGameById: vi.fn(
			async (id: string, source: string) =>
				({
					id_type: source,
					sources: [{ source, external_id: id, data: {} }],
				}) as never,
		),
		getDlsiteWorkType: vi.fn(async () => undefined),
		findVndbIdBySteamAppId: vi.fn(async () => null),
		...overrides,
	};
}

describe("resolveCloudScanName", () => {
	it("完全相同才自動套用，並抓完整資料", async () => {
		const d = deps({
			searchByName: vi.fn(async ({ source }) =>
				source === "vndb"
					? [candidate("vndb", "v1", "To Be or Not To Be")]
					: [],
			),
		});
		const outcome = await resolveCloudScanName("To Be or Not to Be", d, [
			"vndb",
			"bgm",
		]);
		expect(outcome.kind).toBe("accepted");
		expect(d.getGameById).toHaveBeenCalledWith("v1", "vndb");
	});

	it("h / RANZE / Hypnosis App 2 都不會自動套用，只列為備選", async () => {
		for (const [query, title] of [
			["h", "H+"],
			["RANZE", "RAYZE"],
			["Hypnosis App 2", "Hypnosis"],
		] as const) {
			const d = deps({
				searchByName: vi.fn(async () => [candidate("vndb", "vX", title)]),
			});
			const outcome = await resolveCloudScanName(query, d, ["vndb"]);
			expect(outcome.kind, query).toBe("needs_confirmation");
			expect(d.getGameById).not.toHaveBeenCalled();
		}
	});

	it("名稱差異大時，每個來源最多列出前 2 筆搜尋結果供選擇", async () => {
		const d = deps({
			searchByName: vi.fn(async ({ source }) => [
				candidate(source as "vndb" | "bgm", `${source}1`, "Foo"),
				candidate(source as "vndb" | "bgm", `${source}2`, "Bar"),
				candidate(source as "vndb" | "bgm", `${source}3`, "Baz"),
			]),
		});
		const outcome = await resolveCloudScanName("[社團] 完全不同 v1.0 汉化", d, [
			"vndb",
			"bgm",
		]);
		expect(outcome.kind).toBe("needs_confirmation");
		if (outcome.kind === "needs_confirmation") {
			expect(outcome.candidates.map((c) => c.externalId)).toEqual([
				"vndb1",
				"vndb2",
				"bgm1",
				"bgm2",
			]);
		}
		expect(d.getGameById).not.toHaveBeenCalled();
	});

	it("有嚴格候選時不混入備選", async () => {
		const d = deps({
			searchByName: vi.fn(async () => [
				candidate("bgm", "b9", "Amaoto ni Michiru Yoru EX"),
				candidate("bgm", "b10", "Unrelated"),
			]),
		});
		const outcome = await resolveCloudScanName("Amaoto ni Michiru Yoru", d, [
			"bgm",
		]);
		expect(outcome.kind).toBe("needs_confirmation");
		if (outcome.kind === "needs_confirmation") {
			expect(outcome.candidates.map((c) => c.externalId)).toEqual(["b9"]);
		}
	});

	it("包含關係只列為待確認，不抓完整資料", async () => {
		const d = deps({
			searchByName: vi.fn(async () => [
				candidate("bgm", "b9", "Amaoto ni Michiru Yoru EX", {
					image: "https://lain.bgm.tv/x.jpg",
				}),
			]),
		});
		const outcome = await resolveCloudScanName("Amaoto ni Michiru Yoru", d, [
			"bgm",
		]);
		expect(outcome).toEqual({
			kind: "needs_confirmation",
			candidates: [
				{
					source: "bgm",
					externalId: "b9",
					name: "Amaoto ni Michiru Yoru EX",
					image: "https://lain.bgm.tv/x.jpg",
				},
			],
		});
		expect(d.getGameById).not.toHaveBeenCalled();
	});

	it("音聲作品拒絕採用 RJ ID", async () => {
		const d = deps({
			getDlsiteWorkType: vi.fn(async () => "SOU"),
		});
		const outcome = await resolveCloudScanName("01000250", d, ["vndb"]);
		expect(outcome).toEqual({
			kind: "not_found",
			reason: "dlsite_not_game",
		});
		expect(d.getGameById).not.toHaveBeenCalled();
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("RJ 號碼是遊戲類作品時直接採用 DLsite", async () => {
		const d = deps({
			getDlsiteWorkType: vi.fn(async () => "SLN"),
		});
		const outcome = await resolveCloudScanName("RJ01276936", d, ["vndb"]);
		expect(outcome.kind).toBe("accepted");
		expect(d.getDlsiteWorkType).toHaveBeenCalledWith("RJ01276936");
		expect(d.getGameById).toHaveBeenCalledWith("RJ01276936", "dlsite");
	});

	it("7 位數字視為 Steam App ID，經 VNDB 反查", async () => {
		const d = deps({
			findVndbIdBySteamAppId: vi.fn(async () => "v42"),
		});
		const outcome = await resolveCloudScanName("1742470", d, ["vndb"]);
		expect(outcome.kind).toBe("accepted");
		expect(d.findVndbIdBySteamAppId).toHaveBeenCalledWith(1742470);
		expect(d.getGameById).toHaveBeenCalledWith("v42", "vndb");
	});

	it("6 位數字先試 DLsite，查無資料再試 Steam", async () => {
		const d = deps({
			getDlsiteWorkType: vi.fn(async () => undefined),
			findVndbIdBySteamAppId: vi.fn(async () => null),
		});
		const outcome = await resolveCloudScanName("331694", d, ["vndb"]);
		expect(d.getDlsiteWorkType).toHaveBeenCalledWith("RJ331694");
		expect(d.findVndbIdBySteamAppId).toHaveBeenCalledWith(331694);
		expect(outcome).toEqual({ kind: "not_found", reason: "no_match" });
	});

	it("單一來源失敗不影響其他來源", async () => {
		const d = deps({
			searchByName: vi.fn(async ({ source }) => {
				if (source === "vndb") throw new Error("down");
				return [candidate("bgm", "b1", "昨日の魔女は今日の夢")];
			}),
		});
		const outcome = await resolveCloudScanName("昨日の魔女は今日の夢", d, [
			"vndb",
			"bgm",
		]);
		expect(outcome.kind).toBe("accepted");
	});

	it("所有來源都失敗時回 failed", async () => {
		const d = deps({
			searchByName: vi.fn(async () => {
				throw new Error("network down");
			}),
		});
		const outcome = await resolveCloudScanName("昨日の魔女は今日の夢", d, [
			"vndb",
			"bgm",
		]);
		expect(outcome.kind).toBe("failed");
	});

	it("部分來源失敗但另一來源有候選：仍回待確認", async () => {
		const d = deps({
			searchByName: vi.fn(async ({ source }) => {
				if (source === "vndb") throw new Error("down");
				return [candidate("bgm", "b1", "昨日の魔女は今日の夢X")];
			}),
		});
		const outcome = await resolveCloudScanName("昨日の魔女は今日の夢", d, [
			"vndb",
			"bgm",
		]);
		expect(outcome.kind).toBe("needs_confirmation");
	});

	it("DLsite 查詢失敗時回 failed，不改用名稱搜尋亂猜", async () => {
		const d = deps({
			getDlsiteWorkType: vi.fn(async () => {
				throw new Error("timeout");
			}),
		});
		const outcome = await resolveCloudScanName("01000250", d, ["vndb"]);
		expect(outcome.kind).toBe("failed");
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("Steam 反查失敗時回 failed", async () => {
		const d = deps({
			findVndbIdBySteamAppId: vi.fn(async () => {
				throw new Error("502");
			}),
		});
		const outcome = await resolveCloudScanName("1742470", d, ["vndb"]);
		expect(outcome.kind).toBe("failed");
	});

	it("自動套用時抓完整資料失敗回 failed", async () => {
		const d = deps({
			searchByName: vi.fn(async () => [
				candidate("vndb", "v1", "To Be or Not To Be"),
			]),
			getGameById: vi.fn(async () => {
				throw new Error("500");
			}),
		});
		const outcome = await resolveCloudScanName("To Be or Not to Be", d, [
			"vndb",
		]);
		expect(outcome.kind).toBe("failed");
	});

	it("限流錯誤往外拋，讓整個掃描停下來", async () => {
		const limited = new ApiRateLimitError({
			source: "vndb",
			message: "429",
		});
		const d = deps({
			searchByName: vi.fn(async () => {
				throw limited;
			}),
		});
		await expect(
			resolveCloudScanName("昨日の魔女は今日の夢", d, ["vndb", "bgm"]),
		).rejects.toBe(limited);
	});

	describe("命中下載站文章後補其他來源的資料", () => {
		function hgamefreeDeps(vndbResults: SourceCandidate[]) {
			return deps({
				searchByName: vi.fn(async ({ source }) => {
					if (source === "hgamefree") {
						return [
							candidate("hgamefree", "h1", "黄昏少女", {
								aliases: ["Twilight Girl"],
							}),
						];
					}
					return source === "vndb" ? vndbResults : [];
				}),
				getGameById: vi.fn(
					async (id: string, source: string) =>
						({
							id_type: source,
							sources: [{ source, external_id: id, data: { name: id } }],
						}) as never,
				),
			});
		}

		it("用檔名命中後，以標題在其他來源找到精確符合就合併", async () => {
			const d = hgamefreeDeps([candidate("vndb", "v7", "黄昏少女")]);

			const outcome = await resolveCloudScanName("Twilight Girl", d, [
				"hgamefree",
				"vndb",
				"bgm",
			]);

			expect(outcome.kind).toBe("accepted");
			if (outcome.kind !== "accepted") return;
			// 完整資料的來源當主要來源，下載站記錄一併保留
			expect(outcome.draft.id_type).toBe("vndb");
			expect(outcome.draft.sources.map((s) => s.source).sort()).toEqual([
				"hgamefree",
				"vndb",
			]);
			expect(d.searchByName).toHaveBeenCalledWith(
				expect.objectContaining({ query: "黄昏少女", source: "vndb" }),
			);
		});

		it("其他來源沒有精確符合時只用下載站資料，不降級成待確認", async () => {
			const d = hgamefreeDeps([candidate("vndb", "v8", "黄昏少女 完全版")]);

			const outcome = await resolveCloudScanName("Twilight Girl", d, [
				"hgamefree",
				"vndb",
			]);

			expect(outcome.kind).toBe("accepted");
			if (outcome.kind !== "accepted") return;
			expect(outcome.draft.id_type).toBe("hgamefree");
			expect(d.getGameById).toHaveBeenCalledTimes(1);
		});

		it("補資料時其他來源出錯不影響命中，限流則往外拋", async () => {
			const failing = deps({
				searchByName: vi.fn(async ({ source }) => {
					if (source === "hgamefree") {
						return [candidate("hgamefree", "h1", "Twilight Girl")];
					}
					throw new Error("down");
				}),
			});
			const outcome = await resolveCloudScanName("Twilight Girl", failing, [
				"hgamefree",
				"vndb",
			]);
			expect(outcome.kind).toBe("accepted");

			const limited = new ApiRateLimitError({ source: "vndb", message: "429" });
			const rateLimited = deps({
				searchByName: vi.fn(async ({ source }) => {
					if (source === "hgamefree") {
						return [candidate("hgamefree", "h1", "Twilight Girl")];
					}
					throw limited;
				}),
			});
			await expect(
				resolveCloudScanName("Twilight Girl", rateLimited, [
					"hgamefree",
					"vndb",
				]),
			).rejects.toBe(limited);
		});
	});

	describe("數字編號與 Steam 名稱", () => {
		/** 假的下載站文章草稿，帶外部 ID。 */
		function post(externalIds: string[]) {
			return {
				id_type: "hgamefree",
				sources: [
					{
						source: "hgamefree",
						external_id: "440531",
						data: {
							name: "不知何故獨來獨往的瑪蒂達小姐",
							file_url: ["https://mega.nz/file/x#k"],
							external_ids: externalIds,
						},
					},
				],
			} as never;
		}

		function richDeps(overrides: Partial<CloudScanDeps> = {}) {
			return deps({
				getGameById: vi.fn(
					async (id: string, source: string) =>
						({
							id_type: source,
							sources: [{ source, external_id: id, data: { name: id } }],
						}) as never,
				),
				...overrides,
			});
		}

		it("Getchu 編號查下載站索引命中，並依文章的 Steam ID 補資料", async () => {
			const d = richDeps({
				findHgamefreeByExternalId: vi.fn(async (id: string) =>
					id === "getchu:1065742" ? post(["steam:3329430"]) : null,
				),
			});

			const outcome = await resolveCloudScanName("1065742", d, [
				"hgamefree",
				"steam",
			]);

			expect(outcome.kind).toBe("accepted");
			if (outcome.kind !== "accepted") return;
			expect(d.getGameById).toHaveBeenCalledWith("3329430", "steam");
			// Steam 的完整資料當主要來源，下載站文章（含下載連結）保留
			expect(outcome.draft.id_type).toBe("steam");
			expect(outcome.draft.sources.map((s) => s.source).sort()).toEqual([
				"hgamefree",
				"steam",
			]);
			// 依序嘗試 getchu、steam，第一個命中就停
			expect(d.findHgamefreeByExternalId).toHaveBeenCalledTimes(1);
			expect(d.findVndbIdBySteamAppId).not.toHaveBeenCalled();
		});

		it("Steam App ID 在索引找不到時，退回 VNDB 反查", async () => {
			const d = richDeps({
				findHgamefreeByExternalId: vi.fn(async () => null),
				findVndbIdBySteamAppId: vi.fn(async () => "v42"),
			});

			const outcome = await resolveCloudScanName("1742470", d, ["hgamefree"]);

			expect(outcome.kind).toBe("accepted");
			expect(d.findHgamefreeByExternalId).toHaveBeenCalledWith(
				"getchu:1742470",
			);
			expect(d.findHgamefreeByExternalId).toHaveBeenCalledWith("steam:1742470");
			expect(d.getGameById).toHaveBeenCalledWith("v42", "vndb");
		});

		it("RJ 號碼查不到 DLsite 作品時改查索引", async () => {
			const d = richDeps({
				getDlsiteWorkType: vi.fn(async () => undefined),
				findHgamefreeByExternalId: vi.fn(async (id: string) =>
					id === "dlsite:RJ01464205" ? post(["dlsite:RJ01464205"]) : null,
				),
			});

			const outcome = await resolveCloudScanName("RJ01464205", d, [
				"hgamefree",
			]);

			expect(outcome.kind).toBe("accepted");
			expect(d.getGameById).toHaveBeenCalledWith("RJ01464205", "dlsite");
		});

		it("Steam 英文名去掉版本號後精確命中，並附上下載站文章", async () => {
			const d = richDeps({
				searchByName: vi.fn(async ({ source }) =>
					source === "steam"
						? [candidate("steam", "3329430", "Adventuring With Matilda!")]
						: [],
				),
				findHgamefreeByExternalId: vi.fn(async (id: string) =>
					id === "steam:3329430" ? post(["steam:3329430"]) : null,
				),
			});

			const outcome = await resolveCloudScanName(
				"Adventuring With Matilda! v1.0.9",
				d,
				["hgamefree", "steam"],
			);

			expect(outcome.kind).toBe("accepted");
			if (outcome.kind !== "accepted") return;
			expect(d.searchByName).toHaveBeenCalledWith(
				expect.objectContaining({
					source: "steam",
					query: "Adventuring With Matilda!",
				}),
			);
			expect(outcome.draft.id_type).toBe("steam");
			expect(outcome.draft.sources.map((s) => s.source).sort()).toEqual([
				"hgamefree",
				"steam",
			]);
		});

		it("Steam 命中但下載站沒有這款時只用 Steam 資料", async () => {
			const d = richDeps({
				searchByName: vi.fn(async ({ source }) =>
					source === "steam" ? [candidate("steam", "1", "Some Game")] : [],
				),
				findHgamefreeByExternalId: vi.fn(async () => null),
			});

			const outcome = await resolveCloudScanName("Some Game v2.0", d, [
				"steam",
			]);

			expect(outcome.kind).toBe("accepted");
			if (outcome.kind !== "accepted") return;
			expect(outcome.draft.sources.map((s) => s.source)).toEqual(["steam"]);
		});

		it("補資料時 Steam 出錯不影響命中；下載站索引出錯也不會讓掃描失敗", async () => {
			const d = richDeps({
				getGameById: vi.fn(async (_id: string, source: string) => {
					if (source === "steam") throw new Error("region locked");
					return { id_type: source, sources: [] } as never;
				}),
				findHgamefreeByExternalId: vi.fn(async (id: string) => {
					if (id === "getchu:1065742") return post(["steam:3329430"]);
					throw new Error("index down");
				}),
			});

			const outcome = await resolveCloudScanName("1065742", d, ["hgamefree"]);

			expect(outcome.kind).toBe("accepted");
			if (outcome.kind !== "accepted") return;
			expect(outcome.draft.id_type).toBe("hgamefree");

			const broken = richDeps({
				findHgamefreeByExternalId: vi.fn(async () => {
					throw new Error("index down");
				}),
			});
			await expect(
				resolveCloudScanName("9999999", broken, ["hgamefree"]),
			).resolves.toEqual({ kind: "not_found", reason: "no_match" });
		});

		it("下載站文章有 DLsite 連結時用 DLsite 補資料", async () => {
			const d = richDeps({
				searchByName: vi.fn(async ({ source }) =>
					source === "hgamefree"
						? [
								{
									...candidate("hgamefree", "h9", "某遊戲"),
									display: { name: "某遊戲", aliases: ["Some Archive"] },
								},
							]
						: [],
				),
				findHgamefreeByExternalId: undefined,
			});
			// 讓 getGameById 對 hgamefree 回帶 DLsite ID 的文章
			(d.getGameById as ReturnType<typeof vi.fn>).mockImplementation(
				async (id: string, source: string) =>
					source === "hgamefree"
						? post(["dlsite:RJ01464205"])
						: ({
								id_type: source,
								sources: [{ source, external_id: id, data: {} }],
							} as never),
			);

			const outcome = await resolveCloudScanName("Some Archive", d, [
				"hgamefree",
			]);

			expect(outcome.kind).toBe("accepted");
			if (outcome.kind !== "accepted") return;
			expect(d.getGameById).toHaveBeenCalledWith("RJ01464205", "dlsite");
			expect(outcome.draft.id_type).toBe("dlsite");
		});
	});

	describe("cleanScanQuery", () => {
		it.each([
			["Adventuring With Matilda! v1.0.9", "Adventuring With Matilda!"],
			["Game_Ver1.2", "Game"],
			["Some Game v2.0 [Final]", "Some Game"],
			["Hypnosis App 2", "Hypnosis App 2"],
			["ThornSin 0.75", "ThornSin 0.75"],
			["v1.0", "v1.0"],
		])("%s → %s", (raw, expected) => {
			expect(cleanScanQuery(raw)).toBe(expected);
		});
	});
});
