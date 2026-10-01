import type { FullGameData, SourceType } from "@/types";
import { isSourceType } from "@/types";
import { getSourceRecordMap, type SourceRecordPayload } from "../sourceRecord";
import {
	getRuntimeSourceAdapter,
	REGISTERED_SOURCE_KEYS,
} from "../sourceRegistry";
import { SOURCE_COVER_PRIORITY } from "./displayMergeRules";

type SourceImageData = Partial<
	Record<SourceType, { image?: string | null } | null | undefined>
>;

export interface SourceImageOption {
	source: SourceType;
	image: string;
}

export type DisplaySourceImagePayload = SourceRecordPayload & {
	id_type?: string | null;
	custom_data?: { cover_source?: SourceType | null } | null;
};

export function getSourceImageMap(game: SourceRecordPayload): SourceImageData {
	const sourceMap = getSourceRecordMap(game);

	return Object.fromEntries(
		REGISTERED_SOURCE_KEYS.map((source) => {
			const data = sourceMap.get(source)?.data;
			return [
				source,
				data ? getRuntimeSourceAdapter(source).toDisplayFields(data) : null,
			];
		}),
	) as SourceImageData;
}

export function resolveSourceImage(
	sources: SourceImageData,
	coverSource?: SourceType | null,
): string | undefined {
	if (coverSource) {
		const selectedImage = sources[coverSource]?.image;
		if (selectedImage) return selectedImage;
	}

	for (const source of SOURCE_COVER_PRIORITY) {
		const image = sources[source]?.image;
		if (image) return image;
	}

	return undefined;
}

export function resolveDisplaySourceImage(
	game: DisplaySourceImagePayload,
): string | undefined {
	const sources = getSourceImageMap(game);
	if (game.id_type && isSourceType(game.id_type)) {
		return sources[game.id_type]?.image ?? undefined;
	}
	if (game.id_type === "mixed") {
		return resolveSourceImage(sources, game.custom_data?.cover_source);
	}
	return undefined;
}

export function getSourceImageOptions(game: FullGameData): SourceImageOption[] {
	const sources = getSourceImageMap(game);

	return SOURCE_COVER_PRIORITY.map((source) => ({
		source,
		image: sources[source]?.image,
	})).filter((option): option is SourceImageOption => Boolean(option.image));
}
