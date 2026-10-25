/**
 * @file 本机 bridge 游戏 RPC
 * @description 所有请求复用网页认证传输，并只访问已列入白名单的 loopback RPC。
 */

import { AppError } from "@/utils/errors";
import { authenticatedFetch } from "./http";

export type BridgeGameStatus =
	| "running"
	| "downloading"
	| "ready"
	| "incomplete"
	| "absent";

export interface BridgeGameState {
	path: string;
	status: BridgeGameStatus;
	completed_bytes: number;
	total_bytes: number;
	elapsed_seconds: number;
	error: string | null;
	capabilities?: { locale_emulator?: boolean };
}

export interface BridgeLaunchParams {
	path: string;
	exe_relpath: string;
	game_id: number;
	locale_emulator: boolean;
}

export interface BridgeLaunchResult {
	session_id: string;
}

const BRIDGE_ORIGIN = "http://127.0.0.1:8081";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await authenticatedFetch(
			`${BRIDGE_ORIGIN}/rpc/game/${path}`,
			init,
		);
	} catch (cause) {
		if (cause instanceof AppError && cause.code === "network_offline") {
			throw new AppError({
				code: "bridge_unavailable",
				message: "Local bridge is unavailable",
				cause,
			});
		}
		throw cause;
	}

	if (response.ok) return (await response.json()) as T;

	let code = "bridge_request_failed";
	let message = `HTTP ${response.status}: bridge ${path}`;
	try {
		const body = (await response.json()) as Record<string, unknown>;
		if (typeof body.code === "string") code = body.code;
		if (typeof body.error === "string") message = body.error;
		else if (typeof body.message === "string") message = body.message;
	} catch {
		// bridge 未啟動時瀏覽器可能拿到非 JSON 的代理錯誤頁。
	}
	if (response.status === 403) code = "bridge_permission_denied";
	if (response.status >= 500) code = "bridge_unavailable";
	throw new AppError({
		code,
		message,
		context: { status: response.status, path },
	});
}

export const bridgeService = {
	getStates(paths: string[]): Promise<{ games: BridgeGameState[] }> {
		const query = new URLSearchParams();
		for (const path of paths) query.append("paths", path);
		return request(`state?${query.toString()}`);
	},

	fetch(path: string): Promise<BridgeGameState> {
		return request("fetch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		});
	},

	cancel(path: string): Promise<BridgeGameState> {
		const query = new URLSearchParams({ path });
		return request(`fetch?${query.toString()}`, { method: "DELETE" });
	},

	async getExes(path: string): Promise<{ exes: string[] }> {
		const query = new URLSearchParams({ path });
		return request(`exes?${query.toString()}`);
	},

	launch(params: BridgeLaunchParams): Promise<BridgeLaunchResult> {
		return request("launch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		});
	},
};
