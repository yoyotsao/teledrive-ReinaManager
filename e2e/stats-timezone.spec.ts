/**
 * 17B Step 6a：统计时区与跨午夜回归。
 * 对象是 Linux 容器（image reinamanager:local，TZ=Asia/Taipei，tzdata，临时 volume），
 * 不是 Windows 宿主 server（chrono::Local 的行为要在 Linux 上验证）。
 * browser 与 server 同为 Asia/Taipei，Playwright clock 固定为 2026-09-28T02:00:00+08:00。
 * session 一律经真实 POST /game/api/sessions 写入，timestamp 是 UTC epoch seconds（不预先 +8h）。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import { listDbFiles, startCandidateServer } from "./support/docker-env.mjs";
import { installBridgeRoute, seedCredentials } from "./support/fixtures";
import { validJwt } from "./support/jwt.mjs";

type Candidate = Awaited<ReturnType<typeof startCandidateServer>>;

/** 2026-09-28T02:00:00+08:00 = 2026-09-27T18:00:00Z */
const FIXED_NOW = new Date("2026-09-27T18:00:00Z");
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// 遊戲 A：本地 2026-09-28 00:30–01:00（UTC 2026-09-27 16:30–17:00），1800 秒
const A_START = epoch("2026-09-27T16:30:00Z");
// 遊戲 B：本地 2026-09-27 23:50–2026-09-28 00:10（UTC 15:50–16:10），1200 秒
const B_START = epoch("2026-09-27T15:50:00Z");

const ACCOUNTS = [{ id: "tz-sentinel", session: "FAKE-SESSION-NOT-REAL" }];

interface GameStats {
	game_id: number;
	total_time: number;
	session_count: number;
	daily_stats: { date: string; playtime: number }[] | string;
}
interface Distribution {
	hourly: number[];
	weekdays: number[];
}

const dailyOf = (stats: GameStats | null) => {
	if (!stats) return [];
	const raw =
		typeof stats.daily_stats === "string"
			? (JSON.parse(stats.daily_stats) as { date: string; playtime: number }[])
			: stats.daily_stats;
	return raw
		.map((d) => ({ date: d.date, playtime: d.playtime }))
		.sort((a, b) => a.date.localeCompare(b.date));
};

test.describe
	.serial("统计时区 / 跨午夜（Linux 容器，TZ=Asia/Taipei）", () => {
		let server: Candidate;
		let gameA = 0;
		let gameB = 0;
		const sessionA = randomUUID();
		const sessionB = randomUUID();

		const auth = () => ({ Authorization: `Bearer ${validJwt()}` });
		async function rpc<T>(command: string, args: object = {}): Promise<T> {
			const response = await fetch(
				`${server.baseUrl}/game/api/rpc/${command}`,
				{
					method: "POST",
					headers: { ...auth(), "Content-Type": "application/json" },
					body: JSON.stringify(args),
				},
			);
			if (!response.ok) {
				throw new Error(
					`${command} -> ${response.status} ${await response.text()}`,
				);
			}
			return (await response.json()) as T;
		}
		async function postSession(body: object) {
			const response = await fetch(`${server.baseUrl}/game/api/sessions`, {
				method: "POST",
				headers: { ...auth(), "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return {
				status: response.status,
				body: (await response.json()) as { accepted: boolean },
			};
		}
		async function version() {
			const response = await fetch(`${server.baseUrl}/game/api/version`, {
				headers: auth(),
			});
			return ((await response.json()) as { data_version: number }).data_version;
		}
		const range = (ids: number[], start: string, end: string) =>
			rpc<Distribution>("get_statistics_distribution", {
				gameIds: ids,
				startDate: start,
				endDate: end,
			});

		/** 读取容器 /data 的 DB 拷贝，取得落盘的 daily_stats（wal 一并拷贝） */
		function onDiskDaily(): Record<
			number,
			{ date: string; playtime: number }[]
		> {
			return server.withDataCopy((dir: string) => {
				const files = listDbFiles(dir);
				expect(files.length, `DB 档: ${files.join(",")}`).toBeGreaterThan(0);
				const db = new DatabaseSync(join(dir, files[0]), { readOnly: false });
				try {
					const rows = db
						.prepare("SELECT game_id, daily_stats FROM game_statistics")
						.all() as { game_id: number; daily_stats: string | null }[];
					const out: Record<number, { date: string; playtime: number }[]> = {};
					for (const row of rows) {
						out[row.game_id] = dailyOf({
							game_id: row.game_id,
							total_time: 0,
							session_count: 0,
							daily_stats: row.daily_stats ?? "[]",
						});
					}
					return out;
				} finally {
					db.close();
				}
			});
		}

		test.beforeAll(async () => {
			test.setTimeout(180_000);
			server = await startCandidateServer();
			gameA = (
				await rpc<{ id: number }>("insert_game", {
					game: { id_type: "custom", custom_data: { name: "TZ-Game-A" } },
				})
			).id;
			gameB = (
				await rpc<{ id: number }>("insert_game", {
					game: { id_type: "custom", custom_data: { name: "TZ-Game-B" } },
				})
			).id;
		});

		test.afterAll(async () => {
			await server?.stop();
		});

		test("容器确实在 Asia/Taipei 且有 tzdata", async () => {
			expect(server.exec(["printenv", "TZ"])).toBe("Asia/Taipei");
			expect(server.exec(["date", "+%z"])).toBe("+0800");
		});

		test("经真实 session API 写入；同 UUID 重送不增加统计", async () => {
			const first = await postSession({
				id: sessionA,
				game_id: gameA,
				device: "e2e-device",
				start: A_START,
				end: A_START + 1800,
				seconds: 1800,
			});
			expect(first).toEqual({ status: 200, body: { accepted: true } });
			const second = await postSession({
				id: sessionB,
				game_id: gameB,
				device: "e2e-device",
				start: B_START,
				end: B_START + 1200,
				seconds: 1200,
			});
			expect(second).toEqual({ status: 200, body: { accepted: true } });

			// 同 UUID 重送：idempotent（accepted=false），统计与 data_version 都不变
			const versionBefore = await version();
			const resend = await postSession({
				id: sessionA,
				game_id: gameA,
				device: "e2e-device",
				start: A_START,
				end: A_START + 1800,
				seconds: 1800,
			});
			expect(resend).toEqual({ status: 200, body: { accepted: false } });
			expect(await version()).toBe(versionBefore);
		});

		async function assertApiAndDisk() {
			// 落盘的 daily_stats：A 全落在 2026-09-28；B 跨午夜拆成两天各 10 分钟
			const statsA = await rpc<GameStats | null>("get_game_statistics", {
				gameId: gameA,
			});
			const statsB = await rpc<GameStats | null>("get_game_statistics", {
				gameId: gameB,
			});
			expect(dailyOf(statsA)).toEqual([{ date: "2026-09-28", playtime: 30 }]);
			expect(dailyOf(statsB)).toEqual([
				{ date: "2026-09-27", playtime: 10 },
				{ date: "2026-09-28", playtime: 10 },
			]);
			expect(statsA?.total_time).toBe(30);
			expect(statsB?.total_time).toBe(20);
			expect(statsA?.session_count).toBe(1);
			expect(statsB?.session_count).toBe(1);

			// API 与落盘一致
			const disk = onDiskDaily();
			expect(disk[gameA]).toEqual(dailyOf(statsA));
			expect(disk[gameB]).toEqual(dailyOf(statsB));

			// 小时分布：沿用「开始小时归类」；A → 0 点 30 分；B 完整 20 分钟 → 23 点
			const day27 = await range([gameA, gameB], "2026-09-27", "2026-09-27");
			const day28 = await range([gameA, gameB], "2026-09-28", "2026-09-28");
			const both = await range([gameA, gameB], "2026-09-27", "2026-09-28");
			const only = (d: Distribution) =>
				Object.fromEntries(
					d.hourly.map((v, h) => [h, v] as const).filter(([, v]) => v > 0),
				);
			// 按开始日期查询：前一天含 B（23 点 20 分钟），不含 A
			expect(only(day27)).toEqual({ 23: 20 });
			// 当天含 A（0 点 30 分钟），不含 B
			expect(only(day28)).toEqual({ 0: 30 });
			expect(only(both)).toEqual({ 0: 30, 23: 20 });
			// 单游戏范围：A 只在 28 日；B 只在 27 日
			expect(only(await range([gameA], "2026-09-28", "2026-09-28"))).toEqual({
				0: 30,
			});
			expect(only(await range([gameA], "2026-09-27", "2026-09-27"))).toEqual(
				{},
			);
			expect(only(await range([gameB], "2026-09-28", "2026-09-28"))).toEqual(
				{},
			);
			expect(only(await range([gameB], "2026-09-27", "2026-09-27"))).toEqual({
				23: 20,
			});
			return { statsA, statsB };
		}

		async function assertUi(page: Page) {
			await page.clock.setFixedTime(FIXED_NOW);
			await seedCredentials(page, server.baseUrl, {
				accounts: ACCOUNTS,
				jwt: validJwt(),
			});
			// 浏览器「今天」= 2026-09-28（Asia/Taipei）
			await page.goto(`${server.baseUrl}/game/`);
			expect(
				await page.evaluate(() => {
					const d = new Date();
					const p = (n: number) => String(n).padStart(2, "0");
					return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
				}),
			).toBe("2026-09-28 02:00");

			// 全库今日时长 = 30 + 10 = 40 分钟
			const home = page.getByRole("main");
			await expect(home).toContainText(/今日时长\s*40分钟/);

			// 各游戏详情：A 今日 30 分钟；B 今日 10 分钟（累计 20 分钟）
			const panel = page.getByRole("tabpanel", { name: "游戏统计" });
			await page.goto(`${server.baseUrl}/game/libraries/${gameA}`);
			await expect(panel).toContainText(/今日游戏时长\s*30分钟/);
			await expect(panel).toContainText(/累计总时长\s*30分钟/);
			await page.goto(`${server.baseUrl}/game/libraries/${gameB}`);
			await expect(panel).toContainText(/今日游戏时长\s*10分钟/);
			await expect(panel).toContainText(/累计总时长\s*20分钟/);
		}

		test("API + 落盘 daily_stats + 小时分布 + 日期范围", async () => {
			await assertApiAndDisk();
		});

		test("UI：今日时长 A 30 / B 10 / 合计 40 分钟（固定 browser 时间）", async ({
			browser,
		}) => {
			const context = await browser.newContext({
				timezoneId: "Asia/Taipei",
				locale: "zh-CN",
			});
			await installBridgeRoute(context, "none", null);
			try {
				await assertUi(await context.newPage());
			} finally {
				await context.close();
			}
		});

		test("重启同一容器 + volume 后结果不变；重送仍不增加", async ({
			browser,
		}) => {
			test.setTimeout(120_000);
			const before = await assertApiAndDisk();
			await server.restart();
			const after = await assertApiAndDisk();
			expect(dailyOf(after.statsA)).toEqual(dailyOf(before.statsA));
			expect(dailyOf(after.statsB)).toEqual(dailyOf(before.statsB));

			const resend = await postSession({
				id: sessionB,
				game_id: gameB,
				device: "e2e-device",
				start: B_START,
				end: B_START + 1200,
				seconds: 1200,
			});
			expect(resend.body.accepted).toBe(false);
			await assertApiAndDisk();

			const context = await browser.newContext({
				timezoneId: "Asia/Taipei",
				locale: "zh-CN",
			});
			await installBridgeRoute(context, "none", null);
			try {
				await assertUi(await context.newPage());
			} finally {
				await context.close();
			}
		});
	});
