/**
 * @file TeleDrive 登录凭证
 * @description 网页版沿用 TeleDrive 的登录：从同源 IndexedDB 读取 JWT，过期时刷新并写回。
 *
 * 安全约束：同一笔记录的 `accounts` 是 Telegram session（明文 bearer 凭证），
 * 本模块只读写 `jwt` 字段，绝不读取、传送或记录 `accounts`。
 */

import { AppError } from "@/utils/errors";

const CREDENTIAL_DB = "teledrive-credentials";
const CREDENTIAL_STORE = "credentials";
const CREDENTIAL_KEY = "active";
const REFRESH_URL = "/api/v1/auth/refresh";
const REFRESH_TIMEOUT_MS = 15_000;

export const AUTH_REQUIRED_EVENT = "reina:auth-required";

export class NotLoggedInError extends AppError {
	constructor(message = "TeleDrive login required") {
		super({ code: "not_logged_in", message, name: "NotLoggedInError" });
	}
}

/** 通知界面显示「请先登录 TeleDrive」 */
export function notifyAuthRequired(): void {
	window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}

function openCredentialDb(): Promise<IDBDatabase | null> {
	return new Promise((resolve, reject) => {
		// 不指定版本：TeleDrive 升级资料库版本时这里也不会因 VersionError 失败
		const request = indexedDB.open(CREDENTIAL_DB);
		let creationAborted = false;
		request.onupgradeneeded = (event) => {
			// oldVersion 为 0 代表资料库原本不存在（TeleDrive 从未登录）：
			// 中止这次建立，避免替 TeleDrive 建出空资料库
			if (event.oldVersion === 0) {
				creationAborted = true;
				request.transaction?.abort();
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			if (creationAborted) {
				resolve(null);
				return;
			}
			reject(
				request.error ?? new Error("TeleDrive credential database unavailable"),
			);
		};
	});
}

function extractJwt(record: unknown): string | null {
	if (!record || typeof record !== "object") return null;
	const jwt = (record as { jwt?: unknown }).jwt;
	return typeof jwt === "string" && jwt.length > 0 ? jwt : null;
}

export async function readTeleDriveJwt(): Promise<string | null> {
	const db = await openCredentialDb();
	if (!db) return null;
	try {
		if (!db.objectStoreNames.contains(CREDENTIAL_STORE)) return null;
		const record = await new Promise<unknown>((resolve, reject) => {
			const request = db
				.transaction(CREDENTIAL_STORE, "readonly")
				.objectStore(CREDENTIAL_STORE)
				.get(CREDENTIAL_KEY);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return extractJwt(record);
	} finally {
		db.close();
	}
}

/**
 * 在同一个 readwrite transaction 内 get → put，只替换 jwt，
 * 保留当下的 accounts，避免覆盖 TeleDrive 分页同时做的修改。
 * @returns 是否真的写入；期间已登出（纪录或 jwt 不存在）时回传 false
 */
async function writeBackJwt(freshToken: string): Promise<boolean> {
	const db = await openCredentialDb();
	if (!db) return false;
	try {
		if (!db.objectStoreNames.contains(CREDENTIAL_STORE)) return false;
		return await new Promise<boolean>((resolve, reject) => {
			const tx = db.transaction(CREDENTIAL_STORE, "readwrite");
			const store = tx.objectStore(CREDENTIAL_STORE);
			let written = false;
			const getRequest = store.get(CREDENTIAL_KEY);
			getRequest.onsuccess = () => {
				const record = getRequest.result;
				// 期间已登出：不复活已经退出的登录
				if (!extractJwt(record)) return;
				store.put({ ...(record as object), jwt: freshToken }, CREDENTIAL_KEY);
				written = true;
			};
			tx.oncomplete = () => resolve(written);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

async function performRefresh(staleToken: string): Promise<string> {
	// 其他分页（TeleDrive 或另一个 /game）可能已经刷新过：直接沿用，避免刷新风暴
	const current = await readTeleDriveJwt();
	if (!current) throw new NotLoggedInError();
	if (current !== staleToken) return current;

	let response: Response;
	try {
		// 网络请求在 IndexedDB transaction 之外完成，避免 transaction 因等待而自动提交
		response = await fetch(REFRESH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${staleToken}` },
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		});
	} catch (cause) {
		throw new AppError({
			code: "network_offline",
			message: "TeleDrive token refresh request failed",
			cause,
		});
	}

	if (response.status === 401 || response.status === 403) {
		throw new NotLoggedInError();
	}
	if (!response.ok) {
		throw new AppError({
			code: "server_rpc_failed",
			message: `TeleDrive token refresh failed: HTTP ${response.status}`,
		});
	}

	const body = (await response.json()) as { token?: unknown };
	if (typeof body.token !== "string" || body.token.length === 0) {
		throw new AppError({
			code: "http_response_parse_failed",
			message: "TeleDrive token refresh returned no token",
		});
	}

	if (!(await writeBackJwt(body.token))) {
		throw new NotLoggedInError();
	}
	return body.token;
}

let refreshInFlight: Promise<string> | null = null;

/** 同一时间只送一个刷新请求，其他呼叫者等待同一个结果 */
export function refreshTeleDriveJwt(staleToken: string): Promise<string> {
	if (!refreshInFlight) {
		refreshInFlight = performRefresh(staleToken).finally(() => {
			refreshInFlight = null;
		});
	}
	return refreshInFlight;
}
