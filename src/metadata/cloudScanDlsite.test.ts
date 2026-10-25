import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRateLimitError } from "@/utils/errors";

const { get, getText } = vi.hoisted(() => ({
	get: vi.fn(),
	getText: vi.fn(),
}));
vi.mock("./api/http", () => ({ default: { get, getText } }));
vi.mock("@/providers/i18n", () => ({
	default: { language: "ja-JP" },
}));

import { fetchDlsiteWorkType } from "./api/dlsite";
import { type CloudScanDeps, resolveCloudScanName } from "./cloudScanResolve";

function deps(): CloudScanDeps {
	return {
		searchByName: vi.fn(async () => []),
		getGameById: vi.fn(
			async (id: string, source: string) =>
				({
					id_type: source,
					sources: [{ source, external_id: id, data: {} }],
				}) as never,
		),
		getDlsiteWorkType: (rjId) => fetchDlsiteWorkType(rjId),
		findVndbIdBySteamAppId: vi.fn(async () => null),
	};
}

describe("雲端掃描 × 真實 DLsite 作品類型查詢", () => {
	beforeEach(() => {
		get.mockReset();
		getText.mockReset();
	});

	it("資訊 API 網路失敗：解析結果是 failed，不做名稱搜尋", async () => {
		get.mockRejectedValue(new TypeError("Failed to fetch"));
		const d = deps();
		const outcome = await resolveCloudScanName("01000250", d, [
			"vndb",
			"bgm",
			"ymgal",
		]);
		expect(outcome.kind).toBe("failed");
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("資訊 API 被限流：往外拋並停止整次掃描", async () => {
		const limited = new ApiRateLimitError({
			source: "dlsite",
			message: "429",
		});
		get.mockRejectedValue(limited);
		const d = deps();
		await expect(resolveCloudScanName("01000250", d, ["vndb"])).rejects.toBe(
			limited,
		);
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("資訊 API 回音聲作品：dlsite_not_game", async () => {
		get.mockResolvedValue({
			data: { RJ01000250: { work_type: "SOU" } },
		});
		const outcome = await resolveCloudScanName("01000250", deps(), ["vndb"]);
		expect(outcome).toEqual({
			kind: "not_found",
			reason: "dlsite_not_game",
		});
	});

	it("確定查無此作品時，才繼續走 Steam 反查", async () => {
		get.mockResolvedValue({ data: [] });
		const d = deps();
		const outcome = await resolveCloudScanName("331694", d, ["vndb"]);
		expect(d.findVndbIdBySteamAppId).toHaveBeenCalledWith(331694);
		expect(outcome).toEqual({ kind: "not_found", reason: "no_match" });
	});
});
