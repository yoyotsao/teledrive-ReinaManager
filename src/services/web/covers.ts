/**
 * @file 网页版封面 service
 * @description 封面由 reina-server 以内容 hash 版本化提供；<img> 无法带 Authorization，
 * 所以一律用带 Bearer 的 fetch 取得 Blob，再由呼叫端转成 object URL。
 */

import { authenticatedFetch } from "@/services/web/http";
import { AppError } from "@/utils/errors";

export interface CoverVersionResponse {
	cover_version: string | null;
	has_custom_cover: boolean;
}

// 与 http.ts 的 SERVER_API_PREFIX 一致的固定字面量，不依赖
// import.meta.env.BASE_URL——vitest 的测试环境会把 base 强制改回 "/"，
// 与实际部署路径（vite build --mode web 时的 "/game/"）不一致。
const coverUrl = (gameId: number) => `/game/api/covers/${gameId}`;

async function readVersion(response: Response): Promise<CoverVersionResponse> {
	if (!response.ok) {
		throw new AppError({
			code: "cover_request_failed",
			message: `Cover request failed: ${response.status}`,
		});
	}
	return (await response.json()) as CoverVersionResponse;
}

export async function getCoverBlob(
	gameId: number,
	version: string,
	signal?: AbortSignal,
): Promise<Blob> {
	const response = await authenticatedFetch(
		`${coverUrl(gameId)}?v=${encodeURIComponent(version)}`,
		{ signal },
	);
	if (!response.ok) {
		throw new AppError({
			code: "cover_request_failed",
			message: `Cover request failed: ${response.status}`,
		});
	}
	return response.blob();
}

export async function uploadCustomCover(
	gameId: number,
	file: Blob,
): Promise<CoverVersionResponse> {
	return readVersion(
		await authenticatedFetch(coverUrl(gameId), {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: file,
		}),
	);
}

export async function deleteCustomCover(
	gameId: number,
): Promise<CoverVersionResponse> {
	return readVersion(
		await authenticatedFetch(coverUrl(gameId), { method: "DELETE" }),
	);
}

export async function setSourceCover(
	gameId: number,
	url: string | null,
): Promise<CoverVersionResponse> {
	return readVersion(
		await authenticatedFetch(`${coverUrl(gameId)}/source`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
		}),
	);
}
