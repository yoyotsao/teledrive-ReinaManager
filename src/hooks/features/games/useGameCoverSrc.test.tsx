import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameData } from "@/types";

const { isWebRuntime, useCoverUrl, publicAssetUrl } = vi.hoisted(() => ({
	isWebRuntime: vi.fn(),
	useCoverUrl: vi.fn(),
	publicAssetUrl: (path: string) => `/game/${path.replace(/^\/+/, "")}`,
}));
vi.mock("@/services/platform", () => ({ isWebRuntime, publicAssetUrl }));
vi.mock("@/hooks/queries/useCoverUrl", () => ({ useCoverUrl }));
vi.mock("@/utils/game", async (original) => ({
	...(await original<typeof import("@/utils/game")>()),
	getVisibleGameCover: vi.fn(() => "desktop-cover"),
}));

import { useGameCoverSrc } from "./useGameCoverSrc";

const game = {
	id: 5,
	sourceIds: {},
	cover_version: "h1",
	tags: [],
} as unknown as GameData;
const nsfwGame = { ...game, nsfw: true } as GameData;

describe("useGameCoverSrc", () => {
	beforeEach(() => {
		isWebRuntime.mockReset();
		useCoverUrl.mockReset();
	});

	it("桌面版沿用原本的封面网址", () => {
		isWebRuntime.mockReturnValue(false);
		useCoverUrl.mockReturnValue(undefined);
		const { result } = renderHook(() => useGameCoverSrc(game, false));
		expect(result.current).toBe("desktop-cover");
		expect(useCoverUrl).toHaveBeenCalledWith(5, null);
	});

	it("网页版有 Blob URL 就使用它", () => {
		isWebRuntime.mockReturnValue(true);
		useCoverUrl.mockReturnValue("blob:x");
		const { result } = renderHook(() => useGameCoverSrc(game, false));
		expect(result.current).toBe("blob:x");
		expect(useCoverUrl).toHaveBeenCalledWith(5, "h1");
	});

	it("网页版没有封面或尚未载入时使用子路径下的默认图", () => {
		isWebRuntime.mockReturnValue(true);
		useCoverUrl.mockReturnValue(undefined);
		const { result } = renderHook(() =>
			useGameCoverSrc({ ...game, cover_version: null } as GameData, false),
		);
		expect(result.current).toBe("/game/images/default.png");
	});

	it("网页版替换 NSFW 封面时不下载真实封面", () => {
		isWebRuntime.mockReturnValue(true);
		useCoverUrl.mockReturnValue(undefined);
		const { result } = renderHook(() => useGameCoverSrc(nsfwGame, true));
		expect(result.current).toBe("/game/images/NR18.png");
		expect(useCoverUrl).toHaveBeenCalledWith(5, null);
	});
});
