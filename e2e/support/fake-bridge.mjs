/**
 * @file 假的本机 bridge（/rpc/game/*）
 * @description 只存在于 e2e：由「状态表 + 故障模式」驱动，不模拟 WebDAV/Telegram。
 * 监听临时 loopback 端口（绝不绑 8081，真 bridge 可能正在运行）；
 * 测试通过 context.route("http://127.0.0.1:8081/**") 把请求转发到这里，见 fixtures.ts。
 *
 * 扩展方式（任务 17B2 的 UI 状态机）：
 * - 用 setState()/transition() 改状态表；
 * - 用 fail(rule) 注入故障（status / 断线 / 次数 / 匹配条件）；
 * - requests 记录每个请求（含 Authorization），用于断言。
 */

import { createServer } from "node:http";
import { verifyJwt } from "./jwt.mjs";

/**
 * @typedef {"running"|"downloading"|"ready"|"incomplete"|"absent"} GameStatus
 */

/**
 * @typedef {object} GameEntry
 * @property {GameStatus} status
 * @property {number} [completed_bytes]
 * @property {number} [total_bytes]
 * @property {number} [elapsed_seconds]
 * @property {string|null} [error]
 * @property {string[]} [exes]
 */

/**
 * @typedef {object} FaultRule
 * @property {string} [method] 只匹配这个 method
 * @property {string} [path] 只匹配含此片段的 pathname（如 "/launch"）
 * @property {number} [status] 回这个状态码（JSON body {code,error}）
 * @property {"close"} [mode] "close" 直接断线（模拟 network close）
 * @property {number} [times] 触发几次后失效，预设 1；Infinity 为永久
 * @property {object} [body] 自订 JSON body
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

export class FakeBridge {
	/**
	 * @param {object} options
	 * @param {string} options.allowedOrigin 唯一允许的页面 origin（与真 bridge 相同：精确比对）
	 */
	constructor({ allowedOrigin }) {
		this.allowedOrigin = allowedOrigin;
		/** @type {Map<string, GameEntry>} */
		this.games = new Map();
		/** @type {(FaultRule & {times: number})[]} */
		this.faults = [];
		/** @type {{method:string,path:string,search:string,origin:string|undefined,authorization:string|undefined,body:any}[]} */
		this.requests = [];
		this.nextSessionId = 1;
		this.server = createServer((req, res) => {
			this.#handle(req, res).catch((error) => {
				res.writeHead(500, JSON_HEADERS);
				res.end(JSON.stringify({ error: String(error) }));
			});
		});
		this.port = 0;
	}

	async start() {
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => resolve(undefined));
		});
		const address = this.server.address();
		this.port = typeof address === "object" && address ? address.port : 0;
		return this;
	}

	async stop() {
		this.server.closeAllConnections();
		await new Promise((resolve) => this.server.close(() => resolve(undefined)));
	}

	get origin() {
		return `http://127.0.0.1:${this.port}`;
	}

	/**
	 * 设定某游戏路径的状态（状态表驱动）
	 * @param {string} path
	 * @param {GameEntry} entry
	 */
	setState(path, entry) {
		this.games.set(path, {
			completed_bytes: 0,
			total_bytes: 0,
			elapsed_seconds: 0,
			error: null,
			exes: [],
			...entry,
		});
	}

	/**
	 * 局部更新既有状态
	 * @param {string} path
	 * @param {Partial<GameEntry>} patch
	 */
	transition(path, patch) {
		/** @type {GameEntry} */
		const current = this.games.get(path) ?? { status: "absent" };
		this.setState(path, { ...current, ...patch });
	}

	/** @param {FaultRule} rule */
	fail(rule) {
		this.faults.push({ ...rule, times: rule.times ?? 1 });
	}

	reset() {
		this.games.clear();
		this.faults.length = 0;
		this.requests.length = 0;
	}

	/** @param {string} path */
	#stateOf(path) {
		const entry = this.games.get(path) ?? { status: "absent" };
		return {
			path,
			status: entry.status,
			completed_bytes: entry.completed_bytes ?? 0,
			total_bytes: entry.total_bytes ?? 0,
			elapsed_seconds: entry.elapsed_seconds ?? 0,
			error: entry.error ?? null,
			capabilities: { locale_emulator: false },
		};
	}

	/** @param {import("node:http").IncomingMessage} req */
	#corsHeaders(req) {
		const origin = req.headers.origin;
		if (!origin || origin !== this.allowedOrigin) return null;
		return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
	}

	/**
	 * @param {string} method
	 * @param {string} pathname
	 */
	#takeFault(method, pathname) {
		const index = this.faults.findIndex(
			(rule) =>
				(!rule.method || rule.method === method) &&
				(!rule.path || pathname.includes(rule.path)),
		);
		if (index < 0) return null;
		const rule = this.faults[index];
		rule.times -= 1;
		if (rule.times <= 0) this.faults.splice(index, 1);
		return rule;
	}

	/** @param {import("node:http").IncomingMessage} req */
	async #readBody(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString();
		if (!text) return undefined;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	/**
	 * @param {import("node:http").IncomingMessage} req
	 * @param {import("node:http").ServerResponse} res
	 */
	async #handle(req, res) {
		const url = new URL(req.url ?? "/", this.origin);
		const method = req.method ?? "GET";
		const cors = this.#corsHeaders(req);

		// 预检：不需要 Bearer；只对精确允许的 Origin 成功（与真 bridge 一致）
		if (method === "OPTIONS") {
			if (!cors || !url.pathname.startsWith("/rpc/game/")) {
				res.writeHead(403);
				res.end();
				return;
			}
			/** @type {Record<string, string>} */
			const headers = {
				...cors,
				"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization, Content-Type",
				"Access-Control-Max-Age": "600",
			};
			if (req.headers["access-control-request-private-network"] === "true") {
				headers["Access-Control-Allow-Private-Network"] = "true";
			}
			res.writeHead(204, headers);
			res.end();
			return;
		}

		const body = await this.#readBody(req);
		this.requests.push({
			method,
			path: url.pathname,
			search: url.search,
			origin: req.headers.origin,
			authorization: req.headers.authorization,
			body,
		});

		/**
		 * @param {number} status
		 * @param {unknown} payload
		 */
		const reply = (status, payload) => {
			res.writeHead(status, { ...JSON_HEADERS, ...(cors ?? {}) });
			res.end(JSON.stringify(payload));
		};

		if (!cors) {
			reply(403, { code: "origin_not_allowed", error: "origin not allowed" });
			return;
		}
		if (!url.pathname.startsWith("/rpc/game/")) {
			reply(404, { error: "not found" });
			return;
		}

		const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
		if (!bearer || !verifyJwt(bearer)) {
			reply(401, { code: "unauthorized", error: "unauthorized" });
			return;
		}

		const fault = this.#takeFault(method, url.pathname);
		if (fault?.mode === "close") {
			req.socket.destroy();
			return;
		}
		if (fault?.status) {
			reply(
				fault.status,
				fault.body ?? { code: `fake_${fault.status}`, error: "injected" },
			);
			return;
		}

		this.#route(method, url, body, reply);
	}

	/**
	 * @param {string} method
	 * @param {URL} url
	 * @param {any} body
	 * @param {(status: number, payload: unknown) => void} reply
	 */
	#route(method, url, body, reply) {
		const action = url.pathname.slice("/rpc/game/".length);

		if (action === "state" && method === "GET") {
			const paths = url.searchParams.getAll("paths");
			reply(200, { games: paths.map((path) => this.#stateOf(path)) });
			return;
		}
		if (action === "fetch" && method === "POST") {
			const path = body?.path;
			if (typeof path !== "string") {
				reply(400, { code: "bad_request", error: "path required" });
				return;
			}
			const status = this.games.get(path)?.status ?? "absent";
			if (status === "absent" || status === "incomplete") {
				this.transition(path, { status: "downloading" });
			}
			reply(200, this.#stateOf(path));
			return;
		}
		if (action === "fetch" && method === "DELETE") {
			const path = url.searchParams.get("path") ?? "";
			if (this.games.get(path)?.status === "downloading") {
				this.transition(path, { status: "incomplete" });
			}
			reply(200, this.#stateOf(path));
			return;
		}
		if (action === "exes" && method === "GET") {
			const path = url.searchParams.get("path") ?? "";
			reply(200, { exes: this.games.get(path)?.exes ?? [] });
			return;
		}
		if (action === "launch" && method === "POST") {
			const path = body?.path;
			if (typeof path === "string") {
				this.transition(path, { status: "running" });
			}
			reply(200, { session_id: `fake-session-${this.nextSessionId++}` });
			return;
		}
		reply(404, { code: "not_found", error: "unknown bridge route" });
	}
}
