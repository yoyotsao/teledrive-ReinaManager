import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AUTH_REQUIRED_EVENT } from "@/services/web/auth";
import { useWebAuthRequired } from "./useWebAuthRequired";

describe("useWebAuthRequired", () => {
	it("收到 auth-required 事件后回传 true", () => {
		const { result, unmount } = renderHook(() => useWebAuthRequired());
		expect(result.current).toBe(false);
		act(() => {
			window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
		});
		expect(result.current).toBe(true);
		unmount();
	});
});
