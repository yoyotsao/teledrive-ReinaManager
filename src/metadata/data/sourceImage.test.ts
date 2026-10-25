import { describe, expect, it } from "vitest";
import { resolveDisplaySourceImage } from "./sourceImage";

describe("resolveDisplaySourceImage", () => {
	const sources = [
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
	];

	it("單一來源只使用目前 id_type 的圖片", () => {
		expect(resolveDisplaySourceImage({ id_type: "vndb", sources })).toBe(
			"https://vndb.example/cover.jpg",
		);
	});

	it("mixed 尊重使用者選擇的 cover_source", () => {
		expect(
			resolveDisplaySourceImage({
				id_type: "mixed",
				custom_data: { cover_source: "bgm" },
				sources,
			}),
		).toBe("https://bgm.example/cover.jpg");
	});

	it("custom 不把外部來源圖片當成目前封面", () => {
		expect(
			resolveDisplaySourceImage({ id_type: "custom", sources }),
		).toBeUndefined();
	});
});
