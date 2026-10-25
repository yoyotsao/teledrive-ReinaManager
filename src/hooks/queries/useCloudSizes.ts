/**
 * @file 雲端遊戲 zip 大小 Query
 * @description 一次列出 TeleDrive 遊戲資料夾取得全部大小，所有詳情頁共用同一份快取。
 */

import { useQuery } from "@tanstack/react-query";
import { isWebRuntime } from "@/services/platform";
import { getScanSizes } from "@/services/web/scan";

export const cloudSizeKeys = {
	all: ["cloud", "sizes"] as const,
};

/** 回傳指定 `teledrive_path` 的 zip 大小；桌面版、查不到或載入中為 undefined。 */
export function useCloudGameSize(teledrivePath?: string | null) {
	const query = useQuery({
		queryKey: cloudSizeKeys.all,
		queryFn: getScanSizes,
		enabled: isWebRuntime() && Boolean(teledrivePath),
		// 大小極少變動，且每次都要走 TeleDrive 列表，放寬快取。
		staleTime: 10 * 60_000,
		retry: false,
	});
	return teledrivePath ? query.data?.[teledrivePath] : undefined;
}
