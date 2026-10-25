import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 只跑 src 内的相邻测试；根目录 test/ 是用户的封面图片资料，不能被扫描
export default defineConfig({
	// 与网页版部署路径一致：任务 7–9 的断言依赖 import.meta.env.BASE_URL === "/game/"
	base: "/game/",
	plugins: [react()],
	resolve: {
		alias: [
			{ find: "@", replacement: resolve(import.meta.dirname, "./src") },
			{
				find: "@pkg",
				replacement: resolve(import.meta.dirname, "./package.json"),
			},
		],
	},
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["src/testing/setup.ts"],
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
	},
});
