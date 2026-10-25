import {
	onlineManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "@/providers/queryClient";
import { bridgeService } from "@/services/web/bridge";
import { bridgeKeys, useBridgeGames } from "./useBridgeGames";

const mocks = vi.hoisted(() => ({ checkServerVersion: vi.fn() }));
vi.mock("@/hooks/queries/useServerVersion", () => ({
	checkServerVersion: mocks.checkServerVersion,
}));
vi.mock("@/services/web/bridge", () => ({
	bridgeService: {
		getStates: vi.fn(),
		fetch: vi.fn(),
		cancel: vi.fn(),
		getExes: vi.fn(),
		launch: vi.fn(),
	},
}));

const service = vi.mocked(bridgeService);
let testClient: QueryClient;
let visibility: DocumentVisibilityState = "visible";
const idle = {
	path: "game/A",
	status: "absent" as const,
	completed_bytes: 0,
	total_bytes: 0,
	elapsed_seconds: 0,
	error: null,
};

function wrapper({ children }: PropsWithChildren) {
	return (
		<QueryClientProvider client={testClient}>{children}</QueryClientProvider>
	);
}

async function flushQuery() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(0);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibility,
	});
	mocks.checkServerVersion.mockReset().mockResolvedValue(undefined);
	testClient = new QueryClient({
		defaultOptions: queryClient.getDefaultOptions(),
	});
	service.getStates.mockReset().mockResolvedValue({ games: [idle] });
	service.fetch
		.mockReset()
		.mockResolvedValue({ ...idle, status: "downloading" as const });
	service.cancel
		.mockReset()
		.mockResolvedValue({ ...idle, status: "ready" as const });
	service.getExes.mockReset().mockResolvedValue({ exes: [] });
	service.launch.mockReset().mockResolvedValue({ session_id: "session" });
});

afterEach(() => {
	cleanup();
	testClient.clear();
	onlineManager.setOnline(true);
	visibility = "visible";
	vi.useRealTimers();
});

describe("useBridgeGames", () => {
	it("隔離在 bridge namespace，空闲 absent/ready 状态不轮询", async () => {
		const { result, rerender } = renderHook(() => useBridgeGames(["game/A"]), {
			wrapper,
		});
		await flushQuery();
		expect(result.current.states[0]?.status).toBe("absent");
		expect(bridgeKeys.states(["game/A"])).toEqual([
			"bridge",
			"games",
			"states",
			["game/A"],
		]);
		expect(service.getStates).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTimeAsync(15_000));
		expect(service.getStates).toHaveBeenCalledTimes(1);
		rerender();
		expect(
			testClient.getQueryState(bridgeKeys.states(["game/A"]))?.isInvalidated,
		).toBe(false);
	});

	it("downloading 每 2 秒查詢；轉 running 後每 10 秒查詢，結束停止輪詢", async () => {
		service.getStates
			.mockResolvedValueOnce({ games: [{ ...idle, status: "downloading" }] })
			.mockResolvedValueOnce({ games: [{ ...idle, status: "running" }] })
			.mockResolvedValue({ games: [idle] });
		const { result } = renderHook(() => useBridgeGames(["game/A"]), {
			wrapper,
		});
		await flushQuery();
		expect(result.current.states[0]?.status).toBe("downloading");
		visibility = "hidden";
		act(() => window.dispatchEvent(new Event("visibilitychange")));
		await act(async () => vi.advanceTimersByTimeAsync(6_000));
		expect(service.getStates).toHaveBeenCalledTimes(1);
		visibility = "visible";
		act(() => window.dispatchEvent(new Event("visibilitychange")));
		await flushQuery();
		expect(service.getStates).toHaveBeenCalledTimes(2);
		expect(
			testClient.getQueryData<{ games: Array<{ status: string }> }>(
				bridgeKeys.states(["game/A"]),
			)?.games[0]?.status,
		).toBe("running");
		await act(async () => vi.advanceTimersByTimeAsync(10_000));
		await flushQuery();
		expect(service.getStates).toHaveBeenCalledTimes(3);
		expect(
			testClient.getQueryData<{ games: Array<{ status: string }> }>(
				bridgeKeys.states(["game/A"]),
			)?.games[0]?.status,
		).toBe("absent");
		const idleCount = service.getStates.mock.calls.length;
		await act(async () => vi.advanceTimersByTimeAsync(15_000));
		expect(service.getStates).toHaveBeenCalledTimes(idleCount);
	});

	it("成功操作後失效 bridge state cache，响应错误不会伪装成 absent", async () => {
		const { result } = renderHook(() => useBridgeGames(["game/A"]), {
			wrapper,
		});
		await flushQuery();
		expect(result.current.states[0]?.status).toBe("absent");
		await act(async () => result.current.fetchGame("game/A"));
		expect(service.fetch).toHaveBeenCalledWith("game/A");
		await flushQuery();
		expect(service.getStates.mock.calls.length).toBeGreaterThan(1);

		service.getStates.mockRejectedValue(
			Object.assign(new Error("bridge offline"), {
				code: "bridge_unavailable",
			}),
		);
		void result.current.refetch();
		await flushQuery();
		await act(async () => vi.advanceTimersByTimeAsync(3_000));
		await flushQuery();
		expect(
			testClient.getQueryState(bridgeKeys.states(["game/A"]))?.status,
		).toBe("error");
	});

	it("focus、reconnect 与卸载后重新挂载重新读取 absent/ready 缓存", async () => {
		service.getStates.mockResolvedValue({
			games: [{ ...idle, status: "ready" }],
		});
		const first = renderHook(() => useBridgeGames(["game/A"]), { wrapper });
		await flushQuery();
		expect(first.result.current.states[0]?.status).toBe("ready");
		first.unmount();
		const before = service.getStates.mock.calls.length;
		const second = renderHook(() => useBridgeGames(["game/A"]), { wrapper });
		await flushQuery();
		expect(service.getStates).toHaveBeenCalledTimes(before + 1);
		act(() => window.dispatchEvent(new Event("focus")));
		await flushQuery();
		expect(service.getStates).toHaveBeenCalledTimes(before + 2);
		act(() => window.dispatchEvent(new Event("offline")));
		act(() => window.dispatchEvent(new Event("online")));
		await flushQuery();
		expect(service.getStates).toHaveBeenCalledTimes(before + 3);
		second.unmount();
	});

	it("running 轉為非 running 時只檢查一次 server version", async () => {
		vi.useRealTimers();
		const path = "game/end-check";
		service.getStates
			.mockResolvedValueOnce({ games: [{ ...idle, path, status: "running" }] })
			.mockResolvedValue({ games: [{ ...idle, path }] });
		const { result, unmount } = renderHook(() => useBridgeGames([path]), {
			wrapper,
		});
		await waitFor(() =>
			expect(result.current.states[0]?.status).toBe("running"),
		);
		await act(async () => result.current.refetch());
		await waitFor(() =>
			expect(mocks.checkServerVersion).toHaveBeenCalledTimes(1),
		);
		expect(mocks.checkServerVersion).toHaveBeenCalledTimes(1);
		unmount();
	}, 4_000);
});
