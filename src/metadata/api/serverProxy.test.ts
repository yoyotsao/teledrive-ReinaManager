import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRateLimitError, HttpResponseError } from "@/utils/errors";

const { authenticatedFetch } = vi.hoisted(() => ({
	authenticatedFetch: vi.fn(),
}));
vi.mock("@/services/web/http", () => ({ authenticatedFetch }));

import { requestViaServerProxy } from "./serverProxy";

function proxyReply(
	status: number,
	body: string,
	headers: [string, string][] = [],
) {
	return new Response(JSON.stringify({ status, headers, body }), {
		status: 200,
	});
}

describe("requestViaServerProxy", () => {
	beforeEach(() => authenticatedFetch.mockReset());

	it("把請求原樣交給伺服器並解析 JSON", async () => {
		authenticatedFetch.mockResolvedValue(proxyReply(200, '{"results":[1]}'));
		const result = await requestViaServerProxy<{ results: number[] }>(
			"POST",
			"https://api.vndb.org/kana/vn",
			{ headers: { Accept: "application/json" } },
			{ filters: [] },
			"vndb",
		);

		expect(result.data).toEqual({ results: [1] });
		const [url, init] = authenticatedFetch.mock.calls[0];
		expect(url).toBe("/game/api/metadata/request");
		expect(JSON.parse(init.body)).toEqual({
			source: "vndb",
			method: "POST",
			url: "https://api.vndb.org/kana/vn",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: '{"filters":[]}',
		});
	});

	it("responseType text 回傳原文", async () => {
		authenticatedFetch.mockResolvedValue(proxyReply(200, "<html>x</html>"));
		const result = await requestViaServerProxy<string>(
			"GET",
			"https://www.dlsite.com/maniax/work/=/product_id/RJ1.html",
			{ responseType: "text" },
			undefined,
			"dlsite",
		);
		expect(result.data).toBe("<html>x</html>");
	});

	it("上游 429 轉成 ApiRateLimitError", async () => {
		authenticatedFetch.mockResolvedValue(
			proxyReply(429, "", [["retry-after", "10"]]),
		);
		const bgm = requestViaServerProxy(
			"GET",
			"https://api.bgm.tv/v0/x",
			{},
			undefined,
			"bgm",
		);
		await expect(bgm).rejects.toBeInstanceOf(ApiRateLimitError);
		await expect(bgm).rejects.toMatchObject({
			fatal: true,
			retryAfterMs: 10_000,
		});

		authenticatedFetch.mockResolvedValue(proxyReply(429, ""));
		await expect(
			requestViaServerProxy(
				"POST",
				"https://api.vndb.org/kana/vn",
				{},
				{},
				"vndb",
			),
		).rejects.toMatchObject({ fatal: false });
	});

	it("上游其他錯誤與代理本身錯誤都會丟出", async () => {
		authenticatedFetch.mockResolvedValue(proxyReply(404, "nope"));
		await expect(
			requestViaServerProxy(
				"GET",
				"https://api.bgm.tv/v0/x",
				{},
				undefined,
				"bgm",
			),
		).rejects.toBeInstanceOf(HttpResponseError);

		authenticatedFetch.mockResolvedValue(
			new Response('{"code":"upstream_forbidden"}', { status: 403 }),
		);
		await expect(
			requestViaServerProxy(
				"GET",
				"https://api.bgm.tv/v0/x",
				{},
				undefined,
				"bgm",
			),
		).rejects.toThrow(/403/);
	});
});
