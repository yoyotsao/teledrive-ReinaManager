import {
	type DragEndEvent,
	type DragStartEvent,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReorderCategoryGames } from "@/hooks/queries/useCollections";
import { snackbar } from "@/providers/snackBar";

/**
 * 拖拽排序 Hook - 管理拖拽相关状态和逻辑
 *
 * 操作纯 ID 数组，不再依赖完整 GameData 对象。
 */
export function useDragSort(options: {
	gameIds: number[];
	categoryId?: number;
	enabled: boolean;
}) {
	const { gameIds, categoryId, enabled } = options;
	const { t } = useTranslation();
	const reorderCategoryGamesMutation = useReorderCategoryGames();

	const [activeId, setActiveId] = useState<number | null>(null);
	const [pendingOrder, setPendingOrder] = useState<{
		sourceIds: number[];
		ids: number[];
	} | null>(null);
	// 松手后的第一帧先采用目标顺序，Query 通知到达后交还显示控制权。
	const ids =
		enabled && pendingOrder?.sourceIds === gameIds ? pendingOrder.ids : gameIds;
	const savingRef = useRef(false);
	useEffect(() => {
		setPendingOrder((order) =>
			order && order.sourceIds !== gameIds ? null : order,
		);
	}, [gameIds]);
	useEffect(() => {
		if (!enabled) setActiveId(null);
	}, [enabled]);

	// 传感器配置
	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: 10 },
		}),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 250, tolerance: 5 },
		}),
	);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			if (!enabled || savingRef.current) return;
			setActiveId(event.active.id as number);
		},
		[enabled],
	);

	const handleDragCancel = useCallback(() => {
		setActiveId(null);
	}, []);

	const handleDragEnd = useCallback(
		async (event: DragEndEvent) => {
			const { active, over } = event;
			setActiveId(null);
			if (
				!enabled ||
				savingRef.current ||
				!over ||
				active.id === over.id ||
				!categoryId
			) {
				return;
			}

			const oldIndex = ids.indexOf(active.id as number);
			const newIndex = ids.indexOf(over.id as number);

			if (oldIndex !== -1 && newIndex !== -1) {
				const newIds = arrayMove(ids, oldIndex, newIndex);
				setPendingOrder({ sourceIds: gameIds, ids: newIds });

				try {
					savingRef.current = true;
					await reorderCategoryGamesMutation.mutateAsync({
						categoryId,
						gameIds: newIds,
					});
				} catch (error) {
					setPendingOrder(null);
					console.error("排序更新失败:", error);
					snackbar.error(
						t("pages.Collection.gameSort.saveFailed", "排序保存失败，请重试"),
					);
				} finally {
					savingRef.current = false;
				}
			}
		},
		[gameIds, ids, enabled, categoryId, reorderCategoryGamesMutation, t],
	);

	return {
		isSaving: reorderCategoryGamesMutation.isPending,
		ids,
		activeId,
		sensors,
		handleDragStart,
		handleDragCancel,
		handleDragEnd,
	};
}
