import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRateLimitError, HttpResponseError } from "@/utils/errors";

const { get, getText } = vi.hoisted(() => ({
	get: vi.fn(),
	getText: vi.fn(),
}));
vi.mock("./http", () => ({ default: { get, getText } }));
vi.mock("@/providers/i18n", () => ({
	default: { language: "ja-JP" },
}));

import { fetchDlsiteWorkType } from "./dlsite";

describe("fetchDlsiteWorkType", () => {
	beforeEach(() => {
		get.mockReset();
		getText.mockReset();
	});

	it("資訊 API 有作品時回傳 work_type，而且不讀作品頁", async () => {
		get.mockResolvedValue({
			data: { RJ01000250: { work_type: "SOU" } },
		});
		await expect(fetchDlsiteWorkType("RJ01000250")).resolves.toBe("SOU");
		expect(get).toHaveBeenCalledWith(
			"https://www.dlsite.com/maniax/product/info/ajax",
			expect.objectContaining({
				params: expect.objectContaining({
					product_id: "RJ01000250",
				}),
			}),
		);
		expect(getText).not.toHaveBeenCalled();
	});

	it("作品存在但沒有 work_type 時保守回 UNKNOWN", async () => {
		get.mockResolvedValue({ data: { RJ01276936: {} } });
		await expect(fetchDlsiteWorkType("RJ01276936")).resolves.toBe("UNKNOWN");
	});

	it("資訊 API 回空時回 undefined", async () => {
		get.mockResolvedValue({ data: [] });
		await expect(fetchDlsiteWorkType("RJ99999999")).resolves.toBeUndefined();
	});

	it("資訊 API 網路失敗時往外拋", async () => {
		const network = new TypeError("Failed to fetch");
		get.mockRejectedValue(network);
		await expect(fetchDlsiteWorkType("RJ01000250")).rejects.toBe(network);
	});

	it("資訊 API 被限流時往外拋", async () => {
		const limited = new ApiRateLimitError({
			source: "dlsite",
			message: "429",
		});
		get.mockRejectedValue(limited);
		await expect(fetchDlsiteWorkType("RJ01000250")).rejects.toBe(limited);
	});

	it("資訊 API 回 5xx 時往外拋", async () => {
		const http503 = new HttpResponseError({
			method: "GET",
			status: 503,
			statusText: "Service Unavailable",
			url: "https://www.dlsite.com/maniax/product/info/ajax",
		});
		get.mockRejectedValue(http503);
		await expect(fetchDlsiteWorkType("RJ01000250")).rejects.toBe(http503);
	});

	it("不合法的 ID 丟 invalid_game_id", async () => {
		await expect(fetchDlsiteWorkType("not-an-id")).rejects.toMatchObject({
			code: "invalid_game_id",
		});
		expect(get).not.toHaveBeenCalled();
	});
});
