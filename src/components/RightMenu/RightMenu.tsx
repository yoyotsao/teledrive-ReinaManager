/**
 * @file RightMenu 组件
 * @description 游戏卡片右键菜单组件，支持启动游戏、进入详情、删除、打开文件夹等操作，集成国际化和删除确认弹窗。
 * @module src/components/RightMenu/index
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - RightMenu：游戏卡片右键菜单组件
 * - CollectionRightMenu：分组/分类右键菜单组件
 *
 * 依赖：
 * - @mui/icons-material
 * - @/store
 * - @/utils
 * - @/components/AlertBox
 * - react-i18next
 * - @tauri-apps/api/core
 */

import ArticleIcon from "@mui/icons-material/Article";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import SyncIcon from "@mui/icons-material/Sync";
import {
	Divider,
	ListItemIcon,
	ListItemText,
	MenuItem,
	MenuList,
} from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertConfirmBox } from "@/components/AlertBox";
import { LinkWithScrollSave } from "@/components/LinkWithScrollSave";
import { useGameById } from "@/hooks/features/games/useGameFacade";
import { useGameStatusActions } from "@/hooks/features/games/useGameStatusActions";
import { useDeleteGame } from "@/hooks/queries/useGames";
import { handleOpenFolder } from "@/services/fs/fileDialog";
import { platformCapabilities } from "@/services/platform";
import { useStore } from "@/store/appStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData } from "@/types";
import type { PlayStatus } from "@/types/collection";
import { BaseRightMenu } from "./BaseRightMenu";
import { PlayStatusSubmenu } from "./PlayStatusSubmenu";

/**
 * RightMenu 组件属性类型
 */
interface RightMenuProps {
	id: number;
	anchorPosition: { top: number; left: number };
	onClose: () => void;
	onLaunchGame: (game: GameData) => void | Promise<void>;
}

/**
 * 游戏卡片右键菜单组件
 * 支持启动、详情、删除、打开文件夹等操作
 *
 * @param {RightMenuProps} props 组件属性
 * @returns {JSX.Element | null} 右键菜单
 */
const RightMenu: React.FC<RightMenuProps> = ({
	anchorPosition,
	onClose,
	id,
	onLaunchGame,
}) => {
	const setSelectedGameId = useStore((state) => state.setSelectedGameId);
	const deleteGameMutation = useDeleteGame();
	const { selectedGame } = useGameById(id);
	const isGameRunning = useGamePlayStore((s) => s.isGameRunning);
	const [openAlert, setOpenAlert] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const { t } = useTranslation();
	const hasLocalPath = Boolean(selectedGame?.localpath);

	// 使用 Feature Facade 更新游戏状态
	const { updatePlayStatus } = useGameStatusActions();

	const isThisGameCanRun = Boolean(selectedGame) && !isGameRunning(id);

	/**
	 * 删除游戏操作，带删除确认弹窗
	 */
	const handleDeleteGame = async () => {
		try {
			setIsDeleting(true);
			onClose();
			await deleteGameMutation.mutateAsync(id);
			setSelectedGameId(null);
		} catch (error) {
			console.error("删除游戏失败:", error);
		} finally {
			onClose();
			setIsDeleting(false);
			setOpenAlert(false);
		}
	};

	/**
	 * 更新游戏状态
	 */
	const handlePlayStatusChange = (newStatus: PlayStatus) => {
		updatePlayStatus(
			{ gameId: id, newStatus },
			{
				invalidateScope: "all",
			},
		);
	};

	return (
		<BaseRightMenu
			isopen
			anchorPosition={anchorPosition}
			onClose={onClose}
			ariaLabel={t("components.RightMenu.label", "右键菜单")}
		>
			{/* 删除确认弹窗 */}
			<AlertConfirmBox
				open={openAlert}
				setOpen={setOpenAlert}
				onConfirm={handleDeleteGame}
				isLoading={isDeleting}
			/>

			<MenuList sx={{ py: 1 }}>
				{/* 启动游戏 */}
				{platformCapabilities.nativeLaunch && (
					<MenuItem
						disabled={!isThisGameCanRun}
						onClick={() => {
							if (selectedGame) {
								void onLaunchGame(selectedGame);
							}
							onClose();
						}}
					>
						<ListItemIcon>
							{hasLocalPath ? <PlayCircleOutlineIcon /> : <SyncIcon />}
						</ListItemIcon>
						<ListItemText
							primary={
								hasLocalPath
									? t("components.RightMenu.startGame", "启动游戏")
									: t("components.LaunchModal.syncLocalPath", "同步本地")
							}
						/>
					</MenuItem>
				)}

				{/* 进入详情 */}
				<LinkWithScrollSave
					to={`/libraries/${id}`}
					style={{ textDecoration: "none", color: "inherit" }}
				>
					<MenuItem>
						<ListItemIcon>
							<ArticleIcon />
						</ListItemIcon>
						<ListItemText
							primary={t("components.RightMenu.enterDetails", "进入详情页")}
						/>
					</MenuItem>
				</LinkWithScrollSave>

				{/* 删除游戏 */}
				<MenuItem onClick={() => setOpenAlert(true)}>
					<ListItemIcon>
						<DeleteIcon />
					</ListItemIcon>
					<ListItemText
						primary={t("components.RightMenu.deleteGame", "删除游戏")}
					/>
				</MenuItem>

				<Divider />

				{/* 打开游戏文件夹 */}
				{platformCapabilities.nativePaths && (
					<MenuItem
						disabled={!hasLocalPath}
						onClick={() => {
							if (hasLocalPath && selectedGame) {
								handleOpenFolder(selectedGame);
							}
							onClose();
						}}
					>
						<ListItemIcon>
							<FolderOpenIcon />
						</ListItemIcon>
						<ListItemText
							primary={t("components.RightMenu.openGameFolder", "打开游戏目录")}
						/>
					</MenuItem>
				)}

				{/* 游戏状态切换 - 二级菜单 */}
				<PlayStatusSubmenu
					currentStatus={selectedGame?.clear}
					onStatusChange={handlePlayStatusChange}
				/>
			</MenuList>
		</BaseRightMenu>
	);
};

export default RightMenu;
