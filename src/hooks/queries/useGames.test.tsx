import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FullGameData, InsertGameParams } from "@/types";

const {
	insertGame,
	updateGame,
	deleteCloudCoverCache,
	setSourceCover,
	isWebRuntime,
} = vi.hoisted(() => ({
	insertGame: vi.fn(),
	updateGame: vi.fn(),
	deleteCloudCoverCache: vi.fn(),
	setSourceCover: vi.fn(),
	isWebRuntime: vi.fn(),
}));

vi.mock("@/services/invoke", () => ({
	gameService: { insertGame, updateGame },
	fileService: { deleteCloudCoverCache },
}));
vi.mock("@/services/platform", () => ({ isWebRuntime }));
vi.mock("@/services/web/covers", () => ({ setSourceCover }));

import {
	gameKeys,
	useAddGame,
	useUpdateGame,
	useUpdateGameWithSourceCover,
} from "./useGames";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

describe("useAddGame", () => {
	beforeEach(() => {
		insertGame.mockReset();
		updateGame.mockReset();
		deleteCloudCoverCache.mockReset();
		setSourceCover.mockReset();
		isWebRuntime.mockReset();
		isWebRuntime.mockReturnValue(true);
		setSourceCover.mockResolvedValue({
			cover_version: "cover-hash",
			has_custom_cover: false,
		});
	});

	it("Web 手動新增後會下載目前資料源的封面並回填版本", async () => {
		const params: InsertGameParams = {
			id_type: "vndb",
			sources: [
				{
					source: "vndb",
					external_id: "v1",
					data: { image: "https://t.vndb.org/cv/1.jpg" },
				},
			],
		};
		const inserted = {
			id: 7,
			id_type: "vndb",
			sources: params.sources,
			launch_type: "local",
			cover_version: null,
			has_custom_cover: false,
		} as FullGameData;
		insertGame.mockResolvedValue(inserted);

		const { result } = renderHook(() => useAddGame(), { wrapper });
		let saved: FullGameData | undefined;
		await act(async () => {
			saved = await result.current.mutateAsync(params);
		});

		expect(setSourceCover).toHaveBeenCalledWith(
			7,
			"https://t.vndb.org/cv/1.jpg",
		);
		expect(saved?.cover_version).toBe("cover-hash");
	});

	it("desktop 新增維持既有流程，不呼叫 Web 封面 API", async () => {
		isWebRuntime.mockReturnValue(false);
		const params: InsertGameParams = {
			id_type: "vndb",
			sources: [
				{
					source: "vndb",
					external_id: "v1",
					data: { image: "https://t.vndb.org/cv/1.jpg" },
				},
			],
		};
		insertGame.mockResolvedValue({
			id: 8,
			id_type: "vndb",
			sources: params.sources,
			launch_type: "local",
		});

		const { result } = renderHook(() => useAddGame(), { wrapper });
		await act(async () => {
			await result.current.mutateAsync(params);
		});

		expect(setSourceCover).not.toHaveBeenCalled();
	});
});

describe("useUpdateGameWithSourceCover", () => {
	beforeEach(() => {
		updateGame.mockReset();
		deleteCloudCoverCache.mockReset();
		setSourceCover.mockReset();
		isWebRuntime.mockReset();
		isWebRuntime.mockReturnValue(true);
		setSourceCover.mockResolvedValue({
			cover_version: "next-cover",
			has_custom_cover: false,
		});
	});

	it("Web mixed 更新使用後端完整資料保留既有 cover_source", async () => {
		const updated = {
			id: 9,
			id_type: "mixed",
			launch_type: "local",
			custom_data: { cover_source: "vndb" },
			cover_version: "old-cover",
			has_custom_cover: false,
			sources: [
				{
					source: "bgm",
					external_id: "1",
					data: { image: "https://bgm.example/cover.jpg" },
				},
				{
					source: "vndb",
					external_id: "v1",
					data: { image: "https://vndb.example/cover.jpg" },
				},
			],
		} as FullGameData;
		updateGame.mockResolvedValue(updated);

		const { result } = renderHook(() => useUpdateGameWithSourceCover(), {
			wrapper,
		});
		let saved: FullGameData | undefined;
		await act(async () => {
			saved = await result.current.mutateAsync({
				gameId: 9,
				updates: {
					upsert_sources: [
						{
							source: "bgm",
							external_id: "1",
							data: { image: "https://bgm.example/cover.jpg" },
						},
					],
				},
			});
		});

		expect(setSourceCover).toHaveBeenCalledWith(
			9,
			"https://vndb.example/cover.jpg",
		);
		expect(saved).toEqual(
			expect.objectContaining({
				cover_version: "next-cover",
				has_custom_cover: false,
			}),
		);
	});

	it("封面下載完成時只合併封面欄位，不覆蓋期間完成的新修改", async () => {
		let resolveCover:
			| ((value: { cover_version: string; has_custom_cover: boolean }) => void)
			| undefined;
		setSourceCover.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCover = resolve;
				}),
		);

		const before = {
			id: 11,
			id_type: "mixed",
			launch_type: "local",
			custom_data: { name: "舊名稱", cover_source: "vndb" },
			cover_version: "old-cover",
			has_custom_cover: false,
			sources: [
				{
					source: "vndb",
					external_id: "v1",
					data: { image: "https://vndb.example/cover.jpg" },
				},
			],
		} as FullGameData;
		const metadataUpdated = {
			...before,
			updated_at: 2,
		} as FullGameData;
		const renamed = {
			...metadataUpdated,
			custom_data: { ...metadataUpdated.custom_data, name: "新名稱" },
			updated_at: 3,
		} as FullGameData;
		updateGame
			.mockResolvedValueOnce(metadataUpdated)
			.mockResolvedValueOnce(renamed);

		const queryClient = new QueryClient();
		queryClient.setQueryData(gameKeys.all, [before]);
		const raceWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => ({
				coverUpdate: useUpdateGameWithSourceCover(),
				normalUpdate: useUpdateGame(),
			}),
			{ wrapper: raceWrapper },
		);

		let coverPromise: Promise<FullGameData> | undefined;
		await act(async () => {
			coverPromise = result.current.coverUpdate.mutateAsync({
				gameId: 11,
				updates: { id_type: "mixed" },
			});
			await vi.waitFor(() => expect(setSourceCover).toHaveBeenCalledTimes(1));
		});

		await act(async () => {
			await result.current.normalUpdate.mutateAsync({
				gameId: 11,
				updates: {
					custom_data: {
						...renamed.custom_data,
					},
				},
			});
		});
		expect(
			queryClient.getQueryData<FullGameData[]>(gameKeys.all)?.[0].custom_data
				?.name,
		).toBe("新名稱");

		await act(async () => {
			resolveCover?.({
				cover_version: "next-cover",
				has_custom_cover: false,
			});
			await coverPromise;
		});

		const cached = queryClient.getQueryData<FullGameData[]>(gameKeys.all)?.[0];
		expect(cached?.custom_data?.name).toBe("新名稱");
		expect(cached?.cover_version).toBe("next-cover");
	});

	it("desktop 先清除雲端封面快取，不呼叫 Web 封面 API", async () => {
		isWebRuntime.mockReturnValue(false);
		const updated = {
			id: 10,
			id_type: "vndb",
			launch_type: "local",
			sources: [],
		} as FullGameData;
		updateGame.mockResolvedValue(updated);

		const { result } = renderHook(() => useUpdateGameWithSourceCover(), {
			wrapper,
		});
		await act(async () => {
			await result.current.mutateAsync({
				gameId: 10,
				updates: { id_type: "vndb" },
			});
		});

		expect(deleteCloudCoverCache).toHaveBeenCalledWith(10);
		expect(setSourceCover).not.toHaveBeenCalled();
	});
});
