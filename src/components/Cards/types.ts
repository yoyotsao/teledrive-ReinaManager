import type React from "react";
import type { GameData } from "@/types";

export interface CardInteraction {
	onContextMenu?: (event: React.MouseEvent) => void;
	onClick: () => void;
	onDoubleClick?: () => void;
	useDelayedClick?: boolean;
}

export interface CardBatchState {
	selected: boolean;
}

export interface CardRemoveAction {
	title: string;
	onRemove: () => void;
}

export interface CardSortFieldOverlay {
	value: string;
}

export interface CardItemProps extends React.HTMLAttributes<HTMLDivElement> {
	game: GameData;
	displayName: string;
	sortFieldOverlay?: CardSortFieldOverlay;
	interaction?: CardInteraction;
	batch?: CardBatchState;
	removeAction?: CardRemoveAction;
	isOverlay?: boolean;
	isDragging?: boolean;
}

/** 列表只传稳定的游戏引用与属性工厂，避免顺序变化时重新创建卡片交互。 */
export interface GameCardItemProps {
	game: GameData;
	getCardProps: (game: GameData) => CardItemProps;
	isOverlay?: boolean;
	isDragging?: boolean;
}

export interface SortableCardItemProps extends GameCardItemProps {
	/** 是否禁用拖拽排序 */
	disabledSortable?: boolean;
}

/** 右键菜单位置状态 */
export interface MenuPosition {
	mouseX: number;
	mouseY: number;
	cardId: number;
}

/** 右键菜单控制器 */
export interface RightMenuHostHandle {
	open: (cardId: number, mouseX: number, mouseY: number) => void;
	close: () => void;
}
