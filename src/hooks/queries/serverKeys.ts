/**
 * @file 服务器资料的 Query key 根
 * @description 网页版以资料版本做跨装置同步：版本改变时一次失效 ["server", ...] 下的所有 query。
 * 因此凡是资料来自 reina-server（桌面版则是本机 SQLite）的 key 都必须挂在这个前缀下。
 */

export const SERVER_QUERY_ROOT = ["server"] as const;

export function serverKey<const T extends readonly unknown[]>(
	...parts: T
): readonly ["server", ...T] {
	return ["server", ...parts] as const;
}
