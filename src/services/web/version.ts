/**
 * @file 服务器资料版本
 * @description 读取 reina-server 的全局 data_version，供跨装置同步判断是否需要重新读取
 */

import { AppError } from "@/utils/errors";
import { authenticatedFetch } from "./http";

export async function fetchServerVersion(): Promise<number> {
	const response = await authenticatedFetch("/game/api/version", {
		method: "GET",
		// 版本必须每次都问服务器，不能被浏览器快取
		cache: "no-store",
	});
	if (!response.ok) {
		throw new AppError({
			code: "server_rpc_failed",
			message: `HTTP ${response.status}: version`,
		});
	}
	const body = (await response.json()) as { data_version?: unknown };
	if (
		typeof body.data_version !== "number" ||
		!Number.isInteger(body.data_version)
	) {
		throw new AppError({
			code: "http_response_parse_failed",
			message: "Invalid data_version from reina-server",
		});
	}
	return body.data_version;
}
