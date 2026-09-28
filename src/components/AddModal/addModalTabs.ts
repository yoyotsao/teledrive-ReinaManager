export type AddModalTab = "single" | "bulk" | "cloud";

/** 依執行環境決定新增對話框可用分頁；網頁版不提供本機路徑功能。 */
export function availableAddModalTabs(isWeb: boolean): AddModalTab[] {
	return isWeb ? ["cloud", "single"] : ["single", "bulk"];
}

/** 對話框開啟時的預設分頁。 */
export function defaultAddModalTab(isWeb: boolean): AddModalTab {
	return availableAddModalTabs(isWeb)[0];
}
