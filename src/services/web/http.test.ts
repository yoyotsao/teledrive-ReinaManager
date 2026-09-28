import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/utils/errors";
import { AUTH_REQUIRED_EVENT, NotLoggedInError } from "./auth";
import { authenticatedFetch, serverRpc } from "./http";

const readJwt = vi.fn<() => Promise<string | null>>();
const refreshJwt = vi.fn<(stale: string) => Promise<string>>();

vi.mock("./auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./auth")>();
	return {
		...actual,
		readTeleDriveJwt: () => readJwt(),
		refreshTeleDriveJwt: (stale: string) => refreshJwt(stale),
	};
});

const fetchMock = vi.fn<typeof fetch>();

function authOf(callIndex: number): string | null {
	return new Headers(fetchMock.mock.calls[callIndex][1]?.headers).get(
		"Authorization",
	);
}

beforeEach(() => {
	readJwt.mockReset().mockResolvedValue("jwt-1");
	refreshJwt.mockReset().mockResolvedValue("jwt-2");
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

describe("authenticatedFetch", () => {
	it("对 /game/api 附上 Bearer", async () => {
		fetchMock.mockResolvedValue(Response.json(1));
		await authenticatedFetch("/game/api/version");
		expect(authOf(0)).toBe("Bearer jwt-1");
	});

	it("对本机 bridge 的 /rpc/game/ 附上 Bearer", async () => {
		fetchMock.mockResolvedValue(Response.json({ games: [] }));
		await authenticatedFetch("http://127.0.0.1:8081/rpc/game/state");
		expect(authOf(0)).toBe("Bearer jwt-1");
	});

	it("拒绝把 token 送往白名单以外的目的地", async () => {
		for (const url of [
			"https://api.bgm.tv/v0/me",
			"/api/v1/folders",
			"http://127.0.0.1:8081/rpc/fetch-local",
			"http://127.0.0.1:9999/rpc/game/state",
		]) {
			await expect(authenticatedFetch(url)).rejects.toMatchObject({
				code: "forbidden_destination",
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("401 时刷新一次后以新 token 重试", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(Response.json("ok"));
		const response = await authenticatedFetch("/game/api/version");
		expect(response.status).toBe(200);
		expect(refreshJwt).toHaveBeenCalledWith("jwt-1");
		expect(authOf(1)).toBe("Bearer jwt-2");
	});

	it("重试后仍 401：丢 NotLoggedInError 并发出 auth-required 事件", async () => {
		const listener = vi.fn();
		window.addEventListener(AUTH_REQUIRED_EVENT, listener);
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
		await expect(
			authenticatedFetch("/game/api/version"),
		).rejects.toBeInstanceOf(NotLoggedInError);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenCalledTimes(1);
		window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
	});

	it("403 不刷新、不重试", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
		const response = await authenticatedFetch("/game/api/version");
		expect(response.status).toBe(403);
		expect(refreshJwt).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("没有 jwt：不送请求，直接 NotLoggedInError", async () => {
		readJwt.mockResolvedValue(null);
		await expect(
			authenticatedFetch("/game/api/version"),
		).rejects.toBeInstanceOf(NotLoggedInError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("网络失败转为 network_offline", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		await expect(authenticatedFetch("/game/api/version")).rejects.toMatchObject(
			{
				code: "network_offline",
			},
		);
	});

	it("AbortSignal 中止时原样丢出 AbortError", async () => {
		const controller = new AbortController();
		controller.abort();
		fetchMock.mockRejectedValue(
			new DOMException("The operation was aborted.", "AbortError"),
		);
		await expect(
			authenticatedFetch("/game/api/version", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("serverRpc", () => {
	it("POST JSON 到 /game/api/rpc/<command> 并回传 JSON 值", async () => {
		fetchMock.mockResolvedValue(Response.json({ id: 7 }));
		await expect(
			serverRpc<{ id: number }>("find_game_by_id", { id: 7 }),
		).resolves.toEqual({ id: 7 });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("/game/api/rpc/find_game_by_id");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe(JSON.stringify({ id: 7 }));
		expect(new Headers(init?.headers).get("Content-Type")).toBe(
			"application/json",
		);
	});

	it("伺服器回传 null（Option::None）时回传 null", async () => {
		fetchMock.mockResolvedValue(Response.json(null));
		await expect(serverRpc("find_game_by_id", { id: 1 })).resolves.toBeNull();
	});

	it("错误回应 {code,message} 转为 AppError", async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{ code: "invalid_argument", message: "bad id" },
				{ status: 400 },
			),
		);
		const error = await serverRpc("find_game_by_id", { id: -1 }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(AppError);
		expect(error).toMatchObject({
			code: "invalid_argument",
			message: "bad id",
			context: { command: "find_game_by_id", status: 400 },
		});
	});

	it("403 一律转为 code=forbidden", async () => {
		fetchMock.mockResolvedValue(
			Response.json({ code: "x", message: "not owner" }, { status: 403 }),
		);
		await expect(serverRpc("find_all_games")).rejects.toMatchObject({
			code: "forbidden",
		});
	});

	it("非 JSON 错误体保留 HTTP 状态资讯", async () => {
		fetchMock.mockResolvedValue(
			new Response("<html>502</html>", { status: 502 }),
		);
		await expect(serverRpc("find_all_games")).rejects.toMatchObject({
			code: "server_rpc_failed",
			message: "HTTP 502: find_all_games",
		});
	});
});
