/**
 * @file E2E fixtures
 * @description 每个 BrowserContext 都安装 8081 路由，绝不会碰到真 bridge：
 * - 预设：把 http://127.0.0.1:8081/** 转发到该测试专属的 fake bridge（临时端口），
 *   并以 fake 的真实 status/headers/body 回应，同时由 harness 依 fake 回传的
 *   Access-Control-Allow-Origin 做 CORS 判定（Playwright 的 fulfill 会自动补 ACAO，见 installBridgeRoute）；
 * - `bridgeMode: "none"`：改为 route.abort()（「无 bridge」案例，不改产品码）。
 *
 * 注意：Chromium 会对被拦截的 CORS 预检自行回应，预检本身不会到 fake bridge；
 * fake bridge 的 OPTIONS 行为由 fake-bridge.spec.ts 直接以 HTTP 验证。
 */

import {
	type Browser,
	type BrowserContext,
	test as base,
	expect,
	type Page,
} from "@playwright/test";
import { FakeBridge } from "./fake-bridge.mjs";
import { validJwt } from "./jwt.mjs";
import { BASE_URL_ENV, TEST_TIMEZONE } from "./test-env.mjs";

export const REAL_BRIDGE_ORIGIN = "http://127.0.0.1:8081";

export interface Credentials {
	accounts: unknown;
	jwt: string;
}

export type BridgeMode = "fake" | "none";

export async function installBridgeRoute(
	context: BrowserContext,
	mode: BridgeMode,
	bridge: FakeBridge | null,
): Promise<void> {
	await context.route(`${REAL_BRIDGE_ORIGIN}/**`, async (route) => {
		if (mode === "none") {
			await route.abort("connectionrefused");
			return;
		}
		if (!bridge) {
			await route.abort("connectionrefused");
			return;
		}
		const request = route.request();
		const target = new URL(request.url());
		let response: Awaited<ReturnType<typeof route.fetch>>;
		try {
			response = await route.fetch({
				url: `${bridge.origin}${target.pathname}${target.search}`,
			});
		} catch {
			// fake bridge 断线（fault mode "close"）：对页面而言就是 network error
			await route.abort("connectionreset");
			return;
		}
		// Playwright 的 route.fulfill 会替跨源响应自动补上 Access-Control-Allow-Origin，
		// 浏览器本身因此不会再挡；这里改由 harness 对 fake 的「真实响应」做同样的 CORS 判定，
		// Origin 不符就中止请求（页面看到的是 network error，与真浏览器一致）。
		const origin = request.headers().origin;
		const allowOrigin = response.headers()["access-control-allow-origin"];
		if (origin && allowOrigin !== origin && allowOrigin !== "*") {
			await route.abort("failed");
			return;
		}
		await route.fulfill({ response });
	});
}

/** 在同源的静态页（healthz，不载入 app）里写入 IndexedDB，避免与 app 的读写竞争 */
export async function seedCredentials(
	page: Page,
	baseUrl: string,
	credentials: Credentials,
): Promise<void> {
	await page.goto(`${baseUrl}/game/healthz`);
	await page.evaluate(async (record) => {
		await new Promise<void>((resolve, reject) => {
			const open = indexedDB.open("teledrive-credentials", 1);
			open.onupgradeneeded = () => {
				open.result.createObjectStore("credentials");
			};
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				const tx = db.transaction("credentials", "readwrite");
				tx.objectStore("credentials").put(record, "active");
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
		});
	}, credentials);
}

/** 读取 active record（测试断言用） */
export async function readCredentials(page: Page): Promise<Credentials> {
	return page.evaluate(
		() =>
			new Promise<Credentials>((resolve, reject) => {
				const open = indexedDB.open("teledrive-credentials");
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const request = db
						.transaction("credentials", "readonly")
						.objectStore("credentials")
						.get("active");
					request.onsuccess = () => {
						db.close();
						resolve(request.result as Credentials);
					};
					request.onerror = () => reject(request.error);
				};
			}),
	);
}

export interface ServerApi {
	baseUrl: string;
	/** 以 owner token 呼叫 /game/api/rpc/{command}（测试 seed / 断言用） */
	rpc<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
	version(): Promise<number>;
	putCover(
		gameId: number,
		bytes: Buffer,
	): Promise<{ cover_version: string | null }>;
	deleteCover(gameId: number): Promise<{ cover_version: string | null }>;
	/** 建立一个手动游戏并返回 id */
	createGame(name: string): Promise<number>;
}

function createServerApi(baseUrl: string): ServerApi {
	const auth = () => ({ Authorization: `Bearer ${validJwt()}` });
	async function json<T>(response: Response, what: string): Promise<T> {
		if (!response.ok) {
			throw new Error(
				`${what} -> HTTP ${response.status}: ${await response.text()}`,
			);
		}
		return (await response.json()) as T;
	}
	const rpc: ServerApi["rpc"] = async (command, args = {}) =>
		json(
			await fetch(`${baseUrl}/game/api/rpc/${command}`, {
				method: "POST",
				headers: { ...auth(), "Content-Type": "application/json" },
				body: JSON.stringify(args),
			}),
			command,
		);
	return {
		baseUrl,
		rpc,
		async version() {
			const body = await json<{ data_version: number }>(
				await fetch(`${baseUrl}/game/api/version`, { headers: auth() }),
				"version",
			);
			return body.data_version;
		},
		async putCover(gameId, bytes) {
			return json(
				await fetch(`${baseUrl}/game/api/covers/${gameId}`, {
					method: "PUT",
					headers: { ...auth(), "Content-Type": "application/octet-stream" },
					body: new Uint8Array(bytes),
				}),
				"put cover",
			);
		},
		async deleteCover(gameId) {
			return json(
				await fetch(`${baseUrl}/game/api/covers/${gameId}`, {
					method: "DELETE",
					headers: auth(),
				}),
				"delete cover",
			);
		},
		async createGame(name) {
			const game = await rpc<{ id: number }>("insert_game", {
				game: {
					id_type: "custom",
					custom_data: { name },
				},
			});
			return game.id;
		},
	};
}

interface E2EFixtures {
	baseUrl: string;
	server: ServerApi;
	bridge: FakeBridge;
	bridgeMode: BridgeMode;
	/** 与预设 context 相同配置的额外 BrowserContext（独立 IndexedDB，模拟另一台装置） */
	newDevice: () => Promise<BrowserContext>;
}

export const test = base.extend<E2EFixtures>({
	baseUrl: async ({ browserName: _ }, use) => {
		const baseUrl = process.env[BASE_URL_ENV];
		if (!baseUrl)
			throw new Error(`${BASE_URL_ENV} 未设定：globalSetup 没有执行？`);
		await use(baseUrl);
	},
	server: async ({ baseUrl }, use) => {
		await use(createServerApi(baseUrl));
	},
	bridgeMode: ["fake", { option: true }],
	bridge: async ({ baseUrl }, use) => {
		const bridge = await new FakeBridge({ allowedOrigin: baseUrl }).start();
		await use(bridge);
		await bridge.stop();
	},
	context: async ({ context, bridge, bridgeMode }, use) => {
		await installBridgeRoute(context, bridgeMode, bridge);
		await use(context);
	},
	newDevice: async ({ browser, bridge, bridgeMode }, use) => {
		const opened: BrowserContext[] = [];
		await use(async () => {
			const context = await browser.newContext({
				timezoneId: TEST_TIMEZONE,
				locale: "zh-CN",
			});
			await installBridgeRoute(context, bridgeMode, bridge);
			opened.push(context);
			return context;
		});
		for (const context of opened) await context.close();
	},
});

export type { Browser };
export { expect };
