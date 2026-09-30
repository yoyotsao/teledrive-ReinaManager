/**
 * 17B Step 5 长时间无变更观察：5 分钟内没有任何写入时，
 * /game/api/* 只允许固定的 /game/api/version 轮询，不得每分钟重新读取
 * find_all_games / stats / covers。focus 情境另在 web-sync.spec.ts 独立测试。
 */

import { expect, seedCredentials, test } from "./support/fixtures";
import { validJwt } from "./support/jwt.mjs";
import { RED_PNG } from "./support/png.mjs";

const POLL_COUNT_REQUIRED = 5;

test("5 分钟无变更：只有固定的 version 轮询", async ({
	page,
	baseUrl,
	server,
}) => {
	test.setTimeout(400_000);
	const id = await server.createGame("Idle-Game");
	await server.putCover(id, RED_PNG());

	await seedCredentials(page, baseUrl, {
		accounts: [{ id: "idle-sentinel", session: "FAKE-NOT-REAL" }],
		jwt: validJwt("idle"),
	});
	const observed: { at: number; call: string }[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/game/api/")) return;
		const rpc = url.pathname.startsWith("/game/api/rpc/")
			? url.pathname.slice("/game/api/".length)
			: url.pathname;
		observed.push({ at: Date.now(), call: `${request.method()} ${rpc}` });
	});

	await page.goto(`${baseUrl}/game/libraries`);
	await expect(page.getByText("Idle-Game").first()).toBeVisible();
	// 首屏读取（含封面）完成后再开始计数
	await expect(
		page.getByRole("img", { name: "Idle-Game" }).first(),
	).toHaveAttribute("src", /^blob:/);
	const baseline = observed.length;
	const startedAt = Date.now();

	// 等到观察到足够次数的 version 轮询（事件驱动，不靠固定 sleep 猜时间）
	await expect
		.poll(
			() =>
				observed
					.slice(baseline)
					.filter((entry) => entry.call === "GET /game/api/version").length,
			{ timeout: 330_000, intervals: [2_000] },
		)
		.toBeGreaterThanOrEqual(POLL_COUNT_REQUIRED);

	const elapsed = Date.now() - startedAt;
	const after = observed.slice(baseline);
	expect(elapsed).toBeGreaterThanOrEqual(POLL_COUNT_REQUIRED * 60_000 - 65_000);
	// 观察期间的每一个 /game/api/* 请求都必须是 version
	expect(
		after.filter((entry) => entry.call !== "GET /game/api/version"),
	).toEqual([]);
	const reads = after.filter((entry) =>
		/find_all_games|statistics|covers/.test(entry.call),
	);
	expect(reads).toEqual([]);
	test.info().annotations.push({
		type: "observed",
		description: `${after.length} requests in ${Math.round(elapsed / 1000)}s: ${[...new Set(after.map((e) => e.call))].join(", ")}`,
	});
});
