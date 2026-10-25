import type { GameData } from "@/types";

interface CoverPreviewParams {
	selectedGame: GameData;
	shouldDeleteImage: boolean;
	tempCoverUrl: string | null;
	previewUrl: string | null;
	sourceCoverImage?: string;
	sourceCoverChanged: boolean;
	/** 没有更优先的预览来源时使用：网页版由 useGameCoverSrc 算出、桌面版由呼叫端的 getGameCover 算出 */
	fallbackCoverUrl: string;
}

export function getCoverPreviewUrl({
	shouldDeleteImage,
	tempCoverUrl,
	previewUrl,
	sourceCoverImage,
	sourceCoverChanged,
	fallbackCoverUrl,
}: CoverPreviewParams): string {
	if (shouldDeleteImage) {
		return sourceCoverImage ?? fallbackCoverUrl;
	}
	if (tempCoverUrl) {
		return tempCoverUrl;
	}
	if (previewUrl) {
		return previewUrl;
	}
	if (sourceCoverChanged && sourceCoverImage) {
		return sourceCoverImage;
	}

	return fallbackCoverUrl;
}

export function isInvalidExecutableName(executable: string): boolean {
	const normalized = executable.trim();
	return (
		normalized !== "" &&
		(normalized === "." || normalized === ".." || /[\\/]/.test(normalized))
	);
}

export function stringArraysEqual(
	current: string[],
	original: readonly string[] | null | undefined,
): boolean {
	const normalizedOriginal = original ?? [];
	if (current.length !== normalizedOriginal.length) {
		return false;
	}

	return current.every((value, index) => value === normalizedOriginal[index]);
}
