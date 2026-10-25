import { useQuery } from "@tanstack/react-query";
import { useObjectUrl } from "@/hooks/common/useObjectUrl";
import { getCoverBlob } from "@/services/web/covers";

export const COVER_GC_TIME = 30 * 60_000;

export const coverKeys = {
	cover: (gameId: number, version: string) =>
		["cover", gameId, version] as const,
};

/**
 * 取得封面的 object URL。
 * React Query 只缓存 Blob；每个使用者透过 useObjectUrl 建立自己的 URL，
 * 避免一个组件卸载时撤销其他组件仍在使用的 URL。
 */
export function useCoverUrl(
	gameId: number,
	version: string | null,
): string | undefined {
	const { data: blob } = useQuery({
		queryKey: coverKeys.cover(gameId, version ?? ""),
		queryFn: ({ signal }) => getCoverBlob(gameId, version as string, signal),
		enabled: version !== null,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: COVER_GC_TIME,
	});

	return useObjectUrl(blob);
}
