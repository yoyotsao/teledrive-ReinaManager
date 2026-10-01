/**
 * 多使用者隔离：不同 TeleDrive 使用者各自拥有独立的游戏库与 data_version。
 * 两位使用者都用测试密钥签的假 JWT，各用一个独立的 BrowserContext（独立 IndexedDB）。
 */

import { expect, seedCredentials, test } from "./support/fixtures";
import { signJwt, TEST_OWNER_ID } from "./support/jwt.mjs";

const USER_B = 7;
const ACCOUNTS = [
	{ id: "sentinel-multi-user", session: "FAKE-SESSION-STRING-NOT-REAL" },
];

test.describe("多使用者隔离", () => {
	test("两位使用者各自只看到自己的游戏", async ({
		newDevice,
		baseUrl,
		server,
		serverAs,
	}) => {
		await server.createGame("Multi-Owner-Only");
		await serverAs(USER_B).createGame("Multi-B-Only");

		const pageA = await (await newDevice()).newPage();
		const pageB = await (await newDevice()).newPage();
		await seedCredentials(pageA, baseUrl, {
			accounts: ACCOUNTS,
			jwt: signJwt({ userId: TEST_OWNER_ID }),
		});
		await seedCredentials(pageB, baseUrl, {
			accounts: ACCOUNTS,
			jwt: signJwt({ userId: USER_B }),
		});

		await pageA.goto(`${baseUrl}/game/libraries`);
		await pageB.goto(`${baseUrl}/game/libraries`);

		// 先等自己的游戏出现，「看不到对方的」这个否定断言才有意义
		await expect(pageA.getByText("Multi-Owner-Only").first()).toBeVisible();
		await expect(pageB.getByText("Multi-B-Only").first()).toBeVisible();
		await expect(pageA.getByText("Multi-B-Only")).toHaveCount(0);
		await expect(pageB.getByText("Multi-Owner-Only")).toHaveCount(0);
	});

	test("一位使用者的写入不会改变另一位的 data_version", async ({
		server,
		serverAs,
	}) => {
		const serverB = serverAs(USER_B);
		const bBefore = await serverB.version();
		const ownerBefore = await server.version();

		await server.createGame("Multi-Version-Owner");

		expect(await server.version()).toBeGreaterThan(ownerBefore);
		expect(await serverB.version()).toBe(bBefore);
	});
});
