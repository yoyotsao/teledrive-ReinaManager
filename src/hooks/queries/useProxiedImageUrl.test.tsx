import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isWebRuntime, getMetadataImageBlob } = vi.hoisted(() => ({
	isWebRuntime: vi.fn(),
	getMetadataImageBlob: vi.fn(),
}));
const desktopResolver = vi.fn((url?: string | null) => url ?? undefined);

vi.mock("@/services/platform", () => ({ isWebRuntime }));
vi.mock("@/services/web/metadataImage", () => ({ getMetadataImageBlob }));
vi.mock("@/hooks/common/useProxyImageUrlResolver", () => ({
	useProxyImageUrlResolver: () => desktopResolver,
}));

import {
	METADATA_IMAGE_GC_TIME,
	metadataImageKeys,
	useProxiedImageUrl,
} from "./useProxiedImageUrl";

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useProxiedImageUrl", () => {
	beforeEach(() => {
		isWebRuntime.mockReset();
		getMetadataImageBlob.mockReset();
		desktopResolver.mockClear();
		vi.stubGlobal("URL", {
			createObjectURL: vi.fn(() => "blob:img"),
			revokeObjectURL: vi.fn(),
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("桌面版沿用既有圖片解析器", () => {
		isWebRuntime.mockReturnValue(false);
		const client = new QueryClient();
		const { result } = renderHook(
			() => useProxiedImageUrl("https://t.vndb.org/a.jpg"),
			{ wrapper: wrapperFor(client) },
		);
		expect(result.current).toBe("https://t.vndb.org/a.jpg");
		expect(desktopResolver).toHaveBeenCalledWith("https://t.vndb.org/a.jpg");
		expect(getMetadataImageBlob).not.toHaveBeenCalled();
	});

	it("網頁版經伺服器代理取得 Blob", async () => {
		isWebRuntime.mockReturnValue(true);
		getMetadataImageBlob.mockResolvedValue(new Blob(["x"]));
		const client = new QueryClient();
		const { result } = renderHook(
			() => useProxiedImageUrl("https://t.vndb.org/a.jpg"),
			{ wrapper: wrapperFor(client) },
		);
		await waitFor(() => expect(result.current).toBe("blob:img"));
		expect(getMetadataImageBlob).toHaveBeenCalledWith(
			"https://t.vndb.org/a.jpg",
			expect.any(AbortSignal),
		);
		expect(metadataImageKeys.image("u")).toEqual([
			"server",
			"metadata-image",
			"u",
		]);
		const query = client.getQueryCache().find({
			queryKey: metadataImageKeys.image("https://t.vndb.org/a.jpg"),
		});
		expect(query?.state.data).toBeInstanceOf(Blob);
		expect(query?.options.gcTime).toBe(METADATA_IMAGE_GC_TIME);
	});

	it("網頁版 data URL 直接使用，空值回傳 undefined", () => {
		isWebRuntime.mockReturnValue(true);
		const client = new QueryClient();
		expect(
			renderHook(() => useProxiedImageUrl("data:image/png;base64,AA"), {
				wrapper: wrapperFor(client),
			}).result.current,
		).toBe("data:image/png;base64,AA");

		const emptyClient = new QueryClient();
		expect(
			renderHook(() => useProxiedImageUrl(null), {
				wrapper: wrapperFor(emptyClient),
			}).result.current,
		).toBeUndefined();
	});
});
