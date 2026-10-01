import { describe, expect, it } from "vitest";
import { availableAddModalTabs, defaultAddModalTab } from "./addModalTabs";

describe("addModalTabs", () => {
	it("桌面版提供單個、批量與雲端收藏，預設單個", () => {
		expect(availableAddModalTabs(false)).toEqual([
			"single",
			"bulk",
			"collection",
		]);
		expect(defaultAddModalTab(false)).toBe("single");
	});

	it("網頁版沒有批量分頁，預設雲端掃描", () => {
		expect(availableAddModalTabs(true)).toEqual(["cloud", "single"]);
		expect(availableAddModalTabs(true)).not.toContain("bulk");
		expect(defaultAddModalTab(true)).toBe("cloud");
	});
});
