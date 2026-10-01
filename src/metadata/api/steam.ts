/**
 * @file Steam 商店 API 封装
 * @description 使用公开的 storesearch / appdetails，不需要密钥。
 * 分级页面（年龄限制）背后的游戏在部分地区会回 success: false，此时视为查无资料。
 */

import i18next from "i18next";
import type { GameMetadataDraft, SteamData } from "@/types";
import { AppError } from "@/utils/errors";
import {
	createGameCandidate,
	createSourceCandidateRecord,
} from "../sourceCandidate";
import http, {
	type NetworkRequestContext,
	type TauriHttpOptions,
} from "./http";

const STEAM_STORE = "https://store.steampowered.com";

interface SteamSearchItem {
	id: number;
	name: string;
	type?: string;
	tiny_image?: string;
}

interface SteamSearchResponse {
	items?: SteamSearchItem[];
}

interface SteamAppData {
	type?: string;
	name?: string;
	short_description?: string;
	about_the_game?: string;
	header_image?: string;
	developers?: string[];
	genres?: { description?: string }[];
	release_date?: { coming_soon?: boolean; date?: string };
	required_age?: number | string;
	content_descriptors?: { ids?: number[] };
}

type SteamDetailsResponse = Record<
	string,
	{ success: boolean; data?: SteamAppData } | undefined
>;

/** Steam 内容描述 ID：1 = 部分裸露或性内容，3 = 仅限成人的性内容。 */
const NSFW_DESCRIPTOR_IDS = [1, 3];

const MONTHS: Record<string, string> = {
	jan: "01",
	feb: "02",
	mar: "03",
	apr: "04",
	may: "05",
	jun: "06",
	jul: "07",
	aug: "08",
	sep: "09",
	oct: "10",
	nov: "11",
	dec: "12",
};

function buildSteamOptions(options: TauriHttpOptions = {}): TauriHttpOptions {
	return {
		...options,
		headers: { Accept: "application/json", ...options.headers },
		rateLimit: { source: "steam" },
	};
}

/** 界面语言对应 Steam 的语言代码。 */
function toSteamLanguage(language: string): string {
	switch (language) {
		case "zh-CN":
			return "schinese";
		case "zh-TW":
			return "tchinese";
		case "ja-JP":
			return "japanese";
		default:
			return "english";
	}
}

/** 解析各语言的发售日文字（"2025 年 2 月 21 日"、"Feb 21, 2025"、"21 Feb, 2025"）。 */
export function parseSteamDate(raw: string | undefined): string | undefined {
	const text = raw?.trim();
	if (!text) return undefined;

	const numeric = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
	if (numeric) {
		const [, year, month, day] = numeric;
		return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
	}

	const monthFirst = text.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
	const dayFirst = text.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
	const [month, day, year] = monthFirst
		? [monthFirst[1], monthFirst[2], monthFirst[3]]
		: dayFirst
			? [dayFirst[2], dayFirst[1], dayFirst[3]]
			: [];
	const monthNumber = month
		? MONTHS[month.slice(0, 3).toLowerCase()]
		: undefined;
	return monthNumber && day && year
		? `${year}-${monthNumber}-${day.padStart(2, "0")}`
		: undefined;
}

/** Steam 的介绍是 HTML（含图片、GIF）；转成保留段落换行的纯文字。 */
export function steamHtmlToText(html: string | undefined): string | undefined {
	if (!html) return undefined;
	const withBreaks = html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|li|h[1-6]|div)>/gi, "\n");
	const text = (
		new DOMParser().parseFromString(withBreaks, "text/html").documentElement
			.textContent ?? ""
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text || undefined;
}

function isNsfw(data: SteamAppData): boolean | undefined {
	const ids = data.content_descriptors?.ids ?? [];
	if (ids.some((id) => NSFW_DESCRIPTOR_IDS.includes(id))) return true;
	return Number(data.required_age) >= 18 ? true : undefined;
}

function detailToDraft(id: string, data: SteamAppData): GameMetadataDraft {
	const tags = (data.genres ?? [])
		.map((genre) => genre.description?.trim())
		.filter((tag): tag is string => Boolean(tag));
	const developer = (data.developers ?? []).filter(Boolean).join("/");
	const steamData: SteamData = {
		name: data.name?.trim(),
		image: data.header_image,
		summary:
			steamHtmlToText(data.about_the_game) ??
			steamHtmlToText(data.short_description),
		tags,
		developer: developer || undefined,
		nsfw: isNsfw(data),
		date: data.release_date?.coming_soon
			? undefined
			: parseSteamDate(data.release_date?.date),
	};

	return createGameCandidate({
		idType: "steam",
		source: createSourceCandidateRecord("steam", id, steamData),
	});
}

export function normalizeSteamId(raw: string): string | undefined {
	const value = raw.trim();
	const fromUrl = value.match(/store\.steampowered\.com\/app\/(\d+)/i);
	const id = fromUrl?.[1] ?? value;
	return /^\d+$/.test(id) ? id : undefined;
}

export async function searchSteam(
	name: string,
	limit = 8,
	context: NetworkRequestContext = {},
): Promise<GameMetadataDraft[]> {
	const keyword = name.trim();
	if (!keyword) return [];

	// 用英文搜索：资料夹名多半是 Steam 的英文名，英文名匹配最稳定。
	const response = await http.get<SteamSearchResponse>(
		`${STEAM_STORE}/api/storesearch/`,
		buildSteamOptions({
			...context,
			params: { term: keyword, cc: "us", l: "english" },
		}),
	);

	return (response.data?.items ?? [])
		.filter((item) => item.id && item.name && (item.type ?? "app") === "app")
		.slice(0, limit)
		.map((item) =>
			createGameCandidate({
				idType: "steam",
				source: createSourceCandidateRecord("steam", String(item.id), {
					name: item.name,
					image: item.tiny_image,
				} satisfies SteamData),
			}),
		);
}

export async function fetchSteamById(
	rawId: string,
	context: NetworkRequestContext = {},
): Promise<GameMetadataDraft> {
	const id = normalizeSteamId(rawId);
	if (!id) {
		throw new AppError({
			code: "invalid_game_id",
			message: `Invalid Steam app id: ${rawId}`,
		});
	}

	const response = await http.get<SteamDetailsResponse>(
		`${STEAM_STORE}/api/appdetails`,
		buildSteamOptions({
			...context,
			params: {
				appids: id,
				cc: "us",
				l: toSteamLanguage(i18next.language),
			},
		}),
	);

	const entry = response.data?.[id];
	// 音轨、DLC 等不是游戏本体，也当作查无资料
	if (!entry?.success || !entry.data || entry.data.type !== "game") {
		throw new AppError({
			code: "metadata_not_found",
			message: `Steam app not found: ${id}`,
		});
	}
	return detailToDraft(id, entry.data);
}
