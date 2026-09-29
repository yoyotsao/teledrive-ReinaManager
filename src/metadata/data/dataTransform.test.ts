import { describe, expect, it } from "vitest";
import { getDisplayGameData } from "./dataTransform";

describe("getDisplayGameData bridge display fields", () => {
	it("只展平 canonical TeleDrive path 與相對 exe path，不改原始輸入", () => {
		const source = {
			id: 4,
			id_type: "custom",
			sources: [],
			teledrive_path: "game/游戏 A",
			exe_relpath: "bin/game.exe",
		};

		expect(getDisplayGameData(source)).toMatchObject({
			id: 4,
			teledrive_path: "game/游戏 A",
			exe_relpath: "bin/game.exe",
		});
		expect(source).toEqual({
			id: 4,
			id_type: "custom",
			sources: [],
			teledrive_path: "game/游戏 A",
			exe_relpath: "bin/game.exe",
		});
	});

	it("将空的 nullable TeleDrive 字段转成 undefined", () => {
		const display = getDisplayGameData({
			id: 5,
			id_type: "custom",
			sources: [],
			teledrive_path: null,
			exe_relpath: null,
		});
		expect(display.teledrive_path).toBeUndefined();
		expect(display.exe_relpath).toBeUndefined();
	});
});
