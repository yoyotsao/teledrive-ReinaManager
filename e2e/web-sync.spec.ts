/**
 * 17B Step 5：cover / cache / version 多 context。
 * 两个独立 BrowserContext = 两台装置（各自的 IndexedDB），用 focus 事件触发版本检查
 * （不等 60 秒轮询；长时间无变更观察在 web-idle-polling.spec.ts）。
 */

import type { Page } from "@playwright/test";
import {
	expect,
	type ServerApi,
	seedCredentials,
	test,
} from "./support/fixtures";
import { validJwt } from "./support/jwt.mjs";
import { BLUE_PNG, RED_PNG, solidPng } from "./support/png.mjs";

const ACCOUNTS = [{ id: "sync-sentinel", session: "FAKE-SESSION-NOT-REAL" }];

/** 以独立装置身分登入并打开页面（凭证在不载入 app 的静态页里种入） */
async function openDevice(page: Page, baseUrl: string, path: string) {
	await seedCredentials(page, baseUrl, {
		accounts: ACCOUNTS,
		jwt: validJwt(`sync-${Math.random().toString(36).slice(2)}`),
	});
	await page.goto(`${baseUrl}${path}`);
}

/** 模拟窗口回到前景：useServerVersionSync 会立刻检查一次版本 */
async function focusNow(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

function coverRequests(page: Page): string[] {
	const urls: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			request.method() === "GET" &&
			/^\/game\/api\/covers\/\d+$/.test(url.pathname)
		) {
			urls.push(`${url.pathname}${url.search}`);
		}
	});
	return urls;
}

/** 在详情页「编辑」分页：改名称 / 选封面 / 移除自定义封面，然后保存并等待对应的 API 完成 */
async function saveEdit(
	page: Page,
	edit: { name?: string; cover?: Buffer; removeCover?: boolean },
) {
	await page.getByRole("tab", { name: "编辑" }).click();
	if (edit.name !== undefined) {
		await page.getByLabel("自定义游戏名称").fill(edit.name);
	}
	if (edit.cover) {
		await page.locator('input[type="file"]').setInputFiles({
			name: "cover.png",
			mimeType: "image/png",
			buffer: edit.cover,
		});
	}
	if (edit.removeCover) {
		await page.getByRole("button", { name: "移除自定义封面" }).click();
	}
	const done: Promise<unknown>[] = [];
	if (edit.name !== undefined) {
		done.push(
			page.waitForResponse(
				(r) =>
					r.url().endsWith("/game/api/rpc/update_game") && r.status() === 200,
			),
		);
	}
	if (edit.cover) {
		done.push(
			page.waitForResponse(
				(r) =>
					r.request().method() === "PUT" &&
					/\/game\/api\/covers\/\d+$/.test(r.url()) &&
					r.status() === 200,
			),
		);
	}
	if (edit.removeCover) {
		done.push(
			page.waitForResponse(
				(r) =>
					r.request().method() === "DELETE" &&
					/\/game\/api\/covers\/\d+$/.test(r.url()) &&
					r.status() === 200,
			),
		);
	}
	await page.getByRole("button", { name: "保存所有更改" }).click();
	await Promise.all(done);
}

/** 详情页的封面 <img>（alt 为游戏名称） */
const coverImg = (page: Page, gameName: string) =>
	page.getByRole("img", { name: gameName }).first();

async function gameName(server: ServerApi, id: number): Promise<string | null> {
	const game = await server.rpc<{
		custom_data?: { name?: string };
	} | null>("find_game_by_id", { id });
	return game?.custom_data?.name ?? null;
}

test.describe("多装置同步", () => {
	test("A 新增游戏 + 换封面：B 保持打开，focus 后看到新游戏与新封面 URL", async ({
		page: deviceA,
		newDevice,
		baseUrl,
		server,
	}) => {
		const baseId = await server.createGame("Sync1-Base");
		const deviceB = await (await newDevice()).newPage();
		await openDevice(deviceA, baseUrl, "/game/libraries");
		await openDevice(deviceB, baseUrl, "/game/libraries");
		await expect(deviceB.getByText("Sync1-Base").first()).toBeVisible();
		await expect(deviceA.getByText("Sync1-Base").first()).toBeVisible();
		const requestsB = coverRequests(deviceB);
		// 封面尚未设定：B 显示预设图，也没有封面请求
		await expect(coverImg(deviceB, "Sync1-Base")).toHaveAttribute(
			"src",
			/default\.png/,
		);

		// 装置 A 的写入（经由真实 server API）：新增游戏并设定封面
		await server.createGame("Sync1-New");
		const { cover_version } = await server.putCover(baseId, RED_PNG());
		expect(cover_version).toBeTruthy();

		// B 没有重新整理，只是回到前景
		await expect(deviceB.getByText("Sync1-New")).toHaveCount(0);
		await focusNow(deviceB);
		await expect(deviceB.getByText("Sync1-New").first()).toBeVisible();
		await expect(coverImg(deviceB, "Sync1-Base")).toHaveAttribute(
			"src",
			/^blob:/,
		);
		expect(requestsB).toContain(
			`/game/api/covers/${baseId}?v=${cover_version}`,
		);
	});

	test("B 的写入不会遮住 A 先前的修改：本地写入回传的版本不算已同步", async ({
		page: deviceA,
		newDevice,
		baseUrl,
		server,
	}) => {
		const g1 = await server.createGame("Sync2-G1");
		const g2 = await server.createGame("Sync2-G2");
		const deviceB = await (await newDevice()).newPage();
		await openDevice(deviceA, baseUrl, "/game/libraries");
		// B 先看过收藏夹（此 query 之后不会被游戏写入的 invalidate 重新读取）
		await openDevice(deviceB, baseUrl, "/game/collection");
		await expect(deviceB.getByRole("heading").first()).toBeVisible();
		await expect(deviceA.getByText("Sync2-G1").first()).toBeVisible();

		// A 的先前修改：改 G1 名称（真 UI）+ 建立收藏夹（B 尚未同步的资料）
		await deviceA.goto(`${baseUrl}/game/libraries/${g1}`);
		await expect(
			deviceA.getByRole("heading", { name: "Sync2-G1" }),
		).toBeVisible();
		await saveEdit(deviceA, { name: "Sync2-G1-byA" });
		await server.rpc("create_collection", {
			name: "Sync2-Collection-byA",
			parentId: null,
			sortOrder: 0,
			icon: null,
		});

		// B 尚未同步就做自己的写入：改 G2（真 UI，从游戏仓库以站内导航进入详情）
		await deviceB.getByRole("link", { name: "游戏仓库" }).first().click();
		await deviceB.getByText("Sync2-G2").first().click();
		await expect(
			deviceB.getByRole("heading", { name: "Sync2-G2" }),
		).toBeVisible();
		await saveEdit(deviceB, { name: "Sync2-G2-byB" });

		// 伺服器上两个修改都在
		expect(await gameName(server, g1)).toBe("Sync2-G1-byA");
		expect(await gameName(server, g2)).toBe("Sync2-G2-byB");

		// B 回前景：必须重新读取，看到 A 的收藏夹（若 B 采用了自己写入回传的版本就永远看不到）
		await focusNow(deviceB);
		await deviceB.getByRole("link", { name: "收藏夹" }).first().click();
		await expect(
			deviceB.getByText("Sync2-Collection-byA").first(),
		).toBeVisible();
		await deviceB.getByRole("link", { name: "游戏仓库" }).first().click();
		await expect(deviceB.getByText("Sync2-G1-byA").first()).toBeVisible();
		await expect(deviceB.getByText("Sync2-G2-byB").first()).toBeVisible();

		// A 回前景：B 的修改出现，A 自己先前的修改也没有被覆盖
		await focusNow(deviceA);
		await deviceA.goto(`${baseUrl}/game/libraries`);
		await expect(deviceA.getByText("Sync2-G1-byA").first()).toBeVisible();
		await expect(deviceA.getByText("Sync2-G2-byB").first()).toBeVisible();
	});

	test("A 上传/移除自定义封面（UI）：reload 后一致，B 经 focus 得到相同状态", async ({
		page: deviceA,
		newDevice,
		baseUrl,
		server,
	}) => {
		const id = await server.createGame("Sync3-Cover");
		const deviceB = await (await newDevice()).newPage();
		await openDevice(deviceA, baseUrl, `/game/libraries/${id}`);
		await openDevice(deviceB, baseUrl, `/game/libraries/${id}`);
		await expect(coverImg(deviceA, "Sync3-Cover")).toHaveAttribute(
			"src",
			/default\.png/,
		);
		await expect(coverImg(deviceB, "Sync3-Cover")).toHaveAttribute(
			"src",
			/default\.png/,
		);
		const requestsA = coverRequests(deviceA);
		const requestsB = coverRequests(deviceB);

		// 上传
		// （详情页主图在同装置上要等下一次版本检查/reload 才换新，所以这里不立刻断言主图）
		await saveEdit(deviceA, { cover: RED_PNG() });
		const uploaded = await server.rpc<{ cover_version: string | null }>(
			"find_game_by_id",
			{ id },
		);
		const version1 = uploaded.cover_version;
		expect(version1).toBeTruthy();

		await deviceA.reload();
		await expect(coverImg(deviceA, "Sync3-Cover")).toHaveAttribute(
			"src",
			/^blob:/,
		);
		expect(requestsA.some((u) => u.endsWith(`?v=${version1}`))).toBe(true);

		await focusNow(deviceB);
		await expect(coverImg(deviceB, "Sync3-Cover")).toHaveAttribute(
			"src",
			/^blob:/,
		);
		expect(requestsB.some((u) => u.endsWith(`?v=${version1}`))).toBe(true);

		// 移除
		await saveEdit(deviceA, { removeCover: true });
		await deviceA.reload();
		await expect(coverImg(deviceA, "Sync3-Cover")).toHaveAttribute(
			"src",
			/default\.png/,
		);

		// 上一次 focus 触发的检查可能还在（重试中的）进行，checker 会合并同时进行的检查；
		// focus 是幂等的，所以反复 focus 直到检查真正读到新版本
		await expect(async () => {
			await focusNow(deviceB);
			await expect(coverImg(deviceB, "Sync3-Cover")).toHaveAttribute(
				"src",
				/default\.png/,
				{ timeout: 2000 },
			);
		}).toPass({ timeout: 20_000 });
	});

	test("同一个封面 URL 的内容不可变；封面改变后 URL（query key）随之改变", async ({
		page,
		baseUrl,
		server,
	}) => {
		const id = await server.createGame("Sync4-Immutable");
		const auth = { Authorization: `Bearer ${validJwt("sync4")}` };
		const get = (query: string, extra: Record<string, string> = {}) =>
			fetch(`${baseUrl}/game/api/covers/${id}${query}`, {
				headers: { ...auth, ...extra },
				redirect: "manual",
			});

		const red = RED_PNG();
		const { cover_version: v1 } = await server.putCover(id, red);
		expect(v1).toBeTruthy();
		const first = await get(`?v=${v1}`);
		const second = await get(`?v=${v1}`);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toContain("immutable");
		expect(first.headers.get("etag")).toBe(`"${v1}"`);
		expect(Buffer.from(await first.arrayBuffer()).equals(red)).toBe(true);
		expect(Buffer.from(await second.arrayBuffer()).equals(red)).toBe(true);
		expect((await get(`?v=${v1}`, { "If-None-Match": `"${v1}"` })).status).toBe(
			304,
		);

		// 换封面：版本改变；旧版本 URL 不会再回传不同内容（只会 302 到新 URL）
		const { cover_version: v2 } = await server.putCover(id, BLUE_PNG());
		expect(v2).toBeTruthy();
		expect(v2).not.toBe(v1);
		const stale = await get(`?v=${v1}`);
		expect(stale.status).toBe(302);
		expect(stale.headers.get("location")).toBe(
			`/game/api/covers/${id}?v=${v2}`,
		);

		// 浏览器端：开着的页面 focus 后改用新版本的 URL 取封面
		await openDevice(page, baseUrl, `/game/libraries/${id}`);
		await expect(coverImg(page, "Sync4-Immutable")).toHaveAttribute(
			"src",
			/^blob:/,
		);
		const requests = coverRequests(page);
		const { cover_version: v3 } = await server.putCover(
			id,
			solidPng([30, 200, 30]),
		);
		expect(v3).not.toBe(v2);
		await focusNow(page);
		await expect
			.poll(() => requests.some((u) => u.endsWith(`?v=${v3}`)))
			.toBe(true);
		expect(requests.every((u) => !u.endsWith(`?v=${v1}`))).toBe(true);
	});
});
