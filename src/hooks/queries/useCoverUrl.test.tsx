import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCoverBlob } = vi.hoisted(() => ({
	getCoverBlob: vi.fn(),
}));
vi.mock("@/services/web/covers", () => ({ getCoverBlob }));

import { COVER_GC_TIME, coverKeys, useCoverUrl } from "./useCoverUrl";

let counter = 0;
const revoked: string[] = [];

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useCoverUrl", () => {
	beforeEach(() => {
		counter = 0;
		revoked.length = 0;
		getCoverBlob.mockReset();
		getCoverBlob.mockResolvedValue(new Blob(["img"]));
		vi.stubGlobal("URL", {
			createObjectURL: vi.fn(() => `blob:test/${++counter}`),
			revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("同一个 Blob 的两个使用者各自持有 URL，卸载一个不影响另一个", async () => {
		const client = new QueryClient();
		const wrapper = wrapperFor(client);
		const a = renderHook(() => useCoverUrl(1, "v1"), { wrapper });
		const b = renderHook(() => useCoverUrl(1, "v1"), { wrapper });

		await waitFor(() => expect(a.result.current).toBeDefined());
		await waitFor(() => expect(b.result.current).toBeDefined());
		expect(getCoverBlob).toHaveBeenCalledTimes(1);
		expect(a.result.current).not.toBe(b.result.current);

		const aUrl = a.result.current;
		a.unmount();
		expect(revoked).toEqual([aUrl]);
		expect(revoked).not.toContain(b.result.current);
	});

	it("重新挂载会用缓存 Blob 建立新 URL，不重新下载", async () => {
		const client = new QueryClient();
		const wrapper = wrapperFor(client);
		const first = renderHook(() => useCoverUrl(1, "v1"), { wrapper });
		await waitFor(() => expect(first.result.current).toBeDefined());
		const firstUrl = first.result.current;
		first.unmount();

		const second = renderHook(() => useCoverUrl(1, "v1"), { wrapper });
		await waitFor(() => expect(second.result.current).toBeDefined());
		expect(second.result.current).not.toBe(firstUrl);
		expect(getCoverBlob).toHaveBeenCalledTimes(1);
	});

	it("版本为 null 时不下载", () => {
		const client = new QueryClient();
		const { result } = renderHook(() => useCoverUrl(1, null), {
			wrapper: wrapperFor(client),
		});
		expect(result.current).toBeUndefined();
		expect(getCoverBlob).not.toHaveBeenCalled();
	});

	it("缓存 Blob、gcTime 为 30 分钟，且 key 不跟随 server data version", async () => {
		const client = new QueryClient();
		const { result } = renderHook(() => useCoverUrl(1, "v1"), {
			wrapper: wrapperFor(client),
		});
		await waitFor(() => expect(result.current).toBeDefined());

		expect(coverKeys.cover(1, "v1")).toEqual(["cover", 1, "v1"]);
		const query = client.getQueryCache().find({
			queryKey: coverKeys.cover(1, "v1"),
		});
		expect(query?.state.data).toBeInstanceOf(Blob);
		expect(query?.options.gcTime).toBe(COVER_GC_TIME);
		expect(COVER_GC_TIME).toBe(30 * 60_000);
	});
});
