import { authenticatedFetch } from "@/services/web/http";
import { AppError } from "@/utils/errors";

export async function getMetadataImageBlob(
	url: string,
	signal?: AbortSignal,
): Promise<Blob> {
	const response = await authenticatedFetch(
		`/game/api/metadata/image?url=${encodeURIComponent(url)}`,
		{ signal },
	);
	if (!response.ok) {
		throw new AppError({
			code: "metadata_image_failed",
			message: `Metadata image failed: ${response.status}`,
		});
	}
	return response.blob();
}
