import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBridgeGames } from "@/hooks/queries/useBridgeGames";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import { isWebRuntime } from "@/services/platform";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData, UpdateGameParams } from "@/types";
import { getUserErrorMessage } from "@/utils/errors";

export function useGameLaunchFlow(game?: GameData) {
	const { t } = useTranslation();
	const { mutateAsync: updateGame } = useUpdateGame();
	const launchGame = useGamePlayStore((s) => s.launchGame);
	const isWeb = isWebRuntime();
	const bridge = useBridgeGames(
		isWeb && game?.teledrive_path ? [game.teledrive_path] : [],
	);
	const [exeChoices, setExeChoices] = useState<string[] | null>(null);
	const [selectedExe, setSelectedExe] = useState<string | null>(null);
	const [forceExeSelection, setForceExeSelection] = useState(false);
	const [localeEmulator, setLocaleEmulator] = useState(false);
	const gameKey = game ? `${game.id}\u0000${game.teledrive_path ?? ""}` : null;

	useEffect(() => {
		if (gameKey === null) return;
		setExeChoices(null);
		setSelectedExe(null);
		setForceExeSelection(false);
		setLocaleEmulator(false);
	}, [gameKey]);

	const loadBridgeExes = useCallback(
		async (path: string) => {
			try {
				const { exes } = await bridge.getExes(path);
				setExeChoices(exes);
				if (exes.length === 0) {
					snackbar.warning(
						t("components.LaunchModal.bridgeNoExes", "没有找到可执行文件"),
					);
				}
			} catch (error) {
				snackbar.error(getUserErrorMessage(error, t));
			}
		},
		[bridge.getExes, t],
	);

	const selectBridgeExe = useCallback(
		async (game: GameData, exeRelpath: string) => {
			try {
				await updateGame({
					gameId: game.id,
					updates: { exe_relpath: exeRelpath },
				});
				setSelectedExe(exeRelpath);
				setExeChoices(null);
				setForceExeSelection(false);
				snackbar.success(t("components.LaunchModal.pathSaved", "路径已保存"));
			} catch (error) {
				snackbar.error(
					`${t("components.LaunchModal.pathSaveFailed", "保存路径失败")}: ${getUserErrorMessage(error, t)}`,
				);
			}
		},
		[t, updateGame],
	);

	const syncLocalPath = useCallback(
		async (game: GameData) => {
			if (isWebRuntime()) return false;
			let selectedPath: string | null;
			try {
				const { handleExeFile } = await import("@/services/fs/fileDialog");
				selectedPath = await handleExeFile(game.localpath);
			} catch (error) {
				snackbar.error(
					`${t("components.LaunchModal.selectExecutableFailed", "选择可执行文件失败")}: ${getUserErrorMessage(error, t)}`,
				);
				return false;
			}

			if (!selectedPath) {
				snackbar.warning(
					t(
						"components.LaunchModal.selectExecutableRequired",
						"请选择可执行文件",
					),
				);
				return false;
			}

			try {
				const { splitExecutablePath } = await import(
					"@/services/fs/fileDialog"
				);
				const executablePathParts = await splitExecutablePath(selectedPath);
				const updateData: UpdateGameParams = {
					...executablePathParts,
				};

				await updateGame({
					gameId: game.id,
					updates: updateData,
				});
				snackbar.success(t("components.LaunchModal.pathSaved", "路径已保存"));
				return true;
			} catch (error) {
				snackbar.error(
					`${t("components.LaunchModal.pathSaveFailed", "保存路径失败")}: ${getUserErrorMessage(error, t)}`,
				);
				return false;
			}
		},
		[t, updateGame],
	);

	const launchFromBridge = useCallback(
		async (game: GameData) => {
			const path = game.teledrive_path;
			if (!path) return;
			const state = bridge.stateByPath.get(path);
			if (!state || bridge.isError) return;
			try {
				switch (state.status) {
					case "absent":
					case "incomplete":
						await bridge.fetchGame(path);
						return;
					case "downloading":
						await bridge.cancelGame(path);
						return;
					case "running":
						return;
					case "ready": {
						const exeRelpath = selectedExe ?? game.exe_relpath;
						if (!exeRelpath || forceExeSelection) {
							await loadBridgeExes(path);
							return;
						}
						await bridge.launchBridgeGame({
							path,
							exe_relpath: exeRelpath,
							game_id: game.id,
							locale_emulator:
								state.capabilities?.locale_emulator === true && localeEmulator,
						});
						return;
					}
				}
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (
					code === "download_not_active" ||
					code === "bridge_game_running" ||
					code === "bridge_game_not_ready"
				) {
					// 狀態已變（下載結束、已在執行、尚未下載完）不代表 exe 失效，只刷新狀態
					await bridge.refetch();
					return;
				}
				if (code === "bridge_exe_invalid") {
					// 不清 server 上跨裝置共用的 exe_relpath，等使用者重選後再覆寫
					setForceExeSelection(true);
					setSelectedExe(null);
					await loadBridgeExes(path);
					snackbar.warning(
						t(
							"components.LaunchModal.bridgeExeChanged",
							"游戏文件已变化，请重新选择可执行文件",
						),
					);
					return;
				}
				snackbar.error(
					`${t("components.LaunchModal.launchFailed", "游戏启动失败:")}: ${getUserErrorMessage(error, t)}`,
				);
			}
		},
		[bridge, forceExeSelection, loadBridgeExes, localeEmulator, selectedExe, t],
	);

	const runLaunch = useCallback(
		async (game: GameData) => {
			if (isWebRuntime()) {
				await launchFromBridge(game);
				return;
			}
			try {
				if (game.launch_type === "steam") {
					if (!game.steam_launch_id) {
						snackbar.error(
							t(
								"components.LaunchModal.steamLaunchTargetMissing",
								"Steam 启动项无效，请重新关联",
							),
						);
						return;
					}
					if (!game.localpath) {
						snackbar.error(
							t(
								"components.LaunchModal.steamMonitorPathMissing",
								"Steam 游戏监控目录缺失，请重新关联",
							),
						);
						return;
					}

					const result = await launchGame(game.id);
					if (result.status === "failed") {
						snackbar.error(result.message);
					}
					return;
				}

				if (!game.localpath) {
					await syncLocalPath(game);
					return;
				}

				if (!game.executable) {
					const synced = await syncLocalPath(game);
					if (!synced) return;
				}

				const result = await launchGame(game.id);
				if (result.status === "failed") snackbar.error(result.message);
			} catch (error) {
				snackbar.error(
					`${t("components.LaunchModal.launchFailed", "游戏启动失败:")}: ${getUserErrorMessage(error, t)}`,
				);
			}
		},
		[launchFromBridge, launchGame, syncLocalPath, t],
	);

	return {
		launchGame: runLaunch,
		syncLocalPath,
		bridgeState: game?.teledrive_path
			? bridge.stateByPath.get(game.teledrive_path)
			: undefined,
		bridgeError: bridge.error,
		bridgeIsError: bridge.isError,
		bridgeUnavailable: bridge.isUnavailable,
		bridgeLoading: bridge.isLoading,
		exeChoices,
		selectBridgeExe,
		loadBridgeExes,
		localeEmulator,
		setLocaleEmulator,
		forceExeSelection,
		isBridgeBusy:
			bridge.isFetchingGame ||
			bridge.isCancellingGame ||
			bridge.isLaunchingBridgeGame,
	};
}
