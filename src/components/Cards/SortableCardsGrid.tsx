import {
	closestCenter,
	DndContext,
	DragOverlay,
	type DragStartEvent,
} from "@dnd-kit/core";
import {
	rectSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useCallback, useMemo } from "react";
import { useGridScrollPosition } from "@/hooks/common/useScrollRestore";
import type { GameData } from "@/types";
import { GameCardItem } from "./CardItem";
import { CARDS_GRID_CLASS, useCardsGridLayout } from "./CardsGridLayout";
import type { GameCardItemProps, SortableCardItemProps } from "./types";
import type { useDragSort } from "./useDragSort";

interface SortableCardsGridProps {
	dragSort: ReturnType<typeof useDragSort>;
	displayById: Map<number, GameData>;
	getCardProps: GameCardItemProps["getCardProps"];
	closeContextMenu: () => void;
	scrollRestoreKey: string;
}

const SortableCardItem = memo((props: SortableCardItemProps) => {
	const { game, getCardProps, disabledSortable } = props;

	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: game.id, disabled: disabledSortable });

	const style = useMemo(
		() => ({
			transform: CSS.Transform.toString(transform),
			transition,
			zIndex: isDragging ? 1000 : ("auto" as const),
		}),
		[transform, transition, isDragging],
	);

	return (
		<div
			ref={setNodeRef}
			style={style}
			// 落下动画会恢复内联 opacity；用类隐藏源卡片，避免覆盖下一次拖拽的状态。
			className={`relative min-w-0 ${isDragging ? "opacity-0" : ""}`}
			{...(!disabledSortable ? attributes : {})}
			{...(!disabledSortable ? listeners : {})}
		>
			<GameCardItem
				game={game}
				getCardProps={getCardProps}
				isDragging={isDragging}
			/>
		</div>
	);
});

SortableCardItem.displayName = "SortableCardItem";

/**
 * SortableCardsGrid - 拖拽卡片布局。
 *
 * 接收 ID 数组和展示索引，渲染时按 ID 取 GameData。
 */
export const SortableCardsGrid = memo(
	({
		dragSort,
		displayById,
		getCardProps,
		closeContextMenu,
		scrollRestoreKey,
	}: SortableCardsGridProps) => {
		const { wrapperRef } = useGridScrollPosition({
			scrollKey: scrollRestoreKey,
			trackFullGrid: true,
		});
		const { gridStyle } = useCardsGridLayout(wrapperRef);
		const {
			ids,
			activeId,
			sensors,
			handleDragStart,
			handleDragCancel,
			handleDragEnd,
			isSaving,
		} = dragSort;
		const isDragSortEnabled = !isSaving;
		const handleGridDragStart = useCallback(
			(event: DragStartEvent) => {
				closeContextMenu();
				handleDragStart(event);
			},
			[closeContextMenu, handleDragStart],
		);

		return (
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragStart={isDragSortEnabled ? handleGridDragStart : undefined}
				onDragCancel={handleDragCancel}
				onDragEnd={isDragSortEnabled ? handleDragEnd : undefined}
			>
				<SortableContext items={ids} strategy={rectSortingStrategy}>
					<div ref={wrapperRef} className="flex-1 min-h-0 min-w-0">
						<div
							className={`${CARDS_GRID_CLASS} text-center`}
							style={gridStyle}
						>
							{ids.map((gameId) => {
								const game = displayById.get(gameId);
								if (!game) return null;
								return (
									<SortableCardItem
										key={gameId}
										game={game}
										getCardProps={getCardProps}
										disabledSortable={!isDragSortEnabled}
									/>
								);
							})}
						</div>
					</div>
				</SortableContext>
				{/* 预览只负责显示，不抢占落点卡片的悬停状态。 */}
				<DragOverlay className="pointer-events-none">
					{activeId &&
						(() => {
							const activeGame = displayById.get(activeId);
							if (!activeGame) return null;
							return (
								<GameCardItem
									game={activeGame}
									getCardProps={getCardProps}
									isOverlay
								/>
							);
						})()}
				</DragOverlay>
			</DndContext>
		);
	},
);

SortableCardsGrid.displayName = "SortableCardsGrid";
