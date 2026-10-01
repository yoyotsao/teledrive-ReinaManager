export type AddModalTab = "single" | "bulk" | "cloud" | "collection";

// cloud：网页版云端扫描（TeleDrive）；collection：桌面版云端收藏导入（上游功能）

/** 依執行環境決定新增對話框可用分頁；網頁版不提供本機路徑功能。 */
export function availableAddModalTabs(isWeb: boolean): AddModalTab[] {
	return isWeb ? ["cloud", "single"] : ["single", "bulk", "collection"];
}

/** 對話框開啟時的預設分頁。 */
export function defaultAddModalTab(isWeb: boolean): AddModalTab {
	return availableAddModalTabs(isWeb)[0];
}
