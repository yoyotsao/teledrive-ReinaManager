import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebAuthGate } from "./WebAuthGate";

describe("WebAuthGate", () => {
	it("提供前往 TeleDrive 的链接与重新检查按钮", () => {
		const onRetry = vi.fn();
		render(<WebAuthGate onRetry={onRetry} />);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"请先登录 TeleDrive",
		);
		expect(
			screen
				.getByRole("link", { name: "前往 TeleDrive 登录" })
				.getAttribute("href"),
		).toBe("/");
		fireEvent.click(screen.getByRole("button", { name: "我已登录，重新检查" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
