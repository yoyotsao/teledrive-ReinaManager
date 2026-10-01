import { describe, expect, it, vi } from "vitest";

describe("网页版模块载入", () => {
	it("没有 Tauri 全局对象时，游戏编辑页模块可以载入", async () => {
		vi.stubEnv("MODE", "web");
		// 确认测试环境真的没有 Tauri 注入
		expect(
			(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
		).toBeUndefined();
		await expect(
			import("@/pages/Detail/game-info/GameInfoEdit"),
		).resolves.toBeDefined();
		const gameStats = await import("@/services/game/gameStats");
		await expect(gameStats.initGameTimeTracking()).resolves.toBeTypeOf(
			"function",
		);
	}, 15_000);
});
