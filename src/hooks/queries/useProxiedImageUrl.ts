import { useQuery } from "@tanstack/react-query";
import { useObjectUrl } from "@/hooks/common/useObjectUrl";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { isWebRuntime } from "@/services/platform";
import { getMetadataImageBlob } from "@/services/web/metadataImage";

export const METADATA_IMAGE_GC_TIME = 5 * 60_000;

export const metadataImageKeys = {
	image: (url: string) => ["server", "metadata-image", url] as const,
};

function needsServerProxy(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/** 外部來源圖片：桌面版沿用 reina-image，網頁版經 reina-server 代理。 */
export function useProxiedImageUrl(
	url: string | null | undefined,
): string | undefined {
	const web = isWebRuntime();
	const resolveDesktop = useProxyImageUrlResolver();
	const proxied = web && Boolean(url) && needsServerProxy(url as string);

	const { data: blob } = useQuery({
		queryKey: metadataImageKeys.image(url ?? ""),
		queryFn: ({ signal }) => getMetadataImageBlob(url as string, signal),
		enabled: proxied,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: METADATA_IMAGE_GC_TIME,
		retry: false,
	});
	const objectUrl = useObjectUrl(proxied ? blob : undefined);

	if (!url) return undefined;
	if (!web) return resolveDesktop(url);
	return proxied ? objectUrl : url;
}
