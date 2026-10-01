import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/utils/errors";
import { bridgeService } from "./bridge";
import { authenticatedFetch } from "./http";

vi.mock("./http", () => ({
	authenticatedFetch: vi.fn(),
}));

const fetchMock = vi.mocked(authenticatedFetch);

beforeEach(() => fetchMock.mockReset());

describe("bridgeService", () => {
	it("以重複 paths query 讀取狀態並保留 capability", async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				games: [
					{
						path: "遊戲/A",
						status: "ready",
						completed_bytes: 10,
						total_bytes: 10,
						elapsed_seconds: 0,
						error: null,
						capabilities: { locale_emulator: true },
					},
				],
			}),
		);

		await expect(
			bridgeService.getStates(["遊戲/A", "game/B"]),
		).resolves.toMatchObject({
			games: [{ path: "遊戲/A", capabilities: { locale_emulator: true } }],
		});
		const [url, init] = fetchMock.mock.calls[0];
		const parsed = new URL(String(url));
		expect(parsed.origin).toBe("http://127.0.0.1:8081");
		expect(parsed.pathname).toBe("/rpc/game/state");
		expect(parsed.searchParams.getAll("paths")).toEqual(["遊戲/A", "game/B"]);
		expect(init).toBeUndefined();
	});

	it("fetch/cancel/exes/launch 使用鎖定的 RPC 格式", async () => {
		fetchMock
			.mockResolvedValueOnce(
				Response.json(
					{ path: "game/A", status: "downloading" },
					{ status: 202 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({ path: "game/A", status: "ready" }, { status: 202 }),
			)
			.mockResolvedValueOnce(Response.json({ exes: ["bin/game.exe"] }))
			.mockResolvedValueOnce(Response.json({ session_id: "session-1" }));

		await bridgeService.fetch("game/A");
		await bridgeService.cancel("game/A");
		await expect(bridgeService.getExes("game/A")).resolves.toEqual({
			exes: ["bin/game.exe"],
		});
		await expect(
			bridgeService.launch({
				path: "game/A",
				exe_relpath: "bin/game.exe",
				game_id: 7,
				locale_emulator: true,
			}),
		).resolves.toEqual({ session_id: "session-1" });

		expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
			"POST",
			"DELETE",
			undefined,
			"POST",
		]);
		expect(String(fetchMock.mock.calls[2][0])).toContain(
			"/rpc/game/exes?path=game%2FA",
		);
		expect(fetchMock.mock.calls[0][1]?.body).toBe(
			JSON.stringify({ path: "game/A" }),
		);
		expect(fetchMock.mock.calls[3][1]?.body).toBe(
			JSON.stringify({
				path: "game/A",
				exe_relpath: "bin/game.exe",
				game_id: 7,
				locale_emulator: true,
			}),
		);
	});

	it("launch 409 保留可供重選 exe 的 bridge 錯誤碼", async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{ code: "bridge_exe_invalid", error: "executable changed" },
				{ status: 409 },
			),
		);

		await expect(
			bridgeService.launch({
				path: "game/A",
				exe_relpath: "bin/old.exe",
				game_id: 7,
				locale_emulator: false,
			}),
		).rejects.toMatchObject({ code: "bridge_exe_invalid" });
	});

	it("403 轉成可辨識的 bridge 權限錯誤，網路/CORS 失敗轉成 bridge unavailable", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ code: "forbidden", error: "not allowed" },
				{ status: 403 },
			),
		);
		await expect(bridgeService.getStates(["game/A"])).rejects.toMatchObject({
			code: "bridge_permission_denied",
		});

		fetchMock.mockRejectedValueOnce(
			new AppError({ code: "network_offline", message: "Failed to fetch" }),
		);
		await expect(bridgeService.getStates(["game/A"])).rejects.toMatchObject({
			code: "bridge_unavailable",
		});
	});

	it("請求一律經 authenticatedFetch 並使用 bridge 白名單 URL", async () => {
		fetchMock.mockResolvedValue(Response.json({ games: [] }));
		await bridgeService.getStates(["game/A"]);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("http://127.0.0.1:8081/rpc/game/state"),
			undefined,
		);
	});
});
