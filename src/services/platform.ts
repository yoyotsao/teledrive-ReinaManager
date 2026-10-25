/**
 * @file 执行环境与平台能力
 * @description 网页版以 `vite --mode web` 建置；桌面版（Tauri）才具备本机路径、启动游戏与桌面壳能力。
 * 能力以 getter 在执行时判断，呼叫端不要在模块载入时缓存结果。
 */

import { isTauri } from "@tauri-apps/api/core";

export function isWebRuntime(): boolean {
	return import.meta.env.MODE === "web";
}

function isDesktopRuntime(): boolean {
	return !isWebRuntime() && isTauri();
}

export const platformCapabilities = {
	/** 能读写本机路径、开文件夹、选档案 */
	get nativePaths(): boolean {
		return isDesktopRuntime();
	},
	/** 能由本程式直接启动游戏并计时（网页版改由 bridge 负责，见计画 B） */
	get nativeLaunch(): boolean {
		return isDesktopRuntime();
	},
	/** 视窗、系统匣、自动启动、updater、deep link、第三方 OAuth 回呼 */
	get desktopShell(): boolean {
		return isDesktopRuntime();
	},
};

export function getRouterBasename(): string | undefined {
	return isWebRuntime() ? "/game" : undefined;
}

/** public/ 下的静态资源路径；网页版部署在 /game/ 子路径下 */
export function publicAssetUrl(path: string): string {
	const relative = path.replace(/^\/+/, "");
	return isWebRuntime() ? `/game/${relative}` : `/${relative}`;
}

export async function openExternal(url: string): Promise<void> {
	if (!isDesktopRuntime()) {
		window.open(url, "_blank", "noopener,noreferrer");
		return;
	}
	const { open } = await import("@tauri-apps/plugin-shell");
	await open(url);
}
