import type { GameMetadataDraft, SteamData } from "@/types";
import { fetchSteamById, normalizeSteamId, searchSteam } from "../api/steam";
import {
	DEFAULT_METADATA_SEARCH_LIMIT,
	type MetadataSourceAdapter,
} from "../sourceAdapter";
import {
	createSourceCandidate,
	getCandidateSourceData,
	getCandidateSourceId,
	mergeCandidateDetailData,
	normalizeGameCandidateSources,
	type SourceCandidate,
	type SourceDisplayFields,
	sourceCandidateToDraft,
} from "../sourceCandidate";

function toSteamCandidate(game: GameMetadataDraft): SourceCandidate<SteamData> {
	const data = getCandidateSourceData<SteamData>(game, "steam");
	if (!data) {
		throw new Error("Missing steam data in steam candidate");
	}

	return createSourceCandidate({
		source: "steam",
		externalId: getCandidateSourceId(game, "steam"),
		data,
		display: steamAdapter.toDisplayFields(data),
	});
}

export const steamAdapter: MetadataSourceAdapter<SteamData> = {
	key: "steam",
	label: "Steam",
	iconUrl: "https://store.steampowered.com/favicon.ico",
	validateId: (id) => Boolean(normalizeSteamId(id)),
	getExternalUrl: (id) => `https://store.steampowered.com/app/${id}`,
	async fetchById(id, ctx) {
		const game = await fetchSteamById(id, ctx);
		return normalizeGameCandidateSources(game, "steam");
	},
	async searchByName(name, ctx) {
		const games = await searchSteam(
			name,
			ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
			ctx,
		);
		return games.map(toSteamCandidate);
	},
	// 搜索结果只有名称与缩图，选中后再抓完整资料
	async enrichOnSelect(candidate, ctx) {
		if (!candidate.externalId) {
			return sourceCandidateToDraft(candidate);
		}

		const game = await fetchSteamById(candidate.externalId, ctx);
		return mergeCandidateDetailData(candidate, game);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		summary: data.summary,
		tags: data.tags ?? [],
		developer: data.developer,
		nsfw: data.nsfw,
		date: data.date,
	}),
};
