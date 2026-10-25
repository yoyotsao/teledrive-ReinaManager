import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotLoggedInError } from "@/services/web/auth";
import { serverKey } from "./serverKeys";
import {
	createServerVersionSyncer,
	SERVER_VERSION_POLL_MS,
	type ServerVersionSyncer,
	useServerVersionSync,
} from "./useServerVersion";

vi.mock("@/services/web/version", () => ({
	fetchServerVersion: vi.fn(async () => 0),
}));

// 模拟 reina-server：只保存资料与全局版本
interface FakeServer {
	version: number;
	games: Record<string, string>;
}

function createClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: Number.POSITIVE_INFINITY,
				gcTime: Number.POSITIVE_INFINITY,
				retry: false,
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
			},
		},
	});
}

// 让 query 处于 active（有 observer）状态，失效时才会立刻重新读取
function observeGames(client: QueryClient, server: FakeServer) {
	const observer = new QueryObserver(client, {
		queryKey: serverKey("games"),
		queryFn: async () => ({ ...server.games }),
	});
	const unsubscribe = observer.subscribe(() => {});
	return { observer, unsubscribe };
}

describe("createServerVersionSyncer", () => {
	it("启动采样（prime）只记录版本，不失效任何 query", async () => {
		const client = createClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const syncer = createServerVersionSyncer(client, async () => 10);
		await syncer.prime();
		expect(syncer.getSyncedVersion()).toBe(10);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("启动采样失败后，第一次成功的检查会先重新读取已加载的资料，再记录版本", async () => {
		// 页面在版本 1 时读到资料，但启动采样失败；之后另一台装置改成版本 2
		const server: FakeServer = { version: 1, games: { A: "a0", B: "b0" } };
		const client = createClient();
		const { unsubscribe } = observeGames(client, server);
		let reachable = false;
		const syncer = createServerVersionSyncer(client, async () => {
			if (!reachable) throw new Error("offline");
			return server.version;
		});
		await expect(syncer.prime()).rejects.toThrow("offline");
		await client.fetchQuery({
			queryKey: serverKey("games"),
			queryFn: async () => ({ ...server.games }),
		});
		expect(syncer.getSyncedVersion()).toBeNull();

		server.games.A = "a1";
		server.version = 2;
		reachable = true;
		await syncer.check();
		// 不能把版本 1 的旧资料当成已同步到版本 2
		expect(client.getQueryData(serverKey("games"))).toEqual({
			A: "a1",
			B: "b0",
		});
		expect(syncer.getSyncedVersion()).toBe(2);
		unsubscribe();
	});

	it("手机改 A（10→11）、电脑改 B（回传 12）：轮询后 A、B 都是新值", async () => {
		const server: FakeServer = { version: 10, games: { A: "a0", B: "b0" } };
		const client = createClient();
		const { unsubscribe } = observeGames(client, server);
		await client.fetchQuery({
			queryKey: serverKey("games"),
			queryFn: async () => ({ ...server.games }),
		});
		const syncer = createServerVersionSyncer(
			client,
			async () => server.version,
		);
		await syncer.prime(); // 首屏读取前的首次采样
		expect(syncer.getSyncedVersion()).toBe(10);

		// 手机修改 A：服务器版本 11
		server.games.A = "a1";
		server.version = 11;

		// 电脑修改 B：服务器回传版本 12，本机只 patch B
		server.games.B = "b1";
		server.version = 12;
		const mutationResponse = { game: "b1", data_version: 12 };
		client.setQueryData<Record<string, string>>(serverKey("games"), (old) => ({
			...(old ?? {}),
			B: mutationResponse.game,
		}));

		// 修改回应里的版本不能推进已同步版本
		expect(syncer.getSyncedVersion()).toBe(10);
		expect(client.getQueryData(serverKey("games"))).toEqual({
			A: "a0",
			B: "b1",
		});

		await syncer.check();
		expect(client.getQueryData(serverKey("games"))).toEqual({
			A: "a1",
			B: "b1",
		});
		expect(syncer.getSyncedVersion()).toBe(12);
		unsubscribe();
	});

	it("只失效 server 前缀，不影响 bridge 与其他 key", async () => {
		const client = createClient();
		client.setQueryData(serverKey("games"), []);
		client.setQueryData(["bridge", "states"], []);
		client.setQueryData(["tasks"], []);
		let version = 1;
		const syncer = createServerVersionSyncer(client, async () => version);
		await syncer.prime();
		version = 2;
		await syncer.check();
		expect(client.getQueryState(serverKey("games"))?.isInvalidated).toBe(true);
		expect(client.getQueryState(["bridge", "states"])?.isInvalidated).toBe(
			false,
		);
		expect(client.getQueryState(["tasks"])?.isInvalidated).toBe(false);
	});

	it("重新读取失败时不推进已同步版本，下一次检查会再试", async () => {
		const client = createClient();
		let fail = true;
		const observer = new QueryObserver(client, {
			queryKey: serverKey("games"),
			queryFn: async () => {
				if (fail) throw new Error("offline");
				return ["ok"];
			},
		});
		const unsubscribe = observer.subscribe(() => {});
		let version = 5;
		const syncer = createServerVersionSyncer(client, async () => version);
		await syncer.prime();
		version = 6;
		await expect(syncer.check()).rejects.toThrow("offline");
		expect(syncer.getSyncedVersion()).toBe(5);
		fail = false;
		await syncer.check();
		expect(syncer.getSyncedVersion()).toBe(6);
		expect(client.getQueryData(serverKey("games"))).toEqual(["ok"]);
		unsubscribe();
	});

	it("登录失效时不失效任何 query、不推进版本；重新登录后照常同步", async () => {
		const client = createClient();
		client.setQueryData(serverKey("games"), ["cached"]);
		let loggedIn = true;
		let version = 7;
		const syncer = createServerVersionSyncer(client, async () => {
			if (!loggedIn) throw new NotLoggedInError();
			return version;
		});
		await syncer.prime();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		// 后台分页放了很久，token 刷新也失败：检查失败，但画面上的快取资料保持不动
		loggedIn = false;
		version = 8;
		await expect(syncer.check()).rejects.toBeInstanceOf(NotLoggedInError);
		expect(invalidate).not.toHaveBeenCalled();
		expect(syncer.getSyncedVersion()).toBe(7);
		expect(client.getQueryData(serverKey("games"))).toEqual(["cached"]);

		// 用户回 TeleDrive 登录后，下一次检查补上期间的变更
		loggedIn = true;
		await syncer.check();
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(syncer.getSyncedVersion()).toBe(8);
	});

	it("同时多次检查只送出一次版本请求", async () => {
		const client = createClient();
		const fetchVersion = vi.fn(async () => 3);
		const syncer = createServerVersionSyncer(client, fetchVersion);
		await Promise.all([syncer.check(), syncer.check(), syncer.check()]);
		expect(fetchVersion).toHaveBeenCalledTimes(1);
	});

	it("prime 进行中呼叫 check → check 仍会实际比对版本并在版本改变时失效", async () => {
		// bridge 可能在任意时机呼叫 checkServerVersion()，需覆盖它与启动采样撞在一起的情况
		const client = createClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		let resolvePrimeFetch: (version: number) => void = () => {};
		let callCount = 0;
		const fetchVersion = vi.fn(() => {
			callCount += 1;
			if (callCount === 1) {
				// prime 的这次采样先卡住，模拟它尚未完成
				return new Promise<number>((resolve) => {
					resolvePrimeFetch = resolve;
				});
			}
			// check 自己的采样：晚于 prime 完成，服务器版本已经变成 2
			return Promise.resolve(2);
		});
		const syncer = createServerVersionSyncer(client, fetchVersion);

		const primePromise = syncer.prime();
		const checkPromise = syncer.check();

		resolvePrimeFetch(1);
		await primePromise;
		expect(syncer.getSyncedVersion()).toBe(1);

		await checkPromise;
		// check 不能直接借用 prime 的采样结果，必须自己再问一次服务器
		expect(fetchVersion).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalled();
		expect(syncer.getSyncedVersion()).toBe(2);
	});
});

describe("useServerVersionSync", () => {
	let visibility: DocumentVisibilityState = "visible";

	beforeEach(() => {
		vi.useFakeTimers();
		visibility = "visible";
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => visibility,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createSpySyncer(): ServerVersionSyncer & {
		check: ReturnType<typeof vi.fn>;
	} {
		return {
			prime: vi.fn(async () => {}),
			check: vi.fn(async () => {}),
			getSyncedVersion: () => 1,
		};
	}

	it("读取不改版本时，5 分钟内不会全面失效，且每 60 秒只检查一次", async () => {
		const client = createClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const fetchVersion = vi.fn(async () => 7);
		const syncer = createServerVersionSyncer(client, fetchVersion);
		await syncer.prime(); // 与正式启动流程一致：挂载前已完成首次采样
		fetchVersion.mockClear();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(fetchVersion).toHaveBeenCalledTimes(1 + 5);
		expect(invalidate).not.toHaveBeenCalled();
		unmount();
	});

	it("页面隐藏时暂停轮询，回到前景立刻检查并恢复", async () => {
		const syncer = createSpySyncer();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));
		expect(syncer.check).toHaveBeenCalledTimes(1);

		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(3 * SERVER_VERSION_POLL_MS);
		expect(syncer.check).toHaveBeenCalledTimes(1);

		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(syncer.check).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(SERVER_VERSION_POLL_MS);
		expect(syncer.check).toHaveBeenCalledTimes(3);
		unmount();
	});

	it("窗口聚焦与重新连线时立刻检查", () => {
		const syncer = createSpySyncer();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("online"));
		expect(syncer.check).toHaveBeenCalledTimes(3);
		unmount();
	});

	it("卸载后不再检查", async () => {
		const syncer = createSpySyncer();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));
		unmount();
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(2 * SERVER_VERSION_POLL_MS);
		expect(syncer.check).toHaveBeenCalledTimes(1);
	});
});
