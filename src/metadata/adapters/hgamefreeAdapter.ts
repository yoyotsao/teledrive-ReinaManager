import type { GameMetadataDraft, HgamefreeData } from "@/types";
import { fetchHgamefreeById, searchHgamefree } from "../api/hgamefree";
import {
	DEFAULT_METADATA_SEARCH_LIMIT,
	type MetadataSourceAdapter,
} from "../sourceAdapter";
import {
	createSourceCandidate,
	getCandidateSourceData,
	getCandidateSourceId,
	normalizeGameCandidateSources,
	type SourceCandidate,
	type SourceDisplayFields,
} from "../sourceCandidate";

function toHgamefreeCandidate(
	game: GameMetadataDraft,
): SourceCandidate<HgamefreeData> {
	const data = getCandidateSourceData<HgamefreeData>(game, "hgamefree");
	if (!data) {
		throw new Error("Missing hgamefree data in hgamefree candidate");
	}

	return createSourceCandidate({
		source: "hgamefree",
		externalId: getCandidateSourceId(game, "hgamefree"),
		data,
		display: hgamefreeAdapter.toDisplayFields(data),
	});
}

// 搜索结果已经带齐文章的全部数据，不需要 enrichOnSelect。
export const hgamefreeAdapter: MetadataSourceAdapter<HgamefreeData> = {
	key: "hgamefree",
	label: "HGameFree",
	iconUrl: "https://hgamefree.info/favicon.ico",
	validateId: (id) => /^\d+$/.test(id),
	getExternalUrl: (id) => `https://hgamefree.info/?p=${id}`,
	async fetchById(id, ctx) {
		const game = await fetchHgamefreeById(id, ctx);
		return normalizeGameCandidateSources(game, "hgamefree");
	},
	async searchByName(name, ctx) {
		const games = await searchHgamefree(
			name,
			ctx.limit ?? DEFAULT_METADATA_SEARCH_LIMIT,
			ctx,
		);
		return games.map(toHgamefreeCandidate);
	},
	toDisplayFields: (data): SourceDisplayFields => ({
		image: data.image,
		name: data.name,
		aliases: data.aliases ?? [],
		nsfw: data.nsfw,
	}),
};
