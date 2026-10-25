/**
 * @file 测试用 HS256 JWT
 * @description 只用 Node crypto 签发/验证；密钥与 owner 只存在于测试进程，
 * 产品端没有任何 auth bypass。所有 token 都是假凭证。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TEST_JWT_SECRET = "reina-e2e-secret";
export const TEST_OWNER_ID = 42;

const b64url = (value) => Buffer.from(value).toString("base64url");

/**
 * @param {object} [options]
 * @param {number} [options.userId]
 * @param {number} [options.expiresInSeconds] 负数代表已过期
 * @param {string} [options.secret]
 * @param {string} [options.nonce] 让同一秒签出的 token 内容不同，方便断言「刷新过」
 */
export function signJwt({
	userId = TEST_OWNER_ID,
	expiresInSeconds = 3600,
	secret = TEST_JWT_SECRET,
	nonce,
} = {}) {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = b64url(
		JSON.stringify({
			user_id: userId,
			iat: now,
			exp: now + expiresInSeconds,
			...(nonce ? { jti: nonce } : {}),
		}),
	);
	const signature = createHmac("sha256", secret)
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${signature}`;
}

/** @param {string} [nonce] */
export const validJwt = (nonce) => signJwt({ nonce });
/** @param {string} [nonce] */
export const expiredJwt = (nonce) =>
	signJwt({ expiresInSeconds: -3600, nonce });

/**
 * 验证签章与 exp，返回 payload；失败返回 null（fake bridge 用）
 * @param {string} token
 * @param {string} [secret]
 */
export function verifyJwt(token, secret = TEST_JWT_SECRET) {
	const parts = String(token).split(".");
	if (parts.length !== 3) return null;
	const expected = createHmac("sha256", secret)
		.update(`${parts[0]}.${parts[1]}`)
		.digest();
	const actual = Buffer.from(parts[2], "base64url");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return null;
	}
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
		if (typeof payload.exp !== "number") return null;
		if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
		return payload;
	} catch {
		return null;
	}
}
