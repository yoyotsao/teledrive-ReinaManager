import { defineConfig } from "@playwright/test";

/**
 * 隔离 E2E：真 reina-server + 隔离资料目录（见 e2e/support/test-env.mjs）。
 * 只能透过 `pnpm test:e2e` 执行，它会先 `pnpm build:web` 产生新的 dist-web。
 * 所有场景共用同一个 server/DB，所以单 worker 依序执行，各测试使用唯一的游戏名称。
 */
export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.spec.ts",
	globalSetup: "./e2e/support/global-setup.mjs",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: !!process.env.CI,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"]],
	use: {
		timezoneId: "Asia/Taipei",
		locale: "zh-CN",
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
