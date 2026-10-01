/**
 * @file E2E 隔离环境
 * @description 以子进程启动真正的 reina-server（真 auth / static / router），只有资料是隔离的：
 * - 临时 REINA_DATA_DIR，每次 suite 前清空，绝不指向 /data 或正式 DB；
 * - JWT_SECRET 只放在这个子进程；
 * - REINA_STATIC_DIR 只能是本次 `pnpm test:e2e` 刚 build 的 dist-web，缺少时直接失败，不退回 dev server；
 * - 子进程 TZ=Asia/Taipei（Playwright 的 timezoneId 见 playwright.config.ts）。
 *
 * TeleDrive 的 /api/v1/* 不由 reina-server 提供；测试用 context.route 桩掉，
 * TELEDRIVE_API 指向一个必定拒绝连线的地址，避免任何请求外泄到真 TeleDrive。
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_JWT_SECRET } from "./jwt.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.platform === "win32" ? ".exe" : "";

export const TEST_TIMEZONE = "Asia/Taipei";
/** worker 进程从环境变量取得 server 位置（globalSetup 写入，worker 继承） */
export const BASE_URL_ENV = "REINA_E2E_BASE_URL";

/** @type {import("node:child_process").ChildProcess | null} */
let serverProcess = null;
let serverLog = "";
/** 本次 run 专属的临时目录（mkdtempSync，并行 run 互不干扰），stopTestEnv 时删除 */
let tempRoots = [];

function freePort() {
	return new Promise((resolvePort, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolvePort(port));
		});
	});
}

function locateServerBinary() {
	if (process.env.REINA_SERVER_BIN) {
		if (!existsSync(process.env.REINA_SERVER_BIN)) {
			throw new Error(
				`REINA_SERVER_BIN 不存在: ${process.env.REINA_SERVER_BIN}`,
			);
		}
		return process.env.REINA_SERVER_BIN;
	}
	const manifestDir = join(REPO_ROOT, "src-tauri");
	const build = spawnSync("cargo", ["build", "-p", "reina-server"], {
		cwd: manifestDir,
		stdio: "inherit",
	});
	if (build.status !== 0) {
		throw new Error("cargo build -p reina-server 失败");
	}
	const targetDir = process.env.CARGO_TARGET_DIR ?? join(manifestDir, "target");
	const binary = join(resolve(targetDir), "debug", `reina-server${EXE}`);
	if (!existsSync(binary)) throw new Error(`找不到 reina-server: ${binary}`);
	return binary;
}

/** 临时目录必须在系统临时目录内（防止误删/误用真实资料）；每次 run 唯一 */
function makeTempDir(prefix) {
	const root = resolve(tmpdir());
	const dir = mkdtempSync(join(root, prefix));
	if (!resolve(dir).startsWith(root + sep)) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(`拒绝使用临时目录以外的目录: ${dir}`);
	}
	tempRoots.push(dir);
	return dir;
}

function removeTempDirs() {
	const dirs = tempRoots;
	tempRoots = [];
	const root = resolve(tmpdir()) + sep;
	for (const dir of dirs) {
		if (resolve(dir).startsWith(root)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	}
}

async function waitForHealth(baseUrl, child) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`reina-server 提前结束 (code ${child.exitCode})\n${serverLog}`,
			);
		}
		try {
			const response = await fetch(`${baseUrl}/game/healthz`);
			if (response.ok) return;
		} catch {
			// 尚未监听
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`reina-server 60 秒内未就绪\n${serverLog}`);
}

/**
 * 启动隔离 server。dist-web 缺少时直接抛错（`test:e2e` 已先 build:web）。
 * @returns {Promise<{baseUrl: string, dataDir: string}>}
 */
export async function startTestEnv() {
	const staticDir = join(REPO_ROOT, "dist-web");
	if (!existsSync(join(staticDir, "index.html"))) {
		throw new Error(
			`缺少 ${staticDir}/index.html：请用 \`pnpm test:e2e\`（会先 build:web），E2E 不会退回 dev server`,
		);
	}

	const dataDir = makeTempDir("reina-e2e-data-");
	// 复制一份 binary：重新 build 不会被 Windows 文件锁挡住，也不会动到共用 target 内的产物
	const binaryDir = makeTempDir("reina-e2e-bin-");
	const binary = join(binaryDir, `reina-server${EXE}`);
	try {
		copyFileSync(locateServerBinary(), binary);
	} catch (error) {
		removeTempDirs();
		throw error;
	}

	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	// 从干净的环境起步，避免继承开发者机器上的 JWT_SECRET / REINA_* / TELEDRIVE_*
	/** @type {Record<string, string>} */
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/^(JWT_SECRET|REINA_|TELEDRIVE_)/.test(key)) continue;
		env[key] = value;
	}
	Object.assign(env, {
		JWT_SECRET: TEST_JWT_SECRET,
		REINA_DATA_DIR: dataDir,
		REINA_STATIC_DIR: staticDir,
		REINA_PORT: String(port),
		TELEDRIVE_API: "http://127.0.0.1:9",
		TZ: TEST_TIMEZONE,
		RUST_LOG: "warn",
	});

	serverLog = "";
	const child = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
	serverProcess = child;
	const collect = (chunk) => {
		serverLog = (serverLog + chunk.toString()).slice(-8000);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);

	try {
		await waitForHealth(baseUrl, child);
	} catch (error) {
		await stopTestEnv();
		throw error;
	}
	return { baseUrl, dataDir };
}

export async function stopTestEnv() {
	const child = serverProcess;
	serverProcess = null;
	if (child && child.exitCode === null) {
		await new Promise((resolveStop) => {
			child.once("exit", () => resolveStop(undefined));
			child.kill();
			setTimeout(() => {
				child.kill("SIGKILL");
				resolveStop(undefined);
			}, 5000).unref();
		});
	}
	removeTempDirs();
}
