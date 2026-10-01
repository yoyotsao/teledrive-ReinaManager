/**
 * @file bridge 游戏状态 Query 与操作
 * @description bridge 状态独立于服务器资料，并按活跃下载/游戏动态轮询。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { checkServerVersion } from "@/hooks/queries/useServerVersion";
import { type BridgeGameState, bridgeService } from "@/services/web/bridge";

export const bridgeKeys = {
	all: ["bridge", "games"] as const,
	states: (paths: string[]) =>
		["bridge", "games", "states", [...paths].sort()] as const,
};

function nextPollInterval(states: BridgeGameState[] | undefined) {
	if (states?.some((state) => state.status === "downloading")) return 2_000;
	if (states?.some((state) => state.status === "running")) return 10_000;
	return false;
}

// 多个页面可能同时观察同一路径（例如详情页与工具栏）；以共享快照避免重复检查版本。
const previousBridgeStatuses = new Map<string, BridgeGameState["status"]>();

export function useBridgeGames(paths: string[]) {
	const queryClient = useQueryClient();
	const stablePaths = [...new Set(paths.filter(Boolean))].sort();
	const queryKey = bridgeKeys.states(stablePaths);
	const query = useQuery({
		queryKey,
		queryFn: () => bridgeService.getStates(stablePaths),
		enabled: stablePaths.length > 0,
		staleTime: 0,
		refetchOnMount: true,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
		refetchInterval: (current) => nextPollInterval(current.state.data?.games),
		refetchIntervalInBackground: false,
	});

	const fetchMutation = useMutation({
		mutationFn: (path: string) => bridgeService.fetch(path),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: bridgeKeys.all }),
	});
	const cancelMutation = useMutation({
		mutationFn: (path: string) => bridgeService.cancel(path),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: bridgeKeys.all }),
	});
	const exesMutation = useMutation({
		mutationFn: (path: string) => bridgeService.getExes(path),
	});
	const launchMutation = useMutation({
		mutationFn: bridgeService.launch,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: bridgeKeys.all }),
	});

	useEffect(() => {
		const handleWindowFocus = () => {
			if (stablePaths.length > 0 && document.visibilityState === "visible") {
				void query.refetch().catch((error) => {
					console.warn("窗口聚焦后刷新 bridge 状态失败:", error);
				});
			}
		};
		window.addEventListener("focus", handleWindowFocus);
		return () => window.removeEventListener("focus", handleWindowFocus);
	}, [query.refetch, stablePaths.length]);

	useEffect(() => {
		if (query.isError) return;
		for (const state of query.data?.games ?? []) {
			const previous = previousBridgeStatuses.get(state.path);
			if (previous === "running" && state.status !== "running") {
				void checkServerVersion().catch((error) => {
					console.warn("游戏结束后检查服务器版本失败:", error);
				});
			}
			previousBridgeStatuses.set(state.path, state.status);
		}
	}, [query.data, query.isError]);

	const states = query.isError ? [] : (query.data?.games ?? []);
	return {
		data: query.data,
		error: query.error,
		isError: query.isError,
		isFetching: query.isFetching,
		isLoading: query.isLoading,
		refetch: query.refetch,
		states,
		stateByPath: useMemo(
			() => new Map(states.map((state) => [state.path, state])),
			[states],
		),
		isUnavailable:
			(query.error as { code?: string } | null)?.code === "bridge_unavailable",
		fetchGame: fetchMutation.mutateAsync,
		cancelGame: cancelMutation.mutateAsync,
		getExes: exesMutation.mutateAsync,
		launchBridgeGame: launchMutation.mutateAsync,
		isFetchingGame: fetchMutation.isPending,
		isCancellingGame: cancelMutation.isPending,
		isLaunchingBridgeGame: launchMutation.isPending,
	};
}
