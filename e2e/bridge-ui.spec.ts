/**
 * 17B Step 6：fake bridge 驱动的游戏控制 UI 状态机。
 * bridge 状态一律由 fake bridge 的状态表 / 故障模式提供（见 support/fake-bridge.mjs），
 * 8081 请求由 fixtures 的 route 转发到临时端口，从不接触真 bridge。
 * 同步一律事件驱动（expect / expect.poll / waitForResponse），没有固定 sleep。
 */

import type { Page } from "@playwright/test";
import type { FakeBridge } from "./support/fake-bridge.mjs";
import {
	expect,
	type ServerApi,
	seedCredentials,
	test,
} from "./support/fixtures";
import { validJwt } from "./support/jwt.mjs";
import { RED_PNG } from "./support/png.mjs";

const ACCOUNTS = [{ id: "bridge-sentinel", session: "FAKE-SESSION-NOT-REAL" }];

let counter = 0;
/** 每个测试独立的 TeleDrive 路径（server/DB 与 fake bridge 状态都不共用） */
function uniquePath(tag: string) {
	counter += 1;
	return `e2e/${tag}-${Date.now().toString(36)}-${counter}`;
}

async function createCloudGame(
	server: ServerApi,
	name: string,
	teledrivePath: string,
	extra: Record<string, unknown> = {},
): Promise<number> {
	const game = await server.rpc<{ id: number }>("insert_game", {
		game: {
			id_type: "custom",
			teledrive_path: teledrivePath,
			custom_data: { name },
			...extra,
		},
	});
	return game.id;
}

async function login(page: Page, baseUrl: string) {
	await seedCredentials(page, baseUrl, { accounts: ACCOUNTS, jwt: validJwt() });
}

async function openDetail(page: Page, baseUrl: string, id: number) {
	await page.goto(`${baseUrl}/game/libraries/${id}`);
}

function stateRequests(bridge: FakeBridge) {
	return bridge.requests.filter(
		(r) => r.method === "GET" && r.path === "/rpc/game/state",
	);
}

async function focusNow(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

/** 记录页面发往 reina-server 的写入 / 版本请求（判断「不自行捏造 stats」） */
function watchServerCalls(page: Page) {
	const calls: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/game/api/")) {
			calls.push(`${request.method()} ${url.pathname}`);
		}
	});
	return calls;
}

/** 详情页内容区（工具栏 banner 里还有一份同状态的启动按钮，这里只断言主内容） */
const main = (page: Page) => page.getByRole("main");
const btn = (page: Page, name: string | RegExp) =>
	main(page).getByRole("button", { name });

test.describe("bridge 游戏控制状态机", () => {
	test("absent → 下载；downloading → 进度 + 取消；取消后 incomplete；继续下载 → ready", async ({
		page,
		baseUrl,
		server,
		bridge,
	}) => {
		const path = uniquePath("dl");
		const id = await createCloudGame(server, "Bridge-Download", path);
		await login(page, baseUrl);
		await openDetail(page, baseUrl, id);

		// absent：显示下载按钮
		await expect(btn(page, "下载到本机")).toBeVisible();

		// 点下载 → POST /fetch，状态表变 downloading
		await btn(page, "下载到本机").click();
		await expect.poll(() => bridge.games.get(path)?.status).toBe("downloading");
		bridge.transition(path, {
			completed_bytes: 512 * 1024 * 1024,
			total_bytes: 1024 * 1024 * 1024,
		});
		// downloading：进度文字 + 进度条 + 取消按钮（2 秒轮询取得最新进度）
		await expect(main(page).getByText("正在下载")).toBeVisible();
		await expect(main(page).getByText("512.0 MB / 1.0 GB")).toBeVisible();
		await expect(main(page).getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"50",
		);
		await expect(btn(page, "取消下载")).toBeVisible();

		// 取消 → DELETE /fetch → incomplete，UI 出现「继续下载」并保留错误说明
		bridge.transition(path, { error: "下载被取消" });
		await btn(page, "取消下载").click();
		await expect.poll(() => bridge.games.get(path)?.status).toBe("incomplete");
		await expect(btn(page, "继续下载")).toBeVisible();
		await expect(main(page).getByText("下载被取消")).toBeVisible();
		expect(
			bridge.requests.some(
				(r) => r.method === "DELETE" && r.path === "/rpc/game/fetch",
			),
		).toBe(true);

		// resume → downloading → 下载完成 ready（无 exe_relpath：显示选择 exe 按钮）
		await btn(page, "继续下载").click();
		await expect.poll(() => bridge.games.get(path)?.status).toBe("downloading");
		await expect(btn(page, "取消下载")).toBeVisible();
		bridge.transition(path, { status: "ready", error: null });
		await expect(btn(page, "选择可执行文件")).toBeVisible();
		await expect(btn(page, "取消下载")).toHaveCount(0);
	});

	test("ready 且没有 exe_relpath → exe 选择；保存 exe_relpath 后可启动；running 显示已过时间", async ({
		page,
		baseUrl,
		server,
		bridge,
	}) => {
		const path = uniquePath("exe");
		const id = await createCloudGame(server, "Bridge-Exe", path);
		bridge.setState(path, {
			status: "ready",
			exes: ["Game/game.exe", "Game/config.exe"],
		});
		await login(page, baseUrl);
		await openDetail(page, baseUrl, id);

		// ready / 无 exe_relpath → 「选择可执行文件」按钮，点了向 bridge 要 exe 清单
		await btn(page, "选择可执行文件").click();
		const select = main(page).getByRole("combobox", { name: "选择可执行文件" });
		await expect(select).toBeVisible();
		await expect(select.locator("option")).toHaveText([
			"选择可执行文件",
			"Game/game.exe",
			"Game/config.exe",
		]);
		expect(
			bridge.requests.some(
				(r) => r.path === "/rpc/game/exes" && r.search.includes("path="),
			),
		).toBe(true);

		// 选择后写入 server（update_game exe_relpath）
		const saved = page.waitForResponse(
			(r) =>
				r.url().endsWith("/game/api/rpc/update_game") && r.status() === 200,
		);
		await select.selectOption("Game/game.exe");
		await saved;
		const stored = await server.rpc<{ exe_relpath: string | null }>(
			"find_game_by_id",
			{ id },
		);
		expect(stored.exe_relpath).toBe("Game/game.exe");

		// 有 exe_relpath → 出现「启动游戏」，启动请求带 exe_relpath / game_id
		await expect(btn(page, "启动游戏")).toBeVisible();
		await btn(page, "启动游戏").click();
		await expect.poll(() => bridge.games.get(path)?.status).toBe("running");
		const launch = bridge.requests.find((r) => r.path === "/rpc/game/launch");
		expect(launch?.body).toMatchObject({
			path,
			exe_relpath: "Game/game.exe",
			game_id: id,
			locale_emulator: false,
		});

		// running：显示「运行中 + elapsed」
		bridge.transition(path, { elapsed_seconds: 125 });
		await focusNow(page);
		await expect(btn(page, /运行中\s*2:05/)).toBeDisabled();
	});

	test("launch 回 409 bridge_exe_invalid → 提示重新选 exe，且不清 server 上的 exe_relpath", async ({
		page,
		baseUrl,
		server,
		bridge,
	}) => {
		const path = uniquePath("409");
		const id = await createCloudGame(server, "Bridge-409", path, {
			exe_relpath: "Old/old.exe",
		});
		bridge.setState(path, {
			status: "ready",
			exes: ["New/new.exe"],
		});
		bridge.fail({
			method: "POST",
			path: "/launch",
			status: 409,
			body: { code: "bridge_exe_invalid", error: "exe changed" },
		});
		await login(page, baseUrl);
		await openDetail(page, baseUrl, id);

		await btn(page, "启动游戏").click();
		await expect(
			page.getByText("游戏文件已变化，请重新选择可执行文件"),
		).toBeVisible();
		// 直接展开 exe 清单供重新选择
		const select = main(page).getByRole("combobox", { name: "选择可执行文件" });
		await expect(select).toBeVisible();
		await expect(select.locator("option")).toHaveText([
			"选择可执行文件",
			"New/new.exe",
		]);
		// 在使用者重选之前，server 上共用的 exe_relpath 保持不变
		const before = await server.rpc<{ exe_relpath: string | null }>(
			"find_game_by_id",
			{ id },
		);
		expect(before.exe_relpath).toBe("Old/old.exe");
		// 状态表没有变成 running
		expect(bridge.games.get(path)?.status).toBe("ready");

		// 重选后覆写 exe_relpath
		const saved = page.waitForResponse(
			(r) =>
				r.url().endsWith("/game/api/rpc/update_game") && r.status() === 200,
		);
		await select.selectOption("New/new.exe");
		await saved;
		const after = await server.rpc<{ exe_relpath: string | null }>(
			"find_game_by_id",
			{ id },
		);
		expect(after.exe_relpath).toBe("New/new.exe");
		await expect(btn(page, "启动游戏")).toBeVisible();
	});

	test("running 结束 → 触发 server version 检查，不自行捏造 stats", async ({
		page,
		baseUrl,
		server,
		bridge,
	}) => {
		const path = uniquePath("run");
		const id = await createCloudGame(server, "Bridge-Run", path, {
			exe_relpath: "Run/run.exe",
		});
		bridge.setState(path, {
			status: "running",
			elapsed_seconds: 61,
			exes: ["Run/run.exe"],
		});
		await login(page, baseUrl);
		const serverCalls = watchServerCalls(page);
		await openDetail(page, baseUrl, id);
		await expect(btn(page, /运行中\s*1:01/)).toBeDisabled();

		// 记录结束前 server 收到的调用；此后只允许出现 GET /version
		const versionsBefore = () =>
			serverCalls.filter((c) => c === "GET /game/api/version").length;
		const mark = serverCalls.length;
		const versionMark = versionsBefore();

		// 游戏结束（bridge 上不再 running）：由 10 秒 running 轮询发现，无需 focus
		bridge.transition(path, { status: "ready", elapsed_seconds: 0 });
		await expect(btn(page, "启动游戏")).toBeVisible({ timeout: 20_000 });
		await expect
			.poll(() => versionsBefore(), { timeout: 10_000 })
			.toBeGreaterThan(versionMark);

		// 结束之后的 server 调用里没有任何 stats 写入（create_manual_game_session / sessions）
		const after = serverCalls.slice(mark);
		expect(
			after.filter(
				(c) =>
					c.startsWith("POST") &&
					(c.includes("/sessions") ||
						c.includes("create_manual_game_session") ||
						c.includes("rebuild_game_statistics")),
			),
		).toEqual([]);
		const stats = await server.rpc<{ session_count?: number } | null>(
			"get_game_statistics",
			{ gameId: id },
		);
		expect(stats?.session_count ?? 0).toBe(0);
	});

	test("bridge 403 与 network unavailable 显示不同原因", async ({
		page,
		baseUrl,
		server,
		bridge,
	}) => {
		const path = uniquePath("err");
		const id = await createCloudGame(server, "Bridge-Errors", path);
		bridge.setState(path, { status: "absent" });

		// 403：state 请求一直被拒
		bridge.fail({
			method: "GET",
			path: "/state",
			status: 403,
			times: Number.POSITIVE_INFINITY,
			body: { code: "origin_not_allowed", error: "origin not allowed" },
		});
		await login(page, baseUrl);
		await openDetail(page, baseUrl, id);
		await expect(btn(page, "本机 bridge 拒绝访问")).toBeDisabled();
		await expect(btn(page, /本机 bridge 不可用/)).toHaveCount(0);

		// 网络断线：同一页 focus 重新读取，改成 close 故障
		bridge.faults.length = 0;
		bridge.fail({
			method: "GET",
			path: "/state",
			mode: "close",
			times: Number.POSITIVE_INFINITY,
		});
		await focusNow(page);
		await expect(
			btn(page, "本机 bridge 不可用，请启动服务并检查浏览器权限"),
		).toBeDisabled();
		await expect(btn(page, "本机 bridge 拒绝访问")).toHaveCount(0);

		// 恢复后 focus 立即回到正常控制
		bridge.faults.length = 0;
		await focusNow(page);
		await expect(btn(page, "下载到本机")).toBeVisible();
	});

	test.describe("没有 bridge 的 context", () => {
		test.use({ bridgeMode: "none" });

		test("下载/执行控制不可用，但 metadata 编辑、封面与云端扫描页仍可用", async ({
			page,
			baseUrl,
			server,
			bridge,
		}) => {
			const path = uniquePath("nobridge");
			const id = await createCloudGame(server, "Bridge-None", path);
			// 一个待确认的扫描条目，验证扫描分页可读写
			await server.rpc("insert_game", {
				game: {
					id_type: "custom",
					teledrive_path: uniquePath("scan-pending"),
					scan_status: "pending",
					scan_candidates: [],
					custom_data: { name: "Bridge-None-Pending" },
				},
			});
			await login(page, baseUrl);
			await openDetail(page, baseUrl, id);

			// 只有下载/执行控制 disabled（原因：bridge 不可用），其它功能提示不受影响
			await expect(
				btn(page, "本机 bridge 不可用，请启动服务并检查浏览器权限"),
			).toBeDisabled();
			await expect(
				main(page).getByText("游戏资料编辑、扫描和封面功能仍可使用"),
			).toBeVisible();
			expect(bridge.requests).toHaveLength(0);

			// 编辑 metadata + 上传自定义封面
			await page.getByRole("tab", { name: "编辑" }).click();
			await page.getByLabel("自定义游戏名称").fill("Bridge-None-Renamed");
			await page.locator('input[type="file"]').setInputFiles({
				name: "cover.png",
				mimeType: "image/png",
				buffer: RED_PNG(),
			});
			const updated = page.waitForResponse(
				(r) =>
					r.url().endsWith("/game/api/rpc/update_game") && r.status() === 200,
			);
			const cover = page.waitForResponse(
				(r) =>
					r.request().method() === "PUT" &&
					/\/game\/api\/covers\/\d+$/.test(r.url()) &&
					r.status() === 200,
			);
			await page.getByRole("button", { name: "保存所有更改" }).click();
			await Promise.all([updated, cover]);
			const stored = await server.rpc<{
				custom_data?: { name?: string };
				cover_version: string | null;
				has_custom_cover: boolean;
			}>("find_game_by_id", { id });
			expect(stored.custom_data?.name).toBe("Bridge-None-Renamed");
			expect(stored.has_custom_cover).toBe(true);
			expect(stored.cover_version).toBeTruthy();

			// 云端扫描页：能载入 pending 清单（reina-server API，不经 bridge）
			await page.goto(`${baseUrl}/game/libraries`);
			await page.getByRole("button", { name: "添加游戏" }).first().click();
			await page.getByRole("tab", { name: "云端扫描" }).click();
			await expect(
				page.getByRole("listitem").getByText("Bridge-None-Pending"),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "开始扫描" }),
			).toBeEnabled();
			expect(bridge.requests).toHaveLength(0);
		});
	});

	test.describe("同一 context 多分页", () => {
		test("A 已缓存 absent 且停止轮询；B 开始下载；A 回前景后重新读取 bridge 并恢复 2 秒轮询", async ({
			page: pageA,
			context,
			baseUrl,
			server,
			bridge,
		}) => {
			const path = uniquePath("multi-dl");
			const id = await createCloudGame(server, "Bridge-Multi-DL", path);
			await login(pageA, baseUrl);
			await openDetail(pageA, baseUrl, id);
			await expect(btn(pageA, "下载到本机")).toBeVisible();

			const pageB = await context.newPage();
			await openDetail(pageB, baseUrl, id);
			await expect(btn(pageB, "下载到本机")).toBeVisible();

			// B 启动下载，并推进进度；B 进入 2 秒轮询
			await btn(pageB, "下载到本机").click();
			await expect(btn(pageB, "取消下载")).toBeVisible();
			bridge.transition(path, {
				completed_bytes: 100 * 1024 * 1024,
				total_bytes: 400 * 1024 * 1024,
			});
			const polls = () => stateRequests(bridge).length;
			const afterB = polls();
			await expect.poll(polls).toBeGreaterThanOrEqual(afterB + 2);
			// B 已至少轮询两轮，A 若在轮询早就更新了：它仍停在缓存的 absent
			await expect(btn(pageA, "下载到本机")).toBeVisible();
			await expect(btn(pageA, "取消下载")).toHaveCount(0);

			// A 回前景：重新向 bridge 读状态，显示下载中，且之后靠轮询前进（不再需要 focus）
			const beforeFocus = polls();
			await focusNow(pageA);
			await expect.poll(polls).toBeGreaterThan(beforeFocus);
			await expect(btn(pageA, "取消下载")).toBeVisible();
			await expect(main(pageA).getByText("100.0 MB / 400.0 MB")).toBeVisible();
			bridge.transition(path, { completed_bytes: 300 * 1024 * 1024 });
			await expect(main(pageA).getByText("300.0 MB / 400.0 MB")).toBeVisible();
			// 下载结束后 A 同样自行跟上
			bridge.transition(path, { status: "ready" });
			await expect(btn(pageA, "选择可执行文件")).toBeVisible();
			expect(
				bridge.requests.filter((r) => r.path === "/rpc/game/fetch"),
			).toHaveLength(1);
		});

		test("A 已缓存 ready；B 启动游戏；A 回前景恢复 running 与 10 秒轮询", async ({
			page: pageA,
			context,
			baseUrl,
			server,
			bridge,
		}) => {
			const path = uniquePath("multi-run");
			const id = await createCloudGame(server, "Bridge-Multi-Run", path, {
				exe_relpath: "M/m.exe",
			});
			bridge.setState(path, { status: "ready", exes: ["M/m.exe"] });
			await login(pageA, baseUrl);
			await openDetail(pageA, baseUrl, id);
			await expect(btn(pageA, "启动游戏")).toBeVisible();

			const pageB = await context.newPage();
			await openDetail(pageB, baseUrl, id);
			await btn(pageB, "启动游戏").click();
			await expect.poll(() => bridge.games.get(path)?.status).toBe("running");
			await expect(btn(pageB, /运行中/)).toBeVisible();
			// A 尚未回前景：仍是缓存的 ready
			await expect(btn(pageA, "启动游戏")).toBeVisible();

			bridge.transition(path, { elapsed_seconds: 30 });
			const before = stateRequests(bridge).length;
			await focusNow(pageA);
			await expect
				.poll(() => stateRequests(bridge).length)
				.toBeGreaterThan(before);
			await expect(btn(pageA, /运行中\s*0:30/)).toBeVisible();
			// running 状态下 A 自己恢复轮询（约 10 秒），不靠 focus 就能看到新的 elapsed
			bridge.transition(path, { elapsed_seconds: 47 });
			await expect(btn(pageA, /运行中\s*0:47/)).toBeVisible({
				timeout: 20_000,
			});
		});

		test("reconnect：A 缓存 absent 且停止轮询，离线期间 bridge 状态改变；恢复上线后 A 重新读取并恢复轮询", async ({
			page: pageA,
			context,
			baseUrl,
			server,
			bridge,
		}) => {
			const path = uniquePath("multi-reconnect");
			const id = await createCloudGame(server, "Bridge-Reconnect", path);
			await login(pageA, baseUrl);
			await openDetail(pageA, baseUrl, id);
			await expect(btn(pageA, "下载到本机")).toBeVisible();
			const serverCalls = watchServerCalls(pageA);

			// 离线：navigator.onLine=false，react-query onlineManager 收到 offline 事件
			await context.setOffline(true);
			await expect
				.poll(() => pageA.evaluate(() => navigator.onLine))
				.toBe(false);
			// 离线期间只有 bridge 改变（没有 server 写入，version invalidation 无法解释）
			bridge.transition(path, {
				status: "downloading",
				completed_bytes: 5 * 1024 * 1024,
				total_bytes: 20 * 1024 * 1024,
			});
			const polls = () => stateRequests(bridge).length;
			const before = polls();
			await expect(btn(pageA, "下载到本机")).toBeVisible();

			// 恢复上线 → refetchOnReconnect 重新读取 bridge 状态
			await context.setOffline(false);
			await expect
				.poll(() => pageA.evaluate(() => navigator.onLine))
				.toBe(true);
			await expect.poll(polls).toBeGreaterThan(before);
			await expect(btn(pageA, "取消下载")).toBeVisible();
			await expect(main(pageA).getByText("5.0 MB / 20.0 MB")).toBeVisible();

			// 恢复 2 秒轮询：之后的变化不靠 focus/上线事件就能看到
			bridge.transition(path, { completed_bytes: 15 * 1024 * 1024 });
			await expect(main(pageA).getByText("15.0 MB / 20.0 MB")).toBeVisible();
			expect(
				serverCalls.filter((c) => c.startsWith("POST /game/api/rpc/")),
			).not.toContain("POST /game/api/rpc/update_game");
		});

		test("A 离开详情页后回来（remount）→ 重新读取 bridge，不依赖 server version", async ({
			page: pageA,
			context,
			baseUrl,
			server,
			bridge,
		}) => {
			const path = uniquePath("multi-remount");
			const id = await createCloudGame(server, "Bridge-Remount", path);
			await login(pageA, baseUrl);
			await openDetail(pageA, baseUrl, id);
			await expect(btn(pageA, "下载到本机")).toBeVisible();
			const serverCalls = watchServerCalls(pageA);

			const pageB = await context.newPage();
			await openDetail(pageB, baseUrl, id);
			await btn(pageB, "下载到本机").click();
			await expect(btn(pageB, "取消下载")).toBeVisible();
			bridge.transition(path, {
				completed_bytes: 10 * 1024 * 1024,
				total_bytes: 20 * 1024 * 1024,
			});

			// A 站内导航离开再回来（不 reload，SPA remount）；期间 server 数据没有任何变更
			await pageA.getByRole("link", { name: "游戏仓库" }).first().click();
			await expect(
				main(pageA).getByText("Bridge-Remount").first(),
			).toBeVisible();
			await main(pageA).getByText("Bridge-Remount").first().click();
			await expect(btn(pageA, "取消下载")).toBeVisible();
			await expect(main(pageA).getByText("10.0 MB / 20.0 MB")).toBeVisible();
			// A 没有做过任何 server 写入
			expect(
				serverCalls.filter((c) => c.startsWith("POST /game/api/rpc/")),
			).not.toContain("POST /game/api/rpc/update_game");
		});
	});
});
