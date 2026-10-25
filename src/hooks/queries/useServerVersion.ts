/**
 * @file 跨装置资料版本同步
 * @description 网页版定期读取 reina-server 的 data_version；版本改变时失效所有 ["server", ...] query。
 *
 * 规则（见 spec 3.7）：
 * - 已同步版本只由这里的轮询结果推进，绝不采用写入请求回传的版本；
 *   写入回应的版本可能已包含其他装置同时做的修改，直接采用会让那些修改永远看不到。
 * - 首次采样必须在首屏资料读取之前完成（见 main.tsx），否则中间发生的修改会被跳过。
 * - 只有全部重新读取成功才推进版本；失败时下一次轮询重试。
 */

import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryClient as appQueryClient } from "@/providers/queryClient";
import { fetchServerVersion } from "@/services/web/version";
import { SERVER_QUERY_ROOT } from "./serverKeys";

export const SERVER_VERSION_POLL_MS = 60_000;

export interface ServerVersionSyncer {
	/** 首屏资料读取之前的首次采样：只记录版本，不失效任何 query */
	prime(): Promise<void>;
	check(): Promise<void>;
	getSyncedVersion(): number | null;
}

export function createServerVersionSyncer(
	client: QueryClient,
	fetchVersion: () => Promise<number> = fetchServerVersion,
): ServerVersionSyncer {
	let syncedVersion: number | null = null;
	// prime 与 check 分开去重：prime 进行中呼叫 check 时，check 不能直接借用 prime 的采样结果
	// （那样会让呼叫者以为做了版本比对，实际上既没有比对也没有失效），必须等 prime 结束后再执行自己的比对
	let primeInFlight: Promise<void> | null = null;
	let checkInFlight: Promise<void> | null = null;

	// 只有在首屏资料读取之前才能「直接记录版本」：那时还没有任何快取，记录的版本必然不旧于之后读到的资料
	async function runPrime(): Promise<void> {
		const version = await fetchVersion();
		if (syncedVersion === null) syncedVersion = version;
	}

	async function runCheck(): Promise<void> {
		const version = await fetchVersion();
		// 已同步且版本未变：什么都不做。
		// 尚未成功采样（启动时采样失败）：已加载的资料版本未知，不能直接记录，必须先重新读取
		if (syncedVersion !== null && version === syncedVersion) return;

		// 失效后 active query 会立刻重新读取；throwOnError 让读取失败时不推进版本。
		// 先取得版本再重新读取，所以读到的资料一定不旧于 version，之后的修改会让版本再变
		await client.invalidateQueries(
			{ queryKey: SERVER_QUERY_ROOT },
			{ throwOnError: true },
		);
		syncedVersion = version;
	}

	function prime(): Promise<void> {
		if (!primeInFlight) {
			primeInFlight = runPrime().finally(() => {
				primeInFlight = null;
			});
		}
		return primeInFlight;
	}

	function check(): Promise<void> {
		if (!checkInFlight) {
			// 与 prime 串接而非并行：prime 若还没写入 syncedVersion，check 直接比对会误判版本未变；
			// prime 失败也不影响 check 自己的比对，所以这里只等待、不透传 prime 的错误
			const waitForPrime = primeInFlight
				? primeInFlight.catch(() => {})
				: Promise.resolve();
			checkInFlight = waitForPrime.then(runCheck).finally(() => {
				checkInFlight = null;
			});
		}
		return checkInFlight;
	}

	return {
		prime,
		check,
		getSyncedVersion: () => syncedVersion,
	};
}

const appSyncer = createServerVersionSyncer(appQueryClient);

/** 启动时、首屏资料读取之前呼叫一次 */
export function primeServerVersion(): Promise<void> {
	return appSyncer.prime();
}

/** 立刻检查一次（例如本机 bridge 发现游戏结束时，见计划 B） */
export function checkServerVersion(): Promise<void> {
	return appSyncer.check();
}

/**
 * 前景时每 60 秒检查；窗口聚焦、回到前景、重新连线时立刻检查；隐藏时暂停
 */
export function useServerVersionSync(
	syncer: ServerVersionSyncer = appSyncer,
): void {
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null;

		const safeCheck = () => {
			void syncer.check().catch((error) => {
				console.warn("检查服务器资料版本失败:", error);
			});
		};
		const startPolling = () => {
			if (timer === null) {
				timer = setInterval(safeCheck, SERVER_VERSION_POLL_MS);
			}
		};
		const stopPolling = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				safeCheck();
				startPolling();
			} else {
				stopPolling();
			}
		};

		window.addEventListener("focus", safeCheck);
		window.addEventListener("online", safeCheck);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		if (document.visibilityState === "visible") {
			safeCheck();
			startPolling();
		}

		return () => {
			stopPolling();
			window.removeEventListener("focus", safeCheck);
			window.removeEventListener("online", safeCheck);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [syncer]);
}
