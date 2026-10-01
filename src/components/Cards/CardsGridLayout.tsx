import {
	type CSSProperties,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

const MIN_CARD_WIDTH = 160;
const GRID_GAP = 16;
const MAX_COLUMNS = 10;

export const CARDS_GRID_CLASS =
	"grid gap-4 [grid-template-columns:repeat(var(--cards-grid-columns),minmax(0,1fr))]";

export function useCardsGridLayout(wrapperRef?: RefObject<HTMLDivElement>) {
	const localRef = useRef<HTMLDivElement>(null);
	const gridRef = wrapperRef ?? localRef;
	const [columns, setColumns] = useState<number | null>(null);

	useLayoutEffect(() => {
		const container = gridRef.current;
		if (!container) return;

		const updateColumns = (width: number) => {
			// 按容器的 CSS 宽度排布，缩放和侧栏变化都应影响列数；间距与 gap-4 一致。
			setColumns(
				Math.max(
					1,
					Math.min(
						MAX_COLUMNS,
						Math.floor((width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)),
					),
				),
			);
		};

		updateColumns(container.clientWidth);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) updateColumns(entry.contentRect.width);
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, [gridRef]);

	const gridStyle = {
		"--cards-grid-columns": columns ?? 1,
	} as CSSProperties;

	return { columns, gridRef, gridStyle };
}
