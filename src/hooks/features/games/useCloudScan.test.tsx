import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameMetadataDraft } from "@/types";
import { ApiRateLimitError } from "@/utils/errors";

const {
	startCloudScan,
	getScanPending,
	updateGame,
	getStoredGameById,
	setSourceCover,
	checkServerVersion,
	resolveCloudScanName,
} = vi.hoisted(() => ({
	startCloudScan: vi.fn(),
	getScanPending: vi.fn(),
	updateGame: vi.fn(),
	getStoredGameById: vi.fn(),
	setSourceCover: vi.fn(),
	checkServerVersion: vi.fn(),
	resolveCloudScanName: vi.fn(),
}));

vi.mock("@/services/web/scan", () => ({
	startCloudScan,
	getScanPending,
}));
vi.mock("@/services/invoke", () => ({
	gameService: { updateGame, getGameById: getStoredGameById },
}));
vi.mock("@/services/web/covers", () => ({ setSourceCover }));
vi.mock("@/hooks/queries/useServerVersion", () => ({
	checkServerVersion,
}));
vi.mock("@/metadata/cloudScanResolve", () => ({
	resolveCloudScanName,
}));
vi.mock("@/services/requestContext", () => ({
	createMetadataSession: () => ({
		searchByName: vi.fn(),
		getGameById: vi.fn(),
	}),
	getNetworkRequestContext: () => ({}),
}));

import { useCloudScan } from "./useCloudScan";

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		{children}
	</QueryClientProvider>
);

const draft: GameMetadataDraft = {
	id_type: "vndb",
	sources: [
		{
			source: "vndb",
			external_id: "v1",
			data: {
				image: "https://t.vndb.org/cv/1.jpg",
			},
		},
	],
};

describe("useCloudScan", () => {
	beforeEach(() => {
		for (const fn of [
			startCloudScan,
			getScanPending,
			updateGame,
			getStoredGameById,
			setSourceCover,
			checkServerVersion,
			resolveCloudScanName,
		]) {
			fn.mockReset();
		}
		updateGame.mockResolvedValue({});
		getStoredGameById.mockResolvedValue(null);
		setSourceCover.mockResolvedValue({
			cover_version: "h",
		});
		checkServerVersion.mockResolvedValue(undefined);
	});

	it("掃描時重跑所有待確認項目，不論候選是否為空", async () => {
		startCloudScan.mockResolvedValue({ added_ids: [], pending_ids: [] });
		getScanPending.mockResolvedValue([
			{
				id: 1,
				name: "空候選",
				teledrive_path: "game/空候選",
				scan_status: "needs_confirmation",
				scan_candidates: [],
			},
			{
				id: 2,
				name: "已有候選",
				teledrive_path: "game/已有候選",
				scan_status: "needs_confirmation",
				scan_candidates: [{ source: "bgm", externalId: "b", name: "B" }],
			},
		]);
		resolveCloudScanName.mockResolvedValue({
			kind: "needs_confirmation",
			candidates: [{ source: "vndb", externalId: "v9", name: "X" }],
		});

		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});

		expect(resolveCloudScanName.mock.calls.map((call) => call[0])).toEqual([
			"空候選",
			"已有候選",
		]);
		expect(updateGame).toHaveBeenCalledWith(1, {
			scan_status: "needs_confirmation",
			scan_candidates: [{ source: "vndb", externalId: "v9", name: "X" }],
		});
	});

	it("自動套用來源資料與封面，待確認寫入候選", async () => {
		startCloudScan.mockResolvedValue({
			added_ids: [1, 2],
			pending_ids: [1, 2],
		});
		getScanPending
			.mockResolvedValueOnce([
				{
					id: 1,
					name: "A",
					teledrive_path: "game/A",
					scan_status: "pending",
					scan_candidates: [],
				},
				{
					id: 2,
					name: "B",
					teledrive_path: "game/B",
					scan_status: "pending",
					scan_candidates: [],
				},
			])
			.mockResolvedValueOnce([
				{
					id: 2,
					name: "B",
					teledrive_path: "game/B",
					scan_status: "needs_confirmation",
					scan_candidates: [
						{
							source: "bgm",
							externalId: "b",
							name: "B EX",
						},
					],
				},
			]);
		getStoredGameById.mockResolvedValueOnce({
			id: 1,
			custom_data: { name: "A" },
		});
		resolveCloudScanName
			.mockResolvedValueOnce({
				kind: "accepted",
				draft,
			})
			.mockResolvedValueOnce({
				kind: "needs_confirmation",
				candidates: [
					{
						source: "bgm",
						externalId: "b",
						name: "B EX",
					},
				],
			});

		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});

		expect(updateGame).toHaveBeenCalledWith(
			1,
			expect.objectContaining({
				id_type: "vndb",
				custom_data: { name: null },
				scan_status: "complete",
				scan_candidates: null,
			}),
		);
		expect(setSourceCover).toHaveBeenCalledWith(
			1,
			"https://t.vndb.org/cv/1.jpg",
		);
		expect(updateGame).toHaveBeenCalledWith(2, {
			scan_status: "needs_confirmation",
			scan_candidates: [
				{
					source: "bgm",
					externalId: "b",
					name: "B EX",
				},
			],
		});
		await waitFor(() => expect(result.current.pending).toHaveLength(1));
		expect(checkServerVersion).toHaveBeenCalled();
	});

	it("已有舊候選的待確認條目重跑後可以精確命中並自動套用", async () => {
		startCloudScan.mockResolvedValue({
			added_ids: [],
			pending_ids: [3],
		});
		getScanPending.mockResolvedValue([
			{
				id: 3,
				name: "C",
				teledrive_path: "game/C",
				scan_status: "needs_confirmation",
				scan_candidates: [{ source: "bgm", externalId: "c", name: "C EX" }],
			},
		]);
		resolveCloudScanName.mockResolvedValue({ kind: "accepted", draft });

		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});

		expect(resolveCloudScanName).toHaveBeenCalledTimes(1);
		expect(updateGame).toHaveBeenCalledWith(
			3,
			expect.objectContaining({
				scan_status: "complete",
				scan_candidates: null,
			}),
		);
	});

	it("使用者確認候選後抓完整資料並完成", async () => {
		getScanPending.mockResolvedValue([]);
		getStoredGameById.mockResolvedValue({
			id: 2,
			custom_data: { name: "B" },
		});
		const getGameById = vi.fn(async () => draft);
		const { result } = renderHook(() => useCloudScan({ getGameById }), {
			wrapper,
		});

		await act(async () => {
			await result.current.confirm(
				{
					id: 2,
					name: "B",
					teledrive_path: "game/B",
					scan_status: "needs_confirmation",
					scan_candidates: [],
				},
				{
					source: "vndb",
					externalId: "v1",
					name: "B",
				},
			);
		});

		expect(getGameById).toHaveBeenCalledWith("v1", "vndb");
		expect(updateGame).toHaveBeenCalledWith(
			2,
			expect.objectContaining({
				scan_status: "complete",
			}),
		);
		expect(setSourceCover).toHaveBeenCalledWith(
			2,
			"https://t.vndb.org/cv/1.jpg",
		);
	});

	it("使用者已修改佔位名稱時保留 custom_data.name", async () => {
		startCloudScan.mockResolvedValue({
			added_ids: [],
			pending_ids: [9],
		});
		getScanPending.mockResolvedValue([
			{
				id: 9,
				name: "我的遊戲名稱",
				teledrive_path: "game/123456",
				scan_status: "pending",
				scan_candidates: [],
			},
		]);
		resolveCloudScanName.mockResolvedValueOnce({
			kind: "accepted",
			draft,
		});

		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});

		expect(getStoredGameById).not.toHaveBeenCalled();
		expect(updateGame).toHaveBeenCalledWith(
			9,
			expect.not.objectContaining({ custom_data: expect.anything() }),
		);
	});
	it("查詢失敗的條目不寫入、維持 pending，並計入 failedCount", async () => {
		startCloudScan.mockResolvedValue({
			added_ids: [4],
			pending_ids: [4],
		});
		getScanPending.mockResolvedValue([
			{
				id: 4,
				name: "D",
				teledrive_path: "game/D",
				scan_status: "pending",
				scan_candidates: [],
			},
		]);
		resolveCloudScanName.mockResolvedValueOnce({
			kind: "failed",
			error: new Error("network down"),
		});

		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});

		expect(updateGame).not.toHaveBeenCalled();
		expect(result.current.failedCount).toBe(1);
		expect(result.current.error).toBeNull();
	});

	it("限流時停止掃描、顯示錯誤，其餘條目維持 pending", async () => {
		startCloudScan.mockResolvedValue({
			added_ids: [5, 6],
			pending_ids: [5, 6],
		});
		getScanPending.mockResolvedValue([
			{
				id: 5,
				name: "E",
				teledrive_path: "game/E",
				scan_status: "pending",
				scan_candidates: [],
			},
			{
				id: 6,
				name: "F",
				teledrive_path: "game/F",
				scan_status: "pending",
				scan_candidates: [],
			},
		]);
		const limited = new ApiRateLimitError({
			source: "vndb",
			message: "429",
		});
		resolveCloudScanName.mockRejectedValueOnce(limited);

		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});

		expect(resolveCloudScanName).toHaveBeenCalledTimes(1);
		expect(updateGame).not.toHaveBeenCalled();
		expect(result.current.error).toBe(limited);
	});
});
