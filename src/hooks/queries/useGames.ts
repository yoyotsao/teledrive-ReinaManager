/**
 * @file 游戏数据查询层
 * @description 使用 React Query 管理游戏列表、详情和增删改操作
 */

import {
	keepPreviousData,
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
	appendGamesToCaches,
	patchGameCaches,
	removeGamesFromCaches,
} from "@/hooks/queries/gameCachePatch";
import { serverKey } from "@/hooks/queries/serverKeys";
import { resolveDisplaySourceImage } from "@/metadata/data/sourceImage";
import type { GameType, SortOption, SortOrder } from "@/services/invoke";
import { fileService, gameService } from "@/services/invoke";
import { isWebRuntime } from "@/services/platform";
import { setSourceCover } from "@/services/web/covers";
import { trashCloudGames } from "@/services/web/scan";
import type {
	BatchOperationResult,
	FullGameData,
	InsertGameParams,
	UpdateGameParams,
} from "@/types";

const listRelevantUpdateFields = new Set<keyof UpdateGameParams>([
	"id_type",
	"date",
	"localpath",
	"clear",
	"custom_data",
	"upsert_sources",
	"remove_sources",
]);

function shouldInvalidateGameLists(updates: UpdateGameParams): boolean {
	return Object.keys(updates).some((field) =>
		listRelevantUpdateFields.has(field as keyof UpdateGameParams),
	);
}

function shouldInvalidateSourceIdCaches(updates: UpdateGameParams): boolean {
	return Boolean(
		updates.remove_sources?.some(
			(source) => source === "bgm" || source === "vndb",
		) ||
			updates.upsert_sources?.some(
				(record) => record.source === "bgm" || record.source === "vndb",
			),
	);
}

function invalidateSourceIdCaches(queryClient: QueryClient) {
	queryClient.invalidateQueries({ queryKey: gameKeys.bgmIds() });
	queryClient.invalidateQueries({ queryKey: gameKeys.vndbIds() });
}

export const gameKeys = {
	all: serverKey("games"),
	index: () => [...gameKeys.all, "index"] as const,
	idLists: () => [...gameKeys.all, "idList"] as const,
	idList: (params: {
		gameType: GameType;
		sortOption: SortOption;
		sortOrder: SortOrder;
		language: string;
	}) => [...gameKeys.idLists(), params] as const,
	vndbIds: () => [...gameKeys.all, "vndbIds"] as const,
	bgmIds: () => [...gameKeys.all, "bgmIds"] as const,
};

function useAllGames() {
	return useQuery({
		queryKey: gameKeys.all,
		queryFn: () => gameService.getAllGames("all"),
	});
}

/**
 * 查询排序/筛选后的游戏 ID 列表（轻量 IPC）
 *
 * 与 useAllGames（返回全量 FullGameData）不同：
 * 本函数通过后端 find_game_ids 命令只获取 ID 数组，
 * 前端已缓存完整数据，切换排序/筛选时 IPC 传输量从数 MB 降到数 KB。
 */
function useGameIdList(
	gameType: GameType,
	sortOption: SortOption,
	sortOrder: SortOrder,
	enabled = true,
) {
	const { i18n } = useTranslation();
	const language = i18n.language;

	return useQuery({
		queryKey: gameKeys.idList({ gameType, sortOption, sortOrder, language }),
		enabled,
		queryFn: () =>
			gameService.getGameIds(gameType, sortOption, sortOrder, language),
		placeholderData: keepPreviousData,
	});
}

function useAllVndbIds() {
	return useQuery({
		queryKey: gameKeys.vndbIds(),
		queryFn: () => gameService.getAllVndbIds(),
	});
}

function useAllBgmIds() {
	return useQuery({
		queryKey: gameKeys.bgmIds(),
		queryFn: () => gameService.getAllBgmIds(),
	});
}

function useAddGame() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (gameParams: InsertGameParams) => {
			const insertedGame = await gameService.insertGame(gameParams);
			if (!isWebRuntime()) {
				return insertedGame;
			}

			const image = resolveDisplaySourceImage(gameParams);
			if (!image) {
				return insertedGame;
			}

			try {
				const cover = await setSourceCover(insertedGame.id, image);
				return {
					...insertedGame,
					cover_version: cover.cover_version,
					has_custom_cover: cover.has_custom_cover,
				};
			} catch (error) {
				console.warn("新增游戏后下载来源封面失败:", error);
				return insertedGame;
			}
		},
		onSuccess: async (insertedGame) => {
			const patched = appendGamesToCaches(queryClient, gameKeys, [
				insertedGame,
			]);
			if (!patched) {
				await queryClient.invalidateQueries({
					queryKey: gameKeys.all,
					exact: true,
				});
			}
			await queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			invalidateSourceIdCaches(queryClient);
			await queryClient.invalidateQueries({
				queryKey: serverKey("collections"),
			});
		},
	});
}

function useBatchAddGames() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (games: InsertGameParams[]): Promise<BatchOperationResult> =>
			gameService.insertGamesBatch(games),
		onSuccess: (result) => {
			if (result.success === 0) {
				return;
			}
			const patched = appendGamesToCaches(
				queryClient,
				gameKeys,
				result.games ?? [],
			);
			if (!patched) {
				queryClient.invalidateQueries({
					queryKey: gameKeys.all,
					exact: true,
				});
			}
			queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			invalidateSourceIdCaches(queryClient);
			queryClient.invalidateQueries({ queryKey: serverKey("collections") });
		},
	});
}

function useDeleteGame() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			gameId,
			deleteCloud = false,
		}: {
			gameId: number;
			deleteCloud?: boolean;
		}) => {
			if (deleteCloud) await trashCloudGames([gameId]);
			return gameService.deleteGame(gameId);
		},
		onSuccess: (_, { gameId }) => {
			// 乐观更新：立即从缓存中移除已删除的游戏
			removeGamesFromCaches(queryClient, gameKeys, [gameId]);
			queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			queryClient.invalidateQueries({ queryKey: serverKey("collections") });
			queryClient.invalidateQueries({ queryKey: serverKey("stats") });
		},
	});
}

function useDeleteGames() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			gameIds,
			deleteCloud = false,
		}: {
			gameIds: number[];
			deleteCloud?: boolean;
		}) => {
			if (deleteCloud) await trashCloudGames(gameIds);
			return gameService.deleteGames(gameIds);
		},
		onSuccess: (_, { gameIds }) => {
			// 乐观更新：立即从缓存中移除已删除的游戏
			removeGamesFromCaches(queryClient, gameKeys, gameIds);
			queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			queryClient.invalidateQueries({ queryKey: serverKey("collections") });
			queryClient.invalidateQueries({ queryKey: serverKey("stats") });
		},
	});
}

function useUpdateGame() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			gameId,
			updates,
		}: {
			gameId: number;
			updates: UpdateGameParams;
		}) => gameService.updateGame(gameId, updates),
		onSuccess: (updatedFullGame, { updates }) => {
			patchGameCaches(queryClient, gameKeys, updatedFullGame);

			if (shouldInvalidateGameLists(updates)) {
				queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			}
			if (shouldInvalidateSourceIdCaches(updates)) {
				invalidateSourceIdCaches(queryClient);
			}
		},
	});
}

function useUpdateGameWithSourceCover() {
	const queryClient = useQueryClient();
	const updateGameMutation = useUpdateGame();

	return {
		mutateAsync: async ({
			gameId,
			updates,
		}: {
			gameId: number;
			updates: UpdateGameParams;
		}) => {
			if (!isWebRuntime()) {
				await fileService.deleteCloudCoverCache(gameId);
				return updateGameMutation.mutateAsync({ gameId, updates });
			}

			// 必須以後端實際寫入後的完整資料決定封面，不能使用本次 metadata 草稿：
			// mixed 的 cover_source 與本次抓取失敗但仍保留在 DB 的來源都只存在於這份結果。
			const updatedGame = await updateGameMutation.mutateAsync({
				gameId,
				updates,
			});
			const cover = await setSourceCover(
				gameId,
				resolveDisplaySourceImage(updatedGame) ?? null,
			);
			const latestGame =
				queryClient
					.getQueryData<FullGameData[]>(gameKeys.all)
					?.find((game) => game.id === gameId) ?? updatedGame;
			const updatedWithCover = {
				...latestGame,
				cover_version: cover.cover_version,
				has_custom_cover: cover.has_custom_cover,
			};
			patchGameCaches(queryClient, gameKeys, updatedWithCover);
			return updatedWithCover;
		},
	};
}

/**
 * 網頁版純封面變更（covers API）後，直接把新的 cover_version / has_custom_cover
 * 合併進遊戲快取與索引，不必等輪詢或 focus 才換圖。
 */
function usePatchGameCover() {
	const queryClient = useQueryClient();

	return (
		gameId: number,
		cover: { cover_version: string | null; has_custom_cover: boolean },
	) => {
		const current = queryClient
			.getQueryData<FullGameData[]>(gameKeys.all)
			?.find((game) => game.id === gameId);
		if (!current) {
			queryClient.invalidateQueries({ queryKey: gameKeys.all, exact: true });
			return;
		}
		patchGameCaches(queryClient, gameKeys, {
			...current,
			cover_version: cover.cover_version,
			has_custom_cover: cover.has_custom_cover,
		});
	};
}

export {
	useAddGame,
	useAllBgmIds,
	useAllGames,
	useAllVndbIds,
	useBatchAddGames,
	useDeleteGame,
	useDeleteGames,
	useGameIdList,
	usePatchGameCover,
	useUpdateGame,
	useUpdateGameWithSourceCover,
};
