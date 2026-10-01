import type { ImgHTMLAttributes } from "react";
import { useProxiedImageUrl } from "@/hooks/queries/useProxiedImageUrl";

type ProxiedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	src: string | null | undefined;
};

export function ProxiedImage({
	src,
	alt = "",
	...imgProps
}: ProxiedImageProps) {
	const resolved = useProxiedImageUrl(src);
	return <img {...imgProps} src={resolved} alt={alt} />;
}
