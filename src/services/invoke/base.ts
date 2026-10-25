/**
 * @file Service 基础类
 * @description 提供统一的错误归一化能力；网页版改走 reina-server 的 HTTP RPC
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { isWebRuntime } from "@/services/platform";
import { serverRpc } from "@/services/web/http";
import { AppError, normalizeTauriError } from "@/utils/errors";

/**
 * 基础 Service 类
 */
export class BaseService {
	/**
	 * 调用后端 command（桌面版为 Tauri IPC，网页版为 HTTP RPC）
	 * @param command 命令名称
	 * @param args 参数
	 * @returns Promise 结果
	 */
	protected async invoke<T>(
		command: string,
		args?: Record<string, unknown>,
	): Promise<T> {
		if (isWebRuntime()) {
			// 参数名称与回传型别和 Tauri command 相同，由 reina-server 的白名单决定能否呼叫
			return serverRpc<T>(command, args);
		}

		if (!isTauri()) {
			throw new AppError({
				code: "tauri_invoke_failed",
				message: `Tauri runtime is unavailable: ${command}`,
			});
		}

		try {
			return await invoke<T>(command, args);
		} catch (error) {
			throw normalizeTauriError(error, { command, args });
		}
	}
}
