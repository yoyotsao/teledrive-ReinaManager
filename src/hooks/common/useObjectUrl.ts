import { useEffect, useState } from "react";

/**
 * 为 Blob 建立仅属于当前 Hook 使用者的 object URL。
 * URL 会在 Blob 切换或组件卸载时撤销；呼叫端只缓存 Blob，不缓存 object URL。
 */
export function useObjectUrl(
	blob: Blob | null | undefined,
): string | undefined {
	const [url, setUrl] = useState<string>();

	useEffect(() => {
		if (!blob) {
			setUrl(undefined);
			return;
		}

		const objectUrl = URL.createObjectURL(blob);
		setUrl(objectUrl);
		return () => URL.revokeObjectURL(objectUrl);
	}, [blob]);

	return url;
}
