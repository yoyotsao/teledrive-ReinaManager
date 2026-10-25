/**
 * @file LaunchModal 组件
 * @description 游戏启动弹窗组件，负责判断游戏是否可启动、是否正在运行，并提供启动按钮，支持国际化。
 * @module src/components/LaunchModal/index
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - LaunchModal：游戏启动弹窗组件
 */

import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import SyncIcon from "@mui/icons-material/Sync";
import TimerIcon from "@mui/icons-material/Timer";
import {
	Button,
	Checkbox,
	FormControlLabel,
	LinearProgress,
	Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { SelectedGameGuard } from "@/components/SelectedGameGuard";
import { useGameLaunchFlow } from "@/hooks/features/games/useGameLaunchFlow";
import { snackbar } from "@/providers/snackBar";
import { isWebRuntime } from "@/services/platform";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData } from "@/types";
import { getUserErrorMessage } from "@/utils/errors";

/**
 * 格式化游戏时长显示
 * @param minutes 分钟数
 * @param seconds 秒数
 * @returns 格式化的时长字符串，如 "1:23:45" 或 "23:45" 或 "0:05"
 */
const formatPlayTime = (minutes: number, seconds: number): string => {
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	const secs = seconds;

	if (hours > 0) {
		return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
	}
	return `${mins}:${secs.toString().padStart(2, "0")}`;
};

/**
 * LaunchModal 组件
 * 判断游戏是否可启动、是否正在运行，并渲染启动按钮。
 * 仅本地游戏且未运行时可启动。
 * 运行时显示实时游戏时长。
 * 支持两种计时模式：
 * - playtime: 真实游戏时间（仅活跃时间，通过后端事件更新）
 * - elapsed: 游戏启动时间（从启动到现在的总时间，前端计时器计算）
 *
 * @returns {JSX.Element} 启动按钮或运行中提示
 */
export const LaunchModal = ({ game }: { game?: GameData } = {}) => {
	const { t } = useTranslation();
	const disabledFallback = (
		<Button startIcon={<PlayArrowIcon />} disabled>
			{t("components.LaunchModal.launchGame", "启动游戏")}
		</Button>
	);

	if (game) return <LaunchModalContent selectedGame={game} />;

	return (
		<SelectedGameGuard
			fallback={disabledFallback}
			loadingFallback={disabledFallback}
			notFoundFallback={disabledFallback}
		>
			{(selectedGame) => <LaunchModalContent selectedGame={selectedGame} />}
		</SelectedGameGuard>
	);
};

interface LaunchModalContentProps {
	selectedGame: GameData;
}

function LaunchModalContent({ selectedGame }: LaunchModalContentProps) {
	const { t } = useTranslation();
	const selectedGameId = selectedGame.id;
	const {
		launchGame,
		syncLocalPath,
		bridgeState,
		bridgeError,
		bridgeIsError,
		bridgeUnavailable,
		bridgeLoading,
		exeChoices,
		selectBridgeExe,
		loadBridgeExes,
		localeEmulator,
		setLocaleEmulator,
		forceExeSelection,
		isBridgeBusy,
	} = useGameLaunchFlow(selectedGame);
	const { stopGame, isThisGameRunning, realTimeState } = useGamePlayStore(
		useShallow((s) => ({
			stopGame: s.stopGame,
			isThisGameRunning: s.runningGameIds.has(selectedGameId),
			realTimeState: s.gameRealTimeStates[selectedGameId] ?? null,
		})),
	);
	const hasLocalPath = Boolean(selectedGame.localpath);
	const sessionTimeTrackingMode = realTimeState?.timeTrackingMode;

	// 用于 elapsed 模式下的前端计时器显示
	const timerRef = useRef<HTMLSpanElement>(null);
	const [stopping, setStopping] = useState(false);

	useEffect(() => {
		if (
			sessionTimeTrackingMode !== "elapsed" ||
			!isThisGameRunning ||
			!realTimeState?.startTime
		) {
			return;
		}

		const startTime = realTimeState.startTime;

		const updateDisplay = () => {
			if (!timerRef.current) return;

			const now = Math.floor(Date.now() / 1000);
			const elapsed = now - startTime;
			const minutes = Math.floor(elapsed / 60);
			const seconds = elapsed % 60;
			timerRef.current.textContent = formatPlayTime(minutes, seconds);
		};

		updateDisplay();

		const intervalId = setInterval(updateDisplay, 1000);

		return () => {
			clearInterval(intervalId);
		};
	}, [sessionTimeTrackingMode, isThisGameRunning, realTimeState?.startTime]);

	const handleStartGame = () => {
		void launchGame(selectedGame);
	};

	if (isWebRuntime()) {
		const teledrivePath = selectedGame.teledrive_path;
		const button = (label: string, onClick?: () => void, disabled = false) => (
			<Button
				startIcon={<PlayArrowIcon />}
				onClick={onClick}
				disabled={disabled || !onClick}
				className="rounded-2xl"
			>
				{label}
			</Button>
		);
		if (!teledrivePath) {
			return (
				<div className="flex flex-col items-start gap-1">
					{button(
						t(
							"components.LaunchModal.bridgePathMissing",
							"未配置 TeleDrive 游戏路径",
						),
					)}
					<Typography variant="caption" color="text.secondary">
						{t(
							"components.LaunchModal.bridgeActionsUnaffected",
							"游戏资料编辑、扫描和封面功能仍可使用",
						)}
					</Typography>
				</div>
			);
		}
		if (bridgeLoading) {
			return button(
				t("components.LaunchModal.bridgeChecking", "正在连接本机 bridge…"),
			);
		}
		if (bridgeIsError || bridgeUnavailable || !bridgeState) {
			const message = bridgeUnavailable
				? t(
						"components.LaunchModal.bridgeUnavailable",
						"本机 bridge 不可用，请启动服务并检查浏览器权限",
					)
				: bridgeError &&
						(bridgeError as { code?: string }).code ===
							"bridge_permission_denied"
					? t(
							"components.LaunchModal.bridgePermissionDenied",
							"本机 bridge 拒绝访问",
						)
					: t(
							"components.LaunchModal.bridgeStatusUnavailable",
							"无法读取本机 bridge 状态",
						);
			return (
				<div className="flex flex-col items-start gap-1">
					{button(message)}
					<Typography variant="caption" color="text.secondary">
						{t(
							"components.LaunchModal.bridgeActionsUnaffected",
							"游戏资料编辑、扫描和封面功能仍可使用",
						)}
					</Typography>
				</div>
			);
		}

		const state = bridgeState;
		const selectedExe = selectedGame.exe_relpath;
		const canUseLocaleEmulator = state.capabilities?.locale_emulator === true;
		const progress =
			state.total_bytes > 0
				? Math.min(100, (state.completed_bytes / state.total_bytes) * 100)
				: 0;
		const formatBytes = (bytes: number) => {
			if (bytes < 1024) return `${bytes} B`;
			const units = ["KB", "MB", "GB", "TB"];
			let size = bytes / 1024;
			let unit = 0;
			while (size >= 1024 && unit < units.length - 1) {
				size /= 1024;
				unit += 1;
			}
			return `${size.toFixed(1)} ${units[unit]}`;
		};
		const formatElapsed = (seconds: number) =>
			formatPlayTime(Math.floor(seconds / 60), seconds % 60);

		if (state.status === "running") {
			return (
				<Button startIcon={<TimerIcon />} disabled className="rounded-2xl">
					{t("components.LaunchModal.bridgeRunning", "运行中")}{" "}
					{formatElapsed(state.elapsed_seconds)}
				</Button>
			);
		}
		if (state.status === "downloading") {
			return (
				<div className="flex min-w-52 flex-col gap-1">
					<Typography variant="caption">
						{t("components.LaunchModal.bridgeDownloading", "正在下载")}{" "}
						{formatBytes(state.completed_bytes)} /{" "}
						{formatBytes(state.total_bytes)}
					</Typography>
					<LinearProgress variant="determinate" value={progress} />
					<Button
						onClick={handleStartGame}
						disabled={isBridgeBusy}
						color="error"
					>
						{t("components.LaunchModal.bridgeCancelDownload", "取消下载")}
					</Button>
				</div>
			);
		}
		if (state.status === "absent" || state.status === "incomplete") {
			return (
				<div className="flex flex-col items-start gap-1">
					{state.status === "incomplete" && state.error && (
						<Typography variant="caption" color="error">
							{state.error}
						</Typography>
					)}
					<Button
						startIcon={<SyncIcon />}
						onClick={handleStartGame}
						disabled={isBridgeBusy}
					>
						{state.status === "incomplete"
							? t("components.LaunchModal.bridgeResumeDownload", "继续下载")
							: t("components.LaunchModal.bridgeDownload", "下载到本机")}
					</Button>
				</div>
			);
		}

		if (forceExeSelection || !selectedExe) {
			return (
				<div className="flex flex-col items-start gap-1">
					{exeChoices ? (
						<select
							className="max-w-80 rounded border border-[--mui-palette-divider] bg-[--mui-palette-background-paper] p-2"
							aria-label={t(
								"components.LaunchModal.bridgeSelectExe",
								"选择可执行文件",
							)}
							defaultValue=""
							onChange={(event) => {
								if (event.target.value) {
									void selectBridgeExe(selectedGame, event.target.value);
								}
							}}
						>
							<option value="" disabled>
								{t("components.LaunchModal.bridgeSelectExe", "选择可执行文件")}
							</option>
							{exeChoices.map((exe) => (
								<option key={exe} value={exe}>
									{exe}
								</option>
							))}
						</select>
					) : (
						<Button
							startIcon={<SyncIcon />}
							onClick={() => void loadBridgeExes(teledrivePath)}
							disabled={isBridgeBusy}
						>
							{t("components.LaunchModal.bridgeChooseExe", "选择可执行文件")}
						</Button>
					)}
					{canUseLocaleEmulator && (
						<FormControlLabel
							control={
								<Checkbox
									checked={localeEmulator}
									onChange={(event) => setLocaleEmulator(event.target.checked)}
								/>
							}
							label={t(
								"components.LaunchModal.bridgeLocaleEmulator",
								"使用 Locale Emulator",
							)}
						/>
					)}
				</div>
			);
		}
		return (
			<div className="flex flex-col items-start gap-1">
				<Button
					startIcon={<PlayArrowIcon />}
					onClick={handleStartGame}
					disabled={isBridgeBusy}
				>
					{t("components.LaunchModal.launchGame", "启动游戏")}
				</Button>
				{canUseLocaleEmulator && (
					<FormControlLabel
						control={
							<Checkbox
								checked={localeEmulator}
								onChange={(event) => setLocaleEmulator(event.target.checked)}
							/>
						}
						label={t(
							"components.LaunchModal.bridgeLocaleEmulator",
							"使用 Locale Emulator",
						)}
					/>
				)}
			</div>
		);
	}

	const handleSyncLocalPath = () => {
		void syncLocalPath(selectedGame);
	};

	const handleStopGame = async () => {
		setStopping(true);
		try {
			const res = await stopGame(selectedGameId);
			if (!res.success) {
				snackbar.error(
					res.message ||
						t("components.LaunchModal.stopFailed", "游戏停止失败:"),
				);
			}
		} catch (error) {
			snackbar.error(
				`${t("components.LaunchModal.stopFailed", "游戏停止失败:")}: ${getUserErrorMessage(error, t)}`,
			);
		} finally {
			setStopping(false);
		}
	};

	const content = (() => {
		if (stopping) {
			return (
				<Button startIcon={<StopIcon />} disabled>
					{t("components.LaunchModal.stoppingGame", "停止游戏中...")}
				</Button>
			);
		}

		if (isThisGameRunning && realTimeState) {
			const { currentSessionMinutes, currentSessionSeconds } = realTimeState;
			const initialTimeDisplay = formatPlayTime(
				currentSessionMinutes,
				currentSessionSeconds,
			);

			const elapsedInitial = realTimeState.startTime
				? Math.floor(Date.now() / 1000) - realTimeState.startTime
				: 0;
			const elapsedInitialDisplay = formatPlayTime(
				Math.floor(elapsedInitial / 60),
				elapsedInitial % 60,
			);

			return (
				<Button
					startIcon={<StopIcon />}
					onClick={handleStopGame}
					className="rounded-2xl"
					color="error"
					variant="outlined"
				>
					<TimerIcon fontSize="small" color="disabled" />
					<Typography
						ref={timerRef}
						className="ml-1"
						variant="button"
						component="span"
						color="textDisabled"
						sx={{ fontVariantNumeric: "tabular-nums" }}
					>
						{sessionTimeTrackingMode === "elapsed"
							? elapsedInitialDisplay
							: initialTimeDisplay}
					</Typography>
				</Button>
			);
		}

		switch (selectedGame.launch_type ?? "local") {
			case "steam":
				return hasLocalPath ? (
					<Button startIcon={<PlayArrowIcon />} onClick={handleStartGame}>
						{t("components.LaunchModal.launchWithSteam", "通过 Steam 启动")}
					</Button>
				) : (
					<Button startIcon={<PlayArrowIcon />} disabled>
						{t(
							"components.LaunchModal.steamMonitorPathMissing",
							"Steam 游戏监控目录缺失，请重新关联",
						)}
					</Button>
				);
			case "local":
				return hasLocalPath ? (
					<Button startIcon={<PlayArrowIcon />} onClick={handleStartGame}>
						{t("components.LaunchModal.launchGame", "启动游戏")}
					</Button>
				) : (
					<Button
						startIcon={<SyncIcon />}
						onClick={handleSyncLocalPath}
						variant="text"
					>
						{t("components.LaunchModal.syncLocalPath", "同步本地")}
					</Button>
				);
		}
	})();

	return content;
}
