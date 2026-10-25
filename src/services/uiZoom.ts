import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useStore } from "@/store/appStore";

export const MIN_UI_ZOOM_PERCENT = 80;
export const MAX_UI_ZOOM_PERCENT = 150;
export const UI_ZOOM_PRESETS = [
	MIN_UI_ZOOM_PERCENT,
	90,
	100,
	110,
	125,
	MAX_UI_ZOOM_PERCENT,
];

export async function applyUiZoom(percent: number): Promise<void> {
	const nextPercent = Number.isFinite(percent)
		? Math.min(MAX_UI_ZOOM_PERCENT, Math.max(MIN_UI_ZOOM_PERCENT, percent))
		: 100;
	await getCurrentWebview().setZoom(nextPercent / 100);
	useStore.getState().setZoomPercent(nextPercent);
}
