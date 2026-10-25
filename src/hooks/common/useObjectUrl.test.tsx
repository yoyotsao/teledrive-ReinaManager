import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useObjectUrl } from "./useObjectUrl";

let counter = 0;
const revoked: string[] = [];

describe("useObjectUrl", () => {
	beforeEach(() => {
		counter = 0;
		revoked.length = 0;
		vi.stubGlobal("URL", {
			createObjectURL: vi.fn(() => `blob:test/${++counter}`),
			revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("Blob 切换与卸载时撤销各自的 URL", async () => {
		const first = new Blob(["first"]);
		const second = new Blob(["second"]);
		const { result, rerender, unmount } = renderHook(
			({ blob }: { blob?: Blob }) => useObjectUrl(blob),
			{ initialProps: { blob: first } },
		);

		await waitFor(() => expect(result.current).toBe("blob:test/1"));
		rerender({ blob: second });
		await waitFor(() => expect(result.current).toBe("blob:test/2"));
		expect(revoked).toEqual(["blob:test/1"]);

		unmount();
		expect(revoked).toEqual(["blob:test/1", "blob:test/2"]);
	});

	it("没有 Blob 时不建立 URL", () => {
		const { result } = renderHook(() => useObjectUrl(undefined));
		expect(result.current).toBeUndefined();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
});
