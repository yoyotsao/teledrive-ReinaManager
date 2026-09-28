import { describe, expect, it, vi } from "vitest";
import { ApiRateLimitError } from "@/utils/errors";
import { type CloudScanDeps, resolveCloudScanName } from "./cloudScanResolve";
import type { SourceCandidate } from "./sourceCandidate";

function candidate(
	source: "vndb" | "bgm",
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

	it("h / RANZE / Hypnosis App 2 都不會自動套用", async () => {
		for (const [query, title] of [
			["h", "H+"],
			["RANZE", "RAYZE"],
			["Hypnosis App 2", "Hypnosis"],
		] as const) {
			const d = deps({
				searchByName: vi.fn(async () => [candidate("vndb", "vX", title)]),
			});
			const outcome = await resolveCloudScanName(query, d, ["vndb"]);
			expect(outcome.kind, query).toBe("not_found");
			expect(d.getGameById).not.toHaveBeenCalled();
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
});
