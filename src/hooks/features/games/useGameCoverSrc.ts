import { useCoverUrl } from "@/hooks/queries/useCoverUrl";
import { isWebRuntime, publicAssetUrl } from "@/services/platform";
import type { GameData } from "@/types";
import { getGameNsfwStatus, getVisibleGameCover } from "@/utils/game";

/**
 * 回传可直接放进 <img src> 的封面网址。
 * 桌面版维持 reina-cover 协定；网页版改用服务器的版本化封面 Blob。
 */
export function useGameCoverSrc(
	game: GameData | undefined,
	replaceNsfwCover = false,
): string {
	const web = isWebRuntime();
	const hideForNsfw = Boolean(
		game && replaceNsfwCover && getGameNsfwStatus(game),
	);
	const version =
		web && game && !hideForNsfw ? (game.cover_version ?? null) : null;
	const blobUrl = useCoverUrl(game?.id ?? 0, version);

	if (!game) return "";
	if (!web) return getVisibleGameCover(game, replaceNsfwCover);
	if (hideForNsfw) return publicAssetUrl("images/NR18.png");
	return blobUrl ?? publicAssetUrl("images/default.png");
}
