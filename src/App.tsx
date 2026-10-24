import "./App.css";
import "@/providers/i18n";
import { SnackbarProvider } from "notistack";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
import { InstallRequestHandler } from "@/components/InstallRequestHandler";
import { UiZoom } from "@/components/UiZoom";
import { WebAuthGate } from "@/components/WebAuthGate";
import WindowsHandler from "@/components/Windows";
import { useWebAuthRequired } from "@/hooks/common/useWebAuthRequired";
import { useCloudScanAutoRun } from "@/hooks/features/games/useCloudScan";
import { useServerVersionSync } from "@/hooks/queries/useServerVersion";
import { appRoutes } from "@/providers/router"; // 引入新的统一配置
import { SnackbarUtilsConfigurator } from "@/providers/snackBar";
import { ToolpadReactRouterAppProvider } from "@/providers/ToolpadReactRouterAppProvider";
import { initBgmAuthRefresh } from "@/services/oauth/bgmAuthSession";
import { initHikarinagiAuthRefresh } from "@/services/oauth/hikarinagiAuthSession";
import { isWebRuntime, platformCapabilities } from "@/services/platform";

// 只负责挂上版本轮询，不渲染任何内容
const ServerVersionSync: React.FC = () => {
	useServerVersionSync();
	return null;
};

// 网页版背景定期扫描 TeleDrive 云端，不渲染任何内容
const CloudScanAutoRun: React.FC = () => {
	useCloudScanAutoRun();
	return null;
};

const App: React.FC = () => {
	const { t } = useTranslation();
	const webAuthRequired = useWebAuthRequired();

	useEffect(() => {
		void initBgmAuthRefresh();
		void initHikarinagiAuthRefresh();
	}, []);

	// 网页版执行中 token 失效且刷新失败：整页改为登录提示
	if (isWebRuntime() && webAuthRequired) {
		return <WebAuthGate onRetry={() => window.location.reload()} />;
	}

	// 从路由配置动态生成导航菜单
	const Navigation = appRoutes
		.filter((route) => !route.hideInMenu) // 过滤掉标记为隐藏的路由
		.map((route) => ({
			segment: route.path,
			title: t(route.title), // 使用 t 函数翻译标题
			icon: route.icon,
			pattern: route.navPattern, // 使用 navPattern
		}));

	return (
		<SnackbarProvider
			maxSnack={3}
			autoHideDuration={3000}
			anchorOrigin={{ vertical: "top", horizontal: "center" }}
		>
			<SnackbarUtilsConfigurator />
			{isWebRuntime() && <ServerVersionSync />}
			{isWebRuntime() && <CloudScanAutoRun />}
			<UiZoom />
			<ToolpadReactRouterAppProvider navigation={Navigation}>
				{platformCapabilities.desktopShell && <WindowsHandler />}
				{platformCapabilities.desktopShell && <InstallRequestHandler />}
				<Outlet />
			</ToolpadReactRouterAppProvider>
		</SnackbarProvider>
	);
};

export default App;
