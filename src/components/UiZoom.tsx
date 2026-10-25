import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { applyUiZoom } from "@/services/uiZoom";
import { useStore } from "@/store/appStore";
import { isWindowsPlatform } from "@/utils/tauriProtocol";

export const UiZoom = () => {
	const [feedbackPercent, setFeedbackPercent] = useState<number | null>(null);

	useEffect(() => {
		if (!isTauri() || !isWindowsPlatform) return;

		let disposed = false;
		let restoring = true;
		let unlisten: (() => void) | undefined;
		let feedbackTimeout: number | undefined;
		const savedPercent = useStore.getState().zoomPercent;
		const unsubscribeStore = useStore.subscribe((state, previousState) => {
			if (restoring || state.zoomPercent === previousState.zoomPercent) return;
			setFeedbackPercent(state.zoomPercent);
			window.clearTimeout(feedbackTimeout);
			feedbackTimeout = window.setTimeout(() => setFeedbackPercent(null), 1500);
		});

		void (async () => {
			try {
				unlisten = await listen<number>("webview-zoom-changed", (event) => {
					if (disposed || restoring) return;
					const percent = event.payload;
					if (!Number.isFinite(percent) || percent <= 0) return;
					useStore.getState().setZoomPercent(percent);
				});
				if (disposed) {
					unlisten();
					return;
				}
			} catch (error) {
				console.error("监听界面缩放失败:", error);
			}
			try {
				if (!disposed) await applyUiZoom(savedPercent);
			} catch (error) {
				console.error("恢复界面缩放失败:", error);
			} finally {
				restoring = false;
			}
		})();

		return () => {
			disposed = true;
			unsubscribeStore();
			unlisten?.();
			window.clearTimeout(feedbackTimeout);
		};
	}, []);

	if (feedbackPercent === null) return null;

	return (
		<div
			role="status"
			className="pointer-events-none fixed top-4 right-4 z-[1600] rounded-xl border border-solid border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-paper)] px-4 py-2 text-base font-semibold text-[var(--mui-palette-text-primary)] shadow-lg"
		>
			{feedbackPercent}%
		</div>
	);
};
