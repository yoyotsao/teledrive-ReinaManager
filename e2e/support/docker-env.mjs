/**
 * @file Linux candidate server（Docker）
 * @description 统计时区回归（Step 6a）需要 `chrono::Local` 在 Linux + tzdata + TZ=Asia/Taipei 下运行，
 * Windows 宿主 server 无法代表。这里用 `reinamanager:local` image 启动一个隔离容器：
 * - 临时 named volume（不碰正式 reina-data、不用 compose）；
 * - 只发布 127.0.0.1:<空闲端口>:8787；
 * - docker 不可用 / image 缺少时直接抛错（fail loudly，不 skip）。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { TEST_JWT_SECRET, TEST_OWNER_ID } from "./jwt.mjs";

export const CANDIDATE_IMAGE = "reinamanager:local";

function docker(args, { allowFail = false } = {}) {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.error) {
		throw new Error(`docker 不可用: ${result.error.message}`);
	}
	if (result.status !== 0 && !allowFail) {
		throw new Error(
			`docker ${args.join(" ")} 失败 (${result.status}): ${result.stderr || result.stdout}`,
		);
	}
	return result;
}

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

async function waitForHealth(baseUrl, containerName) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/game/healthz`);
			if (response.ok) return;
		} catch {
			// 尚未监听
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	const logs = docker(["logs", "--tail", "50", containerName], {
		allowFail: true,
	});
	throw new Error(`容器 60 秒内未就绪\n${logs.stdout}${logs.stderr}`);
}

/**
 * 启动隔离容器。
 * @returns {Promise<CandidateServer>}
 */
export async function startCandidateServer() {
	const version = docker(["version", "--format", "{{.Server.Version}}"], {
		allowFail: true,
	});
	if (version.status !== 0) {
		throw new Error(
			`Docker 引擎不可用，统计时区回归需要 Linux 容器（不 skip）: ${version.stderr}`,
		);
	}
	const inspect = docker(["image", "inspect", CANDIDATE_IMAGE], {
		allowFail: true,
	});
	if (inspect.status !== 0) {
		throw new Error(
			`找不到 image ${CANDIDATE_IMAGE}；请先执行任务 16 的 docker build`,
		);
	}

	const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const name = `reina-e2e-tz-${suffix}`;
	const volume = `reina-e2e-tz-vol-${suffix}`;
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	docker(["volume", "create", volume]);
	try {
		docker([
			"run",
			"-d",
			"--rm",
			"--name",
			name,
			"-e",
			"TZ=Asia/Taipei",
			"-e",
			`JWT_SECRET=${TEST_JWT_SECRET}`,
			"-e",
			`REINA_OWNER_ID=${TEST_OWNER_ID}`,
			"-e",
			"REINA_STATIC_DIR=/app/static",
			"-v",
			`${volume}:/data`,
			"-p",
			`127.0.0.1:${port}:8787`,
			CANDIDATE_IMAGE,
		]);
		await waitForHealth(baseUrl, name);
	} catch (error) {
		docker(["rm", "-f", name], { allowFail: true });
		docker(["volume", "rm", "-f", volume], { allowFail: true });
		throw error;
	}

	return {
		baseUrl,
		name,
		volume,
		/** 在容器内执行命令（读取 TZ / 日期用） */
		exec(args) {
			return docker(["exec", name, ...args]).stdout.trim();
		},
		/** 重启同一个容器 + volume，并等到 healthz */
		async restart() {
			docker(["restart", "-t", "10", name]);
			await waitForHealth(baseUrl, name);
		},
		/**
		 * 把 /data 整个拷出来（含 WAL），交给 read(dir) 读取；结束后删除临时目录。
		 * @template T
		 * @param {(dir: string) => T} read
		 */
		withDataCopy(read) {
			const root = resolve(tmpdir());
			const dir = mkdtempSync(join(root, "reina-e2e-dbcopy-"));
			if (!resolve(dir).startsWith(root + sep)) {
				throw new Error(`拒绝使用临时目录以外的目录: ${dir}`);
			}
			try {
				docker(["cp", `${name}:/data/.`, dir]);
				return read(dir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		async stop() {
			docker(["rm", "-f", name], { allowFail: true });
			docker(["volume", "rm", "-f", volume], { allowFail: true });
			const left = execFileSync(
				"docker",
				["ps", "-a", "--filter", `name=${name}`, "-q"],
				{ encoding: "utf8" },
			).trim();
			if (left) throw new Error(`容器未清除: ${name}`);
		},
	};
}

/** 列出目录内的 sqlite 档（挑主要 DB 用） */
export function listDbFiles(dir) {
	return readdirSync(dir).filter((f) => /\.(db|sqlite3?)$/i.test(f));
}

/**
 * @typedef {Awaited<ReturnType<typeof startCandidateServer>>} CandidateServer
 */
