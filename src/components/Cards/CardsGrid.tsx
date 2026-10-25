import { memo } from "react";
import type { GameData } from "@/types";
import { GameCardItem } from "./CardItem";
import { CARDS_GRID_CLASS, useCardsGridLayout } from "./CardsGridLayout";
import { useCardsController } from "./useCardsController";

interface CardsGridProps {
	gameIds: number[];
	displayById: Map<number, GameData>;
	categoryId?: number;
}

/**
 * CardsGrid - 普通卡片布局。
 *
 * 接收 ID 数组和展示索引，渲染时按 ID 取 GameData。
 */
export const CardsGrid = memo(
	({ gameIds, displayById, categoryId }: CardsGridProps) => {
		const { gridRef, gridStyle } = useCardsGridLayout();
		const { controls, getCardProps } = useCardsController({
			gameIds,
			categoryId,
		});

		return (
			<>
				{controls}
				<div ref={gridRef} className="flex-1 min-h-0 min-w-0">
					<div className={`${CARDS_GRID_CLASS} text-center`} style={gridStyle}>
						{gameIds.map((gameId) => {
							const game = displayById.get(gameId);
							if (!game) return null;
							return (
								<GameCardItem
									key={gameId}
									game={game}
									getCardProps={getCardProps}
								/>
							);
						})}
					</div>
				</div>
			</>
		);
	},
);

CardsGrid.displayName = "CardsGrid";
