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
