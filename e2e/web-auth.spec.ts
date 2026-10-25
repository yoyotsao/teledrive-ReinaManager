/**
 * 17B Step 4：IndexedDB 登入凭证、深层路由、token 刷新与跨分页竞争。
 * 凭证 fixture 一律是假的（sentinel accounts + 测试密钥签的 JWT）。
 */

import type { Page } from "@playwright/test";
import {
	expect,
	readCredentials,
	seedCredentials,
	test,
} from "./support/fixtures";
import { expiredJwt, validJwt } from "./support/jwt.mjs";

const SENTINEL_ACCOUNTS = [
	{
		id: "sentinel-account-1",
		session: "FAKE-SESSION-STRING-NOT-REAL",
		nested: { list: [1, 2, 3], flag: true },
	},
];

const GATE_TITLE = "请先登录 TeleDrive";

function trackApiRequests(page: Page) {
	const urls: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/game/api/")) urls.push(url.pathname);
	});
	return urls;
}

test.describe("IndexedDB auth 与深层路由", () => {
	test("没有 IndexedDB 凭证：只显示登入提示与回 TeleDrive 的链接，不发 API 请求", async ({
		page,
		baseUrl,
	}) => {
		const apiRequests = trackApiRequests(page);
		await page.goto(`${baseUrl}/game/`);

		await expect(page.getByRole("heading", { name: GATE_TITLE })).toBeVisible();
		const link = page.getByRole("link", { name: "前往 TeleDrive 登录" });
		await expect(link).toHaveAttribute("href", "/");
		expect(apiRequests).toEqual([]);
	});

	test("凭证纪录存在但没有 jwt：同样显示登入提示", async ({
		page,
		baseUrl,
	}) => {
		await seedCredentials(page, baseUrl, {
			accounts: SENTINEL_ACCOUNTS,
			jwt: "",
		});
		const apiRequests = trackApiRequests(page);
		await page.goto(`${baseUrl}/game/`);

		await expect(page.getByRole("heading", { name: GATE_TITLE })).toBeVisible();
		await expect(
			page.getByRole("link", { name: "前往 TeleDrive 登录" }),
		).toHaveAttribute("href", "/");
		expect(apiRequests).toEqual([]);
	});

	test("有效 jwt：/game/ 正常载入，并以 Bearer 呼叫 server", async ({
		page,
		baseUrl,
		server,
	}) => {
		const gameId = await server.createGame("Auth-Valid-Game");
		const jwt = validJwt("valid-home");
		await seedCredentials(page, baseUrl, {
			accounts: SENTINEL_ACCOUNTS,
			jwt,
		});
		const authorizations: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/game/api/version") {
				authorizations.push(request.headers().authorization ?? "");
			}
		});

		await page.goto(`${baseUrl}/game/`);
		await expect(page.getByRole("link", { name: "游戏仓库" })).toBeVisible();
		await expect(page.getByRole("heading", { name: GATE_TITLE })).toHaveCount(
			0,
		);

		await page.getByRole("link", { name: "游戏仓库" }).click();
		await expect(page).toHaveURL(`${baseUrl}/game/libraries`);
		await expect(page.getByText("Auth-Valid-Game").first()).toBeVisible();
		expect(gameId).toBeGreaterThan(0);
		expect(authorizations.length).toBeGreaterThan(0);
		expect(new Set(authorizations)).toEqual(new Set([`Bearer ${jwt}`]));
	});

	test("直接开 /game/libraries/<id> 与 reload 都不 404", async ({
		page,
		baseUrl,
		server,
	}) => {
		const gameId = await server.createGame("Auth-DeepRoute-Game");
		await seedCredentials(page, baseUrl, {
			accounts: SENTINEL_ACCOUNTS,
			jwt: validJwt("deep-route"),
		});
		const url = `${baseUrl}/game/libraries/${gameId}`;

		const first = await page.goto(url);
		expect(first?.status()).toBe(200);
		await expect(
			page.getByRole("heading", { name: "Auth-DeepRoute-Game" }),
		).toBeVisible();

		const reloaded = await page.reload();
		expect(reloaded?.status()).toBe(200);
		await expect(page).toHaveURL(url);
		await expect(
			page.getByRole("heading", { name: "Auth-DeepRoute-Game" }),
		).toBeVisible();
	});

	test("jwt 过期 + refresh stub：新 jwt 写回，accounts sentinel 完整不变", async ({
		page,
		context,
		baseUrl,
		server,
	}) => {
		await server.createGame("Auth-Refresh-Game");
		const stale = expiredJwt("stale-refresh");
		const fresh = validJwt("fresh-refresh");
		await seedCredentials(page, baseUrl, {
			accounts: SENTINEL_ACCOUNTS,
			jwt: stale,
		});

		const refreshCalls: { method: string; authorization?: string }[] = [];
		await context.route(`${baseUrl}/api/v1/auth/refresh`, async (route) => {
			const request = route.request();
			refreshCalls.push({
				method: request.method(),
				authorization: request.headers().authorization,
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ token: fresh }),
			});
		});

		await page.goto(`${baseUrl}/game/libraries`);
		await expect(page.getByText("Auth-Refresh-Game").first()).toBeVisible();

		expect(refreshCalls).toEqual([
			{ method: "POST", authorization: `Bearer ${stale}` },
		]);
		const stored = await readCredentials(page);
		expect(stored.jwt).toBe(fresh);
		expect(stored.accounts).toEqual(SENTINEL_ACCOUNTS);
	});

	test("refresh 期间另一同源分页改 accounts：最后保留最新 accounts 与新 jwt", async ({
		context,
		baseUrl,
		server,
	}) => {
		await server.createGame("Auth-Race-Game");
		const stale = expiredJwt("stale-race");
		const fresh = validJwt("fresh-race");
		const accountsA = SENTINEL_ACCOUNTS;
		const accountsB = [
			{
				id: "sentinel-account-B-newer",
				session: "FAKE-SESSION-STRING-B-NOT-REAL",
				nested: { list: [9, 8, 7], flag: false },
			},
			{ id: "sentinel-account-B-second", session: "FAKE-SECOND" },
		];

		// 同一个 BrowserContext 的两个同源分页 → 共用 IndexedDB
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		// 只初始化一次 active record（在不载入 app 的静态页里，不用每次导航都覆写的 init script）
		await seedCredentials(pageA, baseUrl, { accounts: accountsA, jwt: stale });
		await pageB.goto(`${baseUrl}/game/healthz`);

		// barrier：refresh request 抵达后暂停，直到测试放行
		let refreshCount = 0;
		let onRefreshArrived: () => void = () => {};
		const refreshArrived = new Promise<void>((resolve) => {
			onRefreshArrived = resolve;
		});
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		await context.route(`${baseUrl}/api/v1/auth/refresh`, async (route) => {
			refreshCount += 1;
			onRefreshArrived();
			await released;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ token: fresh }),
			});
		});

		// A：以过期 jwt 载入 app，发起 authenticated request（首个 401 触发 refresh）
		await pageA.goto(`${baseUrl}/game/libraries`);
		await refreshArrived;

		// refresh 回应仍暂停：B 以 readwrite transaction 更新 accounts，等 transaction.oncomplete
		await pageB.evaluate(
			(newAccounts) =>
				new Promise<void>((resolve, reject) => {
					const open = indexedDB.open("teledrive-credentials");
					open.onerror = () => reject(open.error);
					open.onsuccess = () => {
						const db = open.result;
						const tx = db.transaction("credentials", "readwrite");
						const store = tx.objectStore("credentials");
						const get = store.get("active");
						get.onsuccess = () => {
							store.put({ ...get.result, accounts: newAccounts }, "active");
						};
						tx.oncomplete = () => {
							db.close();
							resolve();
						};
						tx.onerror = () => reject(tx.error);
						tx.onabort = () => reject(tx.error);
					};
				}),
			accountsB,
		);

		// 放行 A 的 refresh；A retry 成功 → 游戏出现
		release();
		await expect(pageA.getByText("Auth-Race-Game").first()).toBeVisible();

		expect(refreshCount).toBe(1);
		for (const page of [pageA, pageB]) {
			const stored = await readCredentials(page);
			expect(stored.jwt).toBe(fresh);
			expect(stored.accounts).toEqual(accountsB);
		}
	});
});
