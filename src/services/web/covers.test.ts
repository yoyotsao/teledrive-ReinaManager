import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会被提升到文件最上方，工厂用到的 mock 必须用 vi.hoisted 建立
const { authenticatedFetch } = vi.hoisted(() => ({
	authenticatedFetch: vi.fn(),
}));
vi.mock("@/services/web/http", () => ({ authenticatedFetch }));

import {
	deleteCustomCover,
	getCoverBlob,
	setSourceCover,
	uploadCustomCover,
} from "./covers";

describe("covers service", () => {
	beforeEach(() => authenticatedFetch.mockReset());

	it("以版本网址取得 Blob", async () => {
		// jsdom 29 的 Response 实现无法正确保留 Blob 请求体（.blob() 会拿回
		// "[object Blob]" 字符串），所以直接给一个具备所需接口的假响应，
		// 而不是真的靠 new Response(blob) 往返。
		const blob = new Blob(["x"], { type: "image/png" });
		authenticatedFetch.mockResolvedValue({
			ok: true,
			status: 200,
			blob: async () => blob,
		} as unknown as Response);
		const result = await getCoverBlob(7, "abc", undefined);
		expect(authenticatedFetch).toHaveBeenCalledWith(
			"/game/api/covers/7?v=abc",
			{
				signal: undefined,
			},
		);
		expect(await result.text()).toBe("x");
	});

	it("非 2xx 抛出错误", async () => {
		authenticatedFetch.mockResolvedValue(new Response("", { status: 404 }));
		await expect(getCoverBlob(7, "abc")).rejects.toThrow(/404/);
	});

	it("上传、删除、设定来源封面返回新版本", async () => {
		authenticatedFetch.mockImplementation(
			async () =>
				new Response(JSON.stringify({ cover_version: "v2" }), { status: 200 }),
		);
		const file = new Blob(["img"], { type: "image/png" });
		await expect(uploadCustomCover(7, file)).resolves.toEqual({
			cover_version: "v2",
		});
		expect(authenticatedFetch).toHaveBeenLastCalledWith("/game/api/covers/7", {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: file,
		});
		await deleteCustomCover(7);
		expect(authenticatedFetch).toHaveBeenLastCalledWith("/game/api/covers/7", {
			method: "DELETE",
		});
		await setSourceCover(7, "https://t.vndb.org/cv/1.jpg");
		expect(authenticatedFetch).toHaveBeenLastCalledWith(
			"/game/api/covers/7/source",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: "https://t.vndb.org/cv/1.jpg" }),
			},
		);
	});
});
