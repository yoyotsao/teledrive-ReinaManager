/**
 * @file HGameFree 下载站文章 API 封装
 * @description 通过站点开放的 WordPress REST API 搜索文章。文章只有标题、封面和下载链接，
 * 没有简介等元数据；价值在于标题和下载压缩包的文件名与用户本地命名一致，可直接按文件名匹配。
 */

import { isWebRuntime } from "@/services/platform";
import type { GameMetadataDraft, HgamefreeData } from "@/types";
import { AppError } from "@/utils/errors";
import {
	createGameCandidate,
	createSourceCandidateRecord,
} from "../sourceCandidate";
import {
	findHgamefreeIndexByExternal,
	getHgamefreeIndexPost,
	type HgamefreeIndexItem,
	searchHgamefreeIndex,
} from "./hgamefreeIndex";
import http, {
	type NetworkRequestContext,
	type TauriHttpOptions,
} from "./http";

const HGAMEFREE_POSTS_API = "https://hgamefree.info/wp-json/wp/v2/posts";

// _embed 需要 _links 才会带出封面；content 用来解析下载链接里的文件名。
const HGAMEFREE_FIELDS = "id,title,content,_embedded,_links";

interface HgamefreePost {
	id: number;
	title?: { rendered?: string };
	content?: { rendered?: string };
	_embedded?: {
		"wp:featuredmedia"?: { source_url?: string }[];
	};
}

/** k2s 系列网盘的链接带原始文件名。 */
const K2S_FILE_URL =
	/^https?:\/\/(?:www\.)?(?:k2s\.cc|keep2share\.\w+|fileboom\.me|fboom\.me|tezfiles\.com)\/file\/[^/]+\/(.+)$/i;

/** MEGA 链接是加密的，取不到文件名，但仍是原始下载链接。 */
const MEGA_URL = /^https?:\/\/(?:www\.)?mega\.(?:nz|co\.nz)\//i;

/** 标题末尾的 [大小][空间类型] 之类的标记。 */
const TRAILING_BRACKETS = /\s*(?:\[[^\]]*\]|［[^］]*］)\s*$/;

/** 标题末尾的语言、修正、版本标记；长的写在前面，避免被短的抢先匹配。 */
const TRAILING_TAGS =
	/\s*(?:官方中文|機翻中文|AI翻中文|AI翻|官中|機翻|漢化版?|中文版?|無修正版?|無修版|無修|版本更新|補檔|\+?DLC|v\d+(?:\.\d+)*|\d+(?:\.\d+)+)\s*$/i;

function buildHgamefreeOptions(
	options: TauriHttpOptions = {},
): TauriHttpOptions {
	return {
		...options,
		headers: {
			Accept: "application/json",
			...options.headers,
		},
		rateLimit: { source: "hgamefree" },
	};
}

function decodeHtml(html: string): string {
	return (
		new DOMParser().parseFromString(html, "text/html").documentElement
			.textContent ?? ""
	).trim();
}

function safeDecodeUri(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** 去掉标题末尾的大小、空间、语言、版本标记，得到游戏本名。 */
export function cleanHgamefreeTitle(rawTitle: string): string {
	let title = rawTitle.trim();
	for (;;) {
		const next = title
			.replace(TRAILING_BRACKETS, "")
			.replace(TRAILING_TAGS, "")
			.trim();
		if (next === title) break;
		title = next;
	}
	return title || rawTitle.trim();
}

/** 去掉压缩包扩展名与分卷后缀，与云端扫描从 zip 文件名得到的名称对齐。 */
function archiveStem(fileName: string): string {
	return fileName
		.replace(/\.(?:zip|rar|7z)$/i, "")
		.replace(/\.(?:part\d+|\d{3})$/i, "")
		.trim();
}

/** 收集文章内容里所有原始下载链接（k2s 系列与 MEGA），保持顺序、去重。 */
export function extractHgamefreeDownloadLinks(contentHtml: string): string[] {
	const doc = new DOMParser().parseFromString(contentHtml, "text/html");
	const links = new Set<string>();
	for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
		const href = anchor.getAttribute("href")?.trim() ?? "";
		if (K2S_FILE_URL.test(href) || MEGA_URL.test(href)) links.add(href);
	}
	return Array.from(links);
}

/** 从下载链接取出 k2s 系列的文件名（不含扩展名）。 */
export function extractHgamefreeFileNames(contentHtml: string): string[] {
	const names = new Set<string>();
	for (const href of extractHgamefreeDownloadLinks(contentHtml)) {
		const match = K2S_FILE_URL.exec(href);
		if (!match?.[1]) continue;

		const fileName = safeDecodeUri(match[1].replace(/[?#].*$/, ""));
		const stem = archiveStem(fileName);
		if (stem) names.add(stem);
	}
	return Array.from(names);
}

function postToDraft(post: HgamefreePost): GameMetadataDraft {
	const rawTitle = decodeHtml(post.title?.rendered ?? "");
	const name = cleanHgamefreeTitle(rawTitle);
	if (!name) {
		throw new AppError({
			code: "metadata_not_found",
			message: `HGameFree post has no title: ${post.id}`,
		});
	}

	return buildDraft(String(post.id), {
		title: name,
		image: post._embedded?.["wp:featuredmedia"]?.[0]?.source_url,
		fileNames: extractHgamefreeFileNames(post.content?.rendered ?? ""),
		fileUrl: extractHgamefreeDownloadLinks(post.content?.rendered ?? ""),
	});
}

function buildDraft(
	id: string,
	post: {
		title: string;
		image?: string | null;
		fileNames: string[];
		fileUrl: string[];
		externalIds?: string[];
	},
): GameMetadataDraft {
	const data: HgamefreeData = {
		name: post.title,
		...(post.image ? { image: post.image } : {}),
		...(post.fileNames.length > 0 ? { aliases: post.fileNames } : {}),
		...(post.fileUrl.length > 0 ? { file_url: post.fileUrl } : {}),
		...(post.externalIds?.length ? { external_ids: post.externalIds } : {}),
		// 站点只收 H 游戏。
		nsfw: true,
	};

	return createGameCandidate({
		idType: "hgamefree",
		source: createSourceCandidateRecord("hgamefree", id, data),
	});
}

/** 索引里的文章：标题在这里才去掉标记，文件名与下载链接服务器已经整理好。 */
function indexItemToDraft(item: HgamefreeIndexItem): GameMetadataDraft {
	return buildDraft(item.id, {
		title: cleanHgamefreeTitle(item.title),
		image: item.image,
		fileNames: item.file_names,
		fileUrl: item.file_url,
		externalIds: item.external_ids,
	});
}

/**
 * 依外部作品 ID（`steam:<id>`、`getchu:<id>`、`dlsite:RJxxxxxx`）反查文章。
 * 只有网页版有本机索引；桌面版或索引未就绪时回 null。
 */
export async function findHgamefreeByExternalId(
	externalId: string,
	context: NetworkRequestContext = {},
): Promise<GameMetadataDraft | null> {
	if (!isWebRuntime()) return null;
	const items = await findHgamefreeIndexByExternal(
		[externalId],
		context.signal,
	).catch(() => null);
	return items?.[0] ? indexItemToDraft(items[0]) : null;
}

export async function searchHgamefree(
	name: string,
	limit = 8,
	context: NetworkRequestContext = {},
): Promise<GameMetadataDraft[]> {
	const keyword = name.trim();
	if (!keyword) return [];

	// 网页版优先查服务器上的本机索引；索引尚未就绪或请求失败时退回站台即时搜索。
	if (isWebRuntime()) {
		const items = await searchHgamefreeIndex(
			keyword,
			limit,
			context.signal,
		).catch(() => null);
		if (items) return items.map(indexItemToDraft);
	}

	const response = await http.get<HgamefreePost[]>(
		HGAMEFREE_POSTS_API,
		buildHgamefreeOptions({
			...context,
			params: {
				search: keyword,
				per_page: limit,
				_embed: "wp:featuredmedia",
				_fields: HGAMEFREE_FIELDS,
			},
		}),
	);

	return (Array.isArray(response.data) ? response.data : []).map(postToDraft);
}

export async function fetchHgamefreeById(
	id: string,
	context: NetworkRequestContext = {},
): Promise<GameMetadataDraft> {
	if (!/^\d+$/.test(id)) {
		throw new AppError({
			code: "invalid_game_id",
			message: `Invalid HGameFree post id: ${id}`,
		});
	}

	if (isWebRuntime()) {
		const items = await getHgamefreeIndexPost(id, context.signal).catch(
			() => null,
		);
		if (items?.[0]) return indexItemToDraft(items[0]);
	}

	const response = await http.get<HgamefreePost | null>(
		`${HGAMEFREE_POSTS_API}/${id}`,
		buildHgamefreeOptions({
			...context,
			params: { _embed: "wp:featuredmedia", _fields: HGAMEFREE_FIELDS },
		}),
	);

	if (!response.data?.id) {
		throw new AppError({
			code: "metadata_not_found",
			message: `HGameFree post not found: ${id}`,
		});
	}
	return postToDraft(response.data);
}
