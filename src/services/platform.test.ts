import { afterEach, describe, expect, it, vi } from "vitest";

const shellOpen = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

let tauri = false;
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri }));

import {
	getRouterBasename,
	isWebRuntime,
	openExternal,
	platformCapabilities,
	publicAssetUrl,
} from "./platform";

afterEach(() => {
	tauri = false;
	shellOpen.mockClear();
});

describe("网页版", () => {
	it("所有原生能力都是 false，basename 为 /game", () => {
		vi.stubEnv("MODE", "web");
		tauri = false;
		expect(isWebRuntime()).toBe(true);
		expect({ ...platformCapabilities }).toEqual({
			nativePaths: false,
			nativeLaunch: false,
			desktopShell: false,
		});
		expect(getRouterBasename()).toBe("/game");
		expect(publicAssetUrl("images/default.png")).toBe(
			"/game/images/default.png",
		);
		expect(publicAssetUrl("/images/default.png")).toBe(
			"/game/images/default.png",
		);
	});

	it("openExternal 以新分页开启，且不带 opener", async () => {
		vi.stubEnv("MODE", "web");
		const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
		await openExternal("https://bgm.tv/subject/1");
		expect(openSpy).toHaveBeenCalledWith(
			"https://bgm.tv/subject/1",
			"_blank",
			"noopener,noreferrer",
		);
		expect(shellOpen).not.toHaveBeenCalled();
	});
});

describe("桌面版", () => {
	it("Tauri 下所有能力为 true，资源路径维持 /images", async () => {
		vi.stubEnv("MODE", "production");
		tauri = true;
		expect(isWebRuntime()).toBe(false);
		expect({ ...platformCapabilities }).toEqual({
			nativePaths: true,
			nativeLaunch: true,
			desktopShell: true,
		});
		expect(getRouterBasename()).toBeUndefined();
		expect(publicAssetUrl("images/default.png")).toBe("/images/default.png");
		await openExternal("https://vndb.org/v1");
		expect(shellOpen).toHaveBeenCalledWith("https://vndb.org/v1");
	});

	it("既非网页也非 Tauri（纯 vite dev）时能力皆 false", () => {
		vi.stubEnv("MODE", "development");
		tauri = false;
		expect(platformCapabilities.desktopShell).toBe(false);
	});
});
