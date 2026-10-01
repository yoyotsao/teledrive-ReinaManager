/**
 * @file main.tsx
 * @description 应用入口文件，初始化全局状态，设置全局事件监听，挂载根组件。
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * Emotion 缓存配置:
 * - 使用官方推荐的 CacheProvider + prepend: true 方案
 * - 确保 MUI 的 Emotion 样式被正确注入到 <head> 的开头
 * - 防止后来加载的样式(如 @mui/x-charts)覆盖 MUI 基础样式
 *
 * 网页版（vite --mode web）：
 * - 先确认 TeleDrive 登录，未登录只显示登录提示，不发出任何 API 请求
 * - 不执行系统匣、路径缓存、快捷键封锁等桌面专属初始化
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { routers } from "@/providers/router";
import "virtual:uno.css";
import "@/providers/i18n";
import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { isTauri } from "@tauri-apps/api/core";
import { WebAuthGate } from "@/components/WebAuthGate";
import { primeServerVersion } from "@/hooks/queries/useServerVersion";
import { queryClient } from "@/providers/queryClient";
import { startAutoBackupScheduler } from "@/services/autoBackupScheduler";
import { initPathCache } from "@/services/fs/pathCache";
import { isWebRuntime } from "@/services/platform";
import { initTray } from "@/services/plugins/trayService";
import { NotLoggedInError, readTeleDriveJwt } from "@/services/web/auth";
import { initializeStores, type StartupPage, useStore } from "./store/appStore";

// 创建 Emotion 缓存,确保样式注入顺序正确
// 根据官方文档: https://github.com/mui/material-ui/blob/master/docs/data/material/integrations/interoperability/interoperability.md
// prepend: true 会让 Emotion 的 <style> 标签插入到 <head> 的开头
// 这确保了 MUI 的基础样式优先级高于后来动态加载的组件样式(如 @mui/x-charts)
const emotionCache = createCache({
	key: "mui",
	prepend: true,
});

const DISABLED_FUNCTION_KEYS = ["F3", "F5", "F7"];
const DISABLED_CTRL_KEYS = ["r", "u", "p", "l", "j", "g", "f", "s"];
const STARTUP_PAGE_PATHS: Record<StartupPage, string> = {
	home: "/",
	libraries: "/libraries",
	collection: "/collection",
};

// 禁止拖拽、右键菜单和部分快捷键，提升桌面体验；网页版保留浏览器的重新整理与右键
function installDesktopInputGuards() {
	document.addEventListener("drop", (e) => e.preventDefault());
	document.addEventListener("dragover", (e) => e.preventDefault());
	document.addEventListener("contextmenu", (e) => e.preventDefault());
	document.addEventListener("keydown", (e) => {
		if (DISABLED_FUNCTION_KEYS.includes(e.key.toUpperCase())) {
			e.preventDefault();
		}

		if (e.ctrlKey && DISABLED_CTRL_KEYS.includes(e.key.toLowerCase())) {
			e.preventDefault();
		}
	});
}

const root = createRoot(document.getElementById("root") as HTMLElement);

function renderAuthGate() {
	root.render(
		<CacheProvider value={emotionCache}>
			<WebAuthGate onRetry={() => window.location.reload()} />
		</CacheProvider>,
	);
}

function renderApp() {
	root.render(
		<CacheProvider value={emotionCache}>
			<QueryClientProvider client={queryClient}>
				<ReactQueryDevtools initialIsOpen={false} />
				<RouterProvider router={routers} />
			</QueryClientProvider>
		</CacheProvider>,
	);
}

async function bootstrap() {
	if (isWebRuntime()) {
		const jwt = await readTeleDriveJwt().catch((error) => {
			console.error("读取 TeleDrive 登录凭证失败:", error);
			return null;
		});
		if (!jwt) {
			renderAuthGate();
			return;
		}
		// 首次采样必须早于首屏资料读取，之后的任何修改都会让版本变化而被轮询发现
		try {
			await primeServerVersion();
		} catch (error) {
			if (error instanceof NotLoggedInError) {
				renderAuthGate();
				return;
			}
			// 服务器暂时无法连接：照常挂载。之后第一次成功的检查会先重新读取已加载的资料，再记录版本
			console.error("首次读取服务器资料版本失败:", error);
		}
	} else {
		installDesktopInputGuards();
	}

	// 初始化全局状态后，挂载 React 应用
	await initializeStores();

	// 桌面版自动备份调度器（网页版由服务器负责备份）
	if (!isWebRuntime() && isTauri()) {
		startAutoBackupScheduler();
	}

	const currentLocation = routers.state.location;
	if (currentLocation.pathname === "/") {
		const startupPath = STARTUP_PAGE_PATHS[useStore.getState().startupPage];
		if (startupPath !== currentLocation.pathname) {
			await routers.navigate(startupPath, { replace: true });
		}
	}

	const trayReady =
		!isWebRuntime() && isTauri()
			? initTray().catch((error) => {
					console.error("托盘初始化失败:", error);
				})
			: Promise.resolve(null);

	// 封面路径依赖路径缓存，仍需在首屏挂载前完成
	if (!isWebRuntime() && isTauri()) {
		try {
			await initPathCache();
		} catch (error) {
			console.error("路径缓存初始化失败:", error);
		}
	}

	renderApp();

	void trayReady;
}

void bootstrap();
