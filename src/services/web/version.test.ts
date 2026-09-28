import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchServerVersion } from "./version";

const authenticatedFetchMock =
	vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
vi.mock("./http", () => ({
	authenticatedFetch: (input: string, init?: RequestInit) =>
		authenticatedFetchMock(input, init),
}));

beforeEach(() => {
	authenticatedFetchMock.mockReset();
});

describe("fetchServerVersion", () => {
	it("以 no-store GET /game/api/version 并回传 data_version", async () => {
		authenticatedFetchMock.mockResolvedValue(
			Response.json({ data_version: 42 }),
		);
		await expect(fetchServerVersion()).resolves.toBe(42);
		const [url, init] = authenticatedFetchMock.mock.calls[0];
		expect(url).toBe("/game/api/version");
		expect(init?.method).toBe("GET");
		expect(init?.cache).toBe("no-store");
	});

	it("回应不是整数版本时丢 http_response_parse_failed", async () => {
		authenticatedFetchMock.mockResolvedValue(
			Response.json({ data_version: "42" }),
		);
		await expect(fetchServerVersion()).rejects.toMatchObject({
			code: "http_response_parse_failed",
		});
	});

	it("非 2xx 时丢 server_rpc_failed", async () => {
		authenticatedFetchMock.mockResolvedValue(
			new Response(null, { status: 500 }),
		);
		await expect(fetchServerVersion()).rejects.toMatchObject({
			code: "server_rpc_failed",
		});
	});
});
