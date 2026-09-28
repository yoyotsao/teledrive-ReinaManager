import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会被提升到档案最上方，工厂用到的 mock 必须用 vi.hoisted 建立
const { initializeGamePlayTracking } = vi.hoisted(() => ({
	initializeGamePlayTracking: vi.fn(async () => {}),
}));
vi.mock("./gamePlayStore", () => ({ initializeGamePlayTracking }));

const { updateProxyConfig } = vi.hoisted(() => ({
	updateProxyConfig: vi.fn(async () => {}),
}));
vi.mock("@/services/invoke", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/invoke")>();
	return {
		...actual,
		settingsService: { ...actual.settingsService, updateProxyConfig },
	};
});

import { initializeStores } from "./appStore";

beforeEach(() => {
	initializeGamePlayTracking.mockClear();
	updateProxyConfig.mockClear();
});

describe("initializeStores", () => {
	it("网页版不初始化桌面计时事件，也不同步代理设定", async () => {
		vi.stubEnv("MODE", "web");
		await initializeStores();
		expect(initializeGamePlayTracking).not.toHaveBeenCalled();
		expect(updateProxyConfig).not.toHaveBeenCalled();
	});

	it("桌面版维持原本流程", async () => {
		vi.stubEnv("MODE", "production");
		await initializeStores();
		expect(initializeGamePlayTracking).toHaveBeenCalledTimes(1);
		expect(updateProxyConfig).toHaveBeenCalledTimes(1);
	});
});
