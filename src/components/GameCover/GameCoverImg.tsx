import type { ImgHTMLAttributes } from "react";
import { useGameCoverSrc } from "@/hooks/features/games/useGameCoverSrc";
import type { GameData } from "@/types";

type GameCoverImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	game: GameData;
	replaceNsfwCover?: boolean;
};

/** 清单或循环里的封面组件；每个 img 独立持有 object URL 生命周期。 */
export function GameCoverImg({
	game,
	replaceNsfwCover = false,
	alt = "",
	...imgProps
}: GameCoverImgProps) {
	const src = useGameCoverSrc(game, replaceNsfwCover);
	return <img {...imgProps} src={src} alt={alt} />;
}
