/**
 * @file 网页版 HTTP 传输
 * @description 带 TeleDrive JWT 呼叫 reina-server 与本机 bridge；401 刷新一次后重试。
 * token 只会送往白名单目的地，第三方元数据来源一律不带 TeleDrive 凭证。
 */

import { AppError } from "@/utils/errors";
import {
	NotLoggedInError,
	notifyAuthRequired,
	readTeleDriveJwt,
	refreshTeleDriveJwt,
} from "./auth";

export const SERVER_API_PREFIX = "/game/api/";
export const BRIDGE_ORIGIN = "http://127.0.0.1:8081";
const BRIDGE_PATH_PREFIX = "/rpc/game/";

function isAllowedDestination(input: string): boolean {
	let url: URL;
	try {
		url = new URL(input, window.location.origin);
	} catch {
		return false;
	}
	if (url.origin === BRIDGE_ORIGIN) {
		return url.pathname.startsWith(BRIDGE_PATH_PREFIX);
	}
	return (
		url.origin === window.location.origin &&
		url.pathname.startsWith(SERVER_API_PREFIX)
	);
}

async function sendWithToken(
	input: string,
	init: RequestInit,
	token: string,
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	try {
		return await fetch(input, { ...init, headers });
	} catch (cause) {
		// 呼叫方主动中止：原样丢出，交给呼叫方判断
		if (cause instanceof DOMException && cause.name === "AbortError") {
			throw cause;
		}
		throw new AppError({
			code: "network_offline",
			message: `Network request failed: ${input}`,
			cause,
		});
	}
}

/**
 * 注意：重试会重送同一个 init.body，所以 body 只能是字符串、Blob 或 FormData，
 * 不能是只能读一次的 ReadableStream。
 */
export async function authenticatedFetch(
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	if (!isAllowedDestination(input)) {
		throw new AppError({
			code: "forbidden_destination",
			message: `Refusing to send TeleDrive token to ${input}`,
		});
	}

	const token = await readTeleDriveJwt();
	if (!token) {
		notifyAuthRequired();
		throw new NotLoggedInError();
	}

	const first = await sendWithToken(input, init, token);
	if (first.status !== 401) return first;

	let freshToken: string;
	try {
		freshToken = await refreshTeleDriveJwt(token);
	} catch (error) {
		if (error instanceof NotLoggedInError) notifyAuthRequired();
		throw error;
	}

	const second = await sendWithToken(input, init, freshToken);
	if (second.status === 401) {
		notifyAuthRequired();
		throw new NotLoggedInError();
	}
	return second;
}

async function toRpcError(
	response: Response,
	command: string,
	args?: Record<string, unknown>,
): Promise<AppError> {
	let code = "server_rpc_failed";
	let message = `HTTP ${response.status}: ${command}`;
	let detail: string | undefined;
	try {
		const body = (await response.json()) as Record<string, unknown>;
		if (typeof body.code === "string") code = body.code;
		if (typeof body.message === "string") message = body.message;
		if (typeof body.detail === "string") detail = body.detail;
	} catch {
		// 非 JSON 错误体（例如 nginx 502 页面）：保留 HTTP 状态信息
	}
	if (response.status === 403) code = "forbidden";
	return new AppError({
		code,
		message,
		detail,
		context: { command, args, status: response.status },
	});
}

export async function serverRpc<T>(
	command: string,
	args?: Record<string, unknown>,
): Promise<T> {
	const response = await authenticatedFetch(
		`${SERVER_API_PREFIX}rpc/${encodeURIComponent(command)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(args ?? {}),
		},
	);
	if (!response.ok) {
		throw await toRpcError(response, command, args);
	}
	return (await response.json()) as T;
}
