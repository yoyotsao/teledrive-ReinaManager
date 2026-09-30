/**
 * fake bridge 与 8081 路由 harness 自测：确认测试基础设施本身可信，
 * 之后的 UI 状态机测试（任务 17B2）才能建立在它上面。
 */

import type { Page } from "@playwright/test";
import { FakeBridge } from "./support/fake-bridge.mjs";
import { expect, REAL_BRIDGE_ORIGIN, test } from "./support/fixtures";
import { expiredJwt, validJwt } from "./support/jwt.mjs";

type Outcome =
	| { ok: true; status: number; body: unknown }
	| { ok: false; error: string };

/** 在同源静态页里以 fetch 呼叫「真 bridge 地址」，回传结果 */
async function callBridge(
	page: Page,
	path: string,
	init: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<Outcome> {
	return page.evaluate(
		async ({ origin, path, init }) => {
			try {
				const headers: Record<string, string> = {};
				if (init.token) headers.Authorization = `Bearer ${init.token}`;
				if (init.body !== undefined)
					headers["Content-Type"] = "application/json";
				const response = await fetch(`${origin}${path}`, {
					method: init.method ?? "GET",
					headers,
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				});
				return {
					ok: true as const,
					status: response.status,
					body: await response.json().catch(() => null),
				};
			} catch (error) {
				return { ok: false as const, error: String(error) };
			}
		},
		{ origin: REAL_BRIDGE_ORIGIN, path, init },
	);
}

test.describe("fake bridge（路由到临时端口）", () => {
	test("状态表驱动 state/fetch/cancel/exes/launch，并记录 Authorization", async ({
		page,
		baseUrl,
		bridge,
	}) => {
		await page.goto(`${baseUrl}/game/healthz`);
		const token = validJwt("bridge-happy");
		bridge.setState("game/A", { status: "ready", exes: ["a.exe", "b.exe"] });

		const state = await callBridge(
			page,
			"/rpc/game/state?paths=game%2FA&paths=game%2FB",
			{ token },
		);
		expect(state).toMatchObject({ ok: true, status: 200 });
		const games = (
			state as { body: { games: { path: string; status: string }[] } }
		).body.games;
		expect(games.map((g) => [g.path, g.status])).toEqual([
			["game/A", "ready"],
			["game/B", "absent"],
		]);

		const fetched = await callBridge(page, "/rpc/game/fetch", {
			method: "POST",
			token,
			body: { path: "game/B" },
		});
		expect(fetched).toMatchObject({
			ok: true,
			status: 200,
			body: { status: "downloading" },
		});

		const cancelled = await callBridge(page, "/rpc/game/fetch?path=game%2FB", {
			method: "DELETE",
			token,
		});
		expect(cancelled).toMatchObject({
			ok: true,
			body: { status: "incomplete" },
		});

		const exes = await callBridge(page, "/rpc/game/exes?path=game%2FA", {
			token,
		});
		expect(exes).toMatchObject({
			ok: true,
			body: { exes: ["a.exe", "b.exe"] },
		});

		const launched = await callBridge(page, "/rpc/game/launch", {
			method: "POST",
			token,
			body: {
				path: "game/A",
				exe_relpath: "a.exe",
				game_id: 1,
				locale_emulator: false,
			},
		});
		expect(launched).toMatchObject({ ok: true, status: 200 });
		expect(bridge.games.get("game/A")?.status).toBe("running");

		expect(bridge.requests.length).toBe(5);
		for (const request of bridge.requests) {
			expect(request.authorization).toBe(`Bearer ${token}`);
			expect(request.origin).toBe(baseUrl);
		}
	});

	test("Authorization 无效或过期 → 401；故障模式 403/409/断线依次只触发一次", async ({
		page,
		baseUrl,
		bridge,
	}) => {
		await page.goto(`${baseUrl}/game/healthz`);
		const token = validJwt("bridge-faults");

		expect(await callBridge(page, "/rpc/game/state?paths=x")).toMatchObject({
			status: 401,
		});
		expect(
			await callBridge(page, "/rpc/game/state?paths=x", {
				token: expiredJwt(),
			}),
		).toMatchObject({ status: 401 });

		bridge.fail({ status: 403 });
		bridge.fail({
			path: "/launch",
			method: "POST",
			status: 409,
			body: { code: "exe_missing", error: "gone" },
		});
		bridge.fail({ mode: "close" });

		expect(
			await callBridge(page, "/rpc/game/state?paths=x", { token }),
		).toMatchObject({ status: 403 });
		expect(
			await callBridge(page, "/rpc/game/state?paths=x", { token }),
		).toMatchObject({
			ok: false,
		});
		expect(
			await callBridge(page, "/rpc/game/launch", {
				method: "POST",
				token,
				body: { path: "x" },
			}),
		).toMatchObject({ status: 409, body: { code: "exe_missing" } });
		// 故障用完后恢复正常
		expect(
			await callBridge(page, "/rpc/game/state?paths=x", { token }),
		).toMatchObject({ status: 200 });
	});

	test("fake 回传的 CORS header 不符（Origin 不同）时页面的 fetch 失败", async ({
		page,
		baseUrl,
		bridge,
	}) => {
		await page.goto(`${baseUrl}/game/healthz`);
		bridge.allowedOrigin = "https://evil.example";
		const outcome = await callBridge(page, "/rpc/game/state?paths=x", {
			token: validJwt("bridge-cors"),
		});
		expect(outcome.ok).toBe(false);
	});

	test("OPTIONS 预检：精确 Origin 才成功，含 DELETE / Authorization / Private-Network", async ({
		bridge,
		baseUrl,
	}) => {
		const preflight = (origin: string, privateNetwork = false) =>
			fetch(`${bridge.origin}/rpc/game/state`, {
				method: "OPTIONS",
				headers: {
					Origin: origin,
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "authorization",
					...(privateNetwork
						? { "Access-Control-Request-Private-Network": "true" }
						: {}),
				},
			});

		const allowed = await preflight(baseUrl, true);
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-origin")).toBe(baseUrl);
		expect(allowed.headers.get("access-control-allow-methods")).toContain(
			"DELETE",
		);
		expect(allowed.headers.get("access-control-allow-headers")).toContain(
			"Authorization",
		);
		expect(allowed.headers.get("access-control-allow-private-network")).toBe(
			"true",
		);

		const denied = await preflight("https://evil.example", true);
		expect(denied.status).toBe(403);
		expect(denied.headers.get("access-control-allow-origin")).toBeNull();
		expect(
			denied.headers.get("access-control-allow-private-network"),
		).toBeNull();

		expect((await preflight(baseUrl.replace("http:", "https:"))).status).toBe(
			403,
		);
		expect((await preflight(`${baseUrl}:1`)).status).toBe(403);
		expect(bridge).toBeInstanceOf(FakeBridge);
	});
});

test.describe("无 bridge", () => {
	test.use({ bridgeMode: "none" });

	test("route abort：请求失败且不会到达 fake bridge", async ({
		page,
		baseUrl,
		bridge,
	}) => {
		await page.goto(`${baseUrl}/game/healthz`);
		const outcome = await callBridge(page, "/rpc/game/state?paths=x", {
			token: validJwt("bridge-none"),
		});
		expect(outcome.ok).toBe(false);
		expect(bridge.requests).toEqual([]);
	});
});
