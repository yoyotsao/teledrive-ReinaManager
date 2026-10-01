import type { ScanCandidate } from "@/metadata/cloudScanResolve";
import { authenticatedFetch } from "@/services/web/http";
import { AppError } from "@/utils/errors";

export interface ScanResult {
	added_ids: number[];
	pending_ids: number[];
}

export interface ScanPendingItem {
	id: number;
	name: string;
	teledrive_path: string;
	scan_status: "pending" | "needs_confirmation";
	scan_candidates: ScanCandidate[];
}

async function readJson<T>(response: Response, action: string): Promise<T> {
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as {
			code?: string;
		};
		throw new AppError({
			code: body.code ?? "scan_request_failed",
			message: `${action} failed: ${response.status}`,
		});
	}
	return (await response.json()) as T;
}

export async function startCloudScan(): Promise<ScanResult> {
	return readJson(
		await authenticatedFetch(`${import.meta.env.BASE_URL}api/scan`, {
			method: "POST",
		}),
		"Cloud scan",
	);
}

export async function getScanPending(): Promise<ScanPendingItem[]> {
	return readJson(
		await authenticatedFetch(`${import.meta.env.BASE_URL}api/scan/pending`),
		"Scan pending",
	);
}

/** 各遊戲 zip 的位元組數，鍵為 `teledrive_path`。 */
export async function getScanSizes(): Promise<Record<string, number>> {
	return readJson(
		await authenticatedFetch(`${import.meta.env.BASE_URL}api/scan/sizes`),
		"Scan sizes",
	);
}

/**
 * 把游戏对应的 TeleDrive 文件移到垃圾桶（可在 TeleDrive 还原）。
 * 必须在删除游戏记录之前调用：失败时记录还在，使用者可以重试。
 */
export async function trashCloudGames(
	gameIds: number[],
): Promise<{ trashed: number }> {
	return readJson(
		await authenticatedFetch(
			`${import.meta.env.BASE_URL}api/scan/cloud-trash`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ game_ids: gameIds }),
			},
		),
		"Cloud trash",
	);
}
