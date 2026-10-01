import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	NotLoggedInError,
	readTeleDriveJwt,
	refreshTeleDriveJwt,
} from "./auth";

const DB = "teledrive-credentials";
const STORE = "credentials";
const KEY = "active";

// 模拟 TeleDrive 前端写入的凭证记录（accounts 内是 Telegram session）
const ACCOUNTS = [
	{ id: 1, label: "main", session: "1BQANOTE-session-bytes-不可改动" },
];

function seedCredentials(record: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE);
		};
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put(record, KEY);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error);
		};
		request.onerror = () => reject(request.error);
	});
}

function readRecord(): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB);
		request.onsuccess = () => {
			const db = request.result;
			const get = db.transaction(STORE).objectStore(STORE).get(KEY);
			get.onsuccess = () => {
				db.close();
				resolve(get.result);
			};
			get.onerror = () => reject(get.error);
		};
		request.onerror = () => reject(request.error);
	});
}

function deleteRecord(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB);
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).delete(KEY);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error);
		};
		request.onerror = () => reject(request.error);
	});
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

describe("readTeleDriveJwt", () => {
	it("资料库不存在时回传 null，且不替 TeleDrive 建立资料库", async () => {
		await expect(readTeleDriveJwt()).resolves.toBeNull();
		const names = (await indexedDB.databases()).map((db) => db.name);
		expect(names).not.toContain(DB);
	});

	it("回传 active.jwt", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "jwt-1" });
		await expect(readTeleDriveJwt()).resolves.toBe("jwt-1");
	});

	it("jwt 为 null 或空字串时视为未登入", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: null });
		await expect(readTeleDriveJwt()).resolves.toBeNull();
		await seedCredentials({ accounts: ACCOUNTS, jwt: "" });
		await expect(readTeleDriveJwt()).resolves.toBeNull();
	});
});

describe("refreshTeleDriveJwt", () => {
	it("20 个并发刷新只送出一次请求，写回后 accounts 完全不变", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		fetchMock.mockImplementation(async () => Response.json({ token: "fresh" }));

		const results = await Promise.all(
			Array.from({ length: 20 }, () => refreshTeleDriveJwt("stale")),
		);

		expect(results.every((token) => token === "fresh")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("/api/v1/auth/refresh");
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer stale",
		);
		expect(await readRecord()).toEqual({ accounts: ACCOUNTS, jwt: "fresh" });
	});

	it("IndexedDB 内已是别的 token（别的分页刷新过）时直接沿用，不再请求", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "already-fresh" });
		await expect(refreshTeleDriveJwt("stale")).resolves.toBe("already-fresh");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("刷新回 401 时丢 NotLoggedInError，纪录不变", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
		await expect(refreshTeleDriveJwt("stale")).rejects.toBeInstanceOf(
			NotLoggedInError,
		);
		expect(await readRecord()).toEqual({ accounts: ACCOUNTS, jwt: "stale" });
	});

	it("刷新期间使用者已登出：不写回、不复活纪录", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		fetchMock.mockImplementation(async () => {
			await deleteRecord();
			return Response.json({ token: "fresh" });
		});
		await expect(refreshTeleDriveJwt("stale")).rejects.toBeInstanceOf(
			NotLoggedInError,
		);
		expect(await readRecord()).toBeUndefined();
	});

	it("刷新期间 TeleDrive 分页改了 accounts：写回只换 jwt，保留新的 accounts", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		// 模拟使用者在 TeleDrive 分页新增了一个 Telegram 帐号，发生在刷新请求进行中
		const updatedAccounts = [
			...ACCOUNTS,
			{ id: 999, label: "新帐号", session: "session-new" },
		];
		fetchMock.mockImplementation(async () => {
			await seedCredentials({ accounts: updatedAccounts, jwt: "stale" });
			return Response.json({ token: "fresh" });
		});
		await expect(refreshTeleDriveJwt("stale")).resolves.toBe("fresh");
		expect(await readRecord()).toEqual({
			accounts: updatedAccounts,
			jwt: "fresh",
		});
	});
});
