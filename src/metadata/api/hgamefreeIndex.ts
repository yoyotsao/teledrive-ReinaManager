/**
 * @file HGameFree 本机索引的查询
 * @description 网页版由 reina-server 把站台文章同步到本机表，搜索直接查表（毫秒级），
 * 不必每次等站台 4～5 秒。索引尚未完成第一次同步时 `ready` 为 false，调用方应退回即时搜索。
 */

import { authenticatedFetch } from "@/services/web/http";
import { AppError } from "@/utils/errors";

export interface HgamefreeIndexItem {
	id: string;
	/** 原始标题，尚未去掉 `[大小]`、`官方中文` 等标记 */
	title: string;
	image: string | null;
	/** 下载链接里的压缩包文件名（不含扩展名） */
	file_names: string[];
	/** 文章里的原始下载链接（k2s 系列与 MEGA） */
	file_url: string[];
	/** 文章链接到的外部作品 ID：`steam:<app id>`、`getchu:<id>`、`dlsite:RJxxxxxx` */
	external_ids: string[];
}

interface HgamefreeIndexResponse {
	ready: boolean;
	total: number;
	items: HgamefreeIndexItem[];
}

async function requestIndex(
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<HgamefreeIndexResponse> {
	const query = new URLSearchParams(params).toString();
	const response = await authenticatedFetch(
		`${import.meta.env.BASE_URL}api/hgamefree/search?${query}`,
		{ signal },
	);
	if (!response.ok) {
		throw new AppError({
			code: "hgamefree_index_failed",
			message: `HGameFree index failed: ${response.status}`,
		});
	}
	return (await response.json()) as HgamefreeIndexResponse;
}

/** 索引未就绪时回 null。 */
export async function searchHgamefreeIndex(
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<HgamefreeIndexItem[] | null> {
	const result = await requestIndex({ q: query, limit: String(limit) }, signal);
	return result.ready ? result.items : null;
}

/** 索引未就绪时回 null；就绪但没有这篇文章时回空阵列。 */
export async function getHgamefreeIndexPost(
	id: string,
	signal?: AbortSignal,
): Promise<HgamefreeIndexItem[] | null> {
	const result = await requestIndex({ id }, signal);
	return result.ready ? result.items : null;
}

/** 依外部作品 ID 反查文章；索引未就绪时回 null，就绪但查不到回空阵列。 */
export async function findHgamefreeIndexByExternal(
	externalIds: string[],
	signal?: AbortSignal,
): Promise<HgamefreeIndexItem[] | null> {
	const result = await requestIndex({ ext: externalIds.join(",") }, signal);
	return result.ready ? result.items : null;
}
