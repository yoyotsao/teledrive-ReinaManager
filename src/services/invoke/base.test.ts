import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseService } from "./base";

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { serverRpcMock } = vi.hoisted(() => ({
	serverRpcMock: vi.fn(),
}));
vi.mock("@/services/web/http", () => ({
	serverRpc: (...args: unknown[]) => serverRpcMock(...args),
}));

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { tauriInvokeMock } = vi.hoisted(() => ({
	tauriInvokeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => tauriInvokeMock(...args),
	isTauri: () => false,
}));

class ProbeService extends BaseService {
	call<T>(command: string, args?: Record<string, unknown>) {
		return this.invoke<T>(command, args);
	}
}

beforeEach(() => {
	serverRpcMock.mockReset();
	tauriInvokeMock.mockReset();
});

describe("BaseService.invoke", () => {
	it("网页版改走 serverRpc，保留参数名称与回传型别", async () => {
		vi.stubEnv("MODE", "web");
		serverRpcMock.mockResolvedValue([{ id: 1 }]);
		await expect(
			new ProbeService().call("find_all_games", { gameType: "all" }),
		).resolves.toEqual([{ id: 1 }]);
		expect(serverRpcMock).toHaveBeenCalledWith("find_all_games", {
			gameType: "all",
		});
		expect(tauriInvokeMock).not.toHaveBeenCalled();
	});

	it("非网页、非 Tauri 时维持原本的 tauri_invoke_failed", async () => {
		vi.stubEnv("MODE", "test");
		await expect(
			new ProbeService().call("find_all_games"),
		).rejects.toMatchObject({ code: "tauri_invoke_failed" });
		expect(serverRpcMock).not.toHaveBeenCalled();
	});
});
