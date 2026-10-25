import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameData } from "@/types";
import { useGameLaunchFlow } from "./useGameLaunchFlow";

const mocks = vi.hoisted(() => ({
	state: null as null | Record<string, unknown>,
	updateGame: vi.fn(),
	fetchGame: vi.fn(),
	cancelGame: vi.fn(),
	getExes: vi.fn(),
	launchBridgeGame: vi.fn(),
	refetch: vi.fn(),
	launchDesktopGame: vi.fn(),
	handleExeFile: vi.fn(),
	splitExecutablePath: vi.fn(),
	snackbar: {
		error: vi.fn(),
		warning: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock("@/services/platform", () => ({ isWebRuntime: () => true }));
vi.mock("@/hooks/queries/useGames", () => ({
	useUpdateGame: () => ({ mutateAsync: mocks.updateGame }),
}));
vi.mock("@/hooks/queries/useBridgeGames", () => ({
	useBridgeGames: () => ({
		states: mocks.state ? [mocks.state] : [],
		stateByPath: new Map(mocks.state ? [[mocks.state.path, mocks.state]] : []),
		isError: false,
		isUnavailable: false,
		isLoading: false,
		error: null,
		fetchGame: mocks.fetchGame,
		cancelGame: mocks.cancelGame,
		getExes: mocks.getExes,
		launchBridgeGame: mocks.launchBridgeGame,
		isFetchingGame: false,
		isCancellingGame: false,
		isLaunchingBridgeGame: false,
		refetch: mocks.refetch,
	}),
}));
vi.mock("@/store/gamePlayStore", () => ({
	useGamePlayStore: (
		selector: (state: {
			launchGame: typeof mocks.launchDesktopGame;
		}) => unknown,
	) => selector({ launchGame: mocks.launchDesktopGame }),
}));
vi.mock("@/providers/snackBar", () => ({ snackbar: mocks.snackbar }));
vi.mock("@/services/fs/fileDialog", () => ({
	handleExeFile: mocks.handleExeFile,
	splitExecutablePath: mocks.splitExecutablePath,
}));

const game: GameData = {
	id: 17,
	id_type: "custom",
	sourceIds: {},
	teledrive_path: "game/雪の花",
};

const state = (status: string, extras: Record<string, unknown> = {}) => ({
	path: game.teledrive_path,
	status,
	completed_bytes: 0,
	total_bytes: 0,
	elapsed_seconds: 0,
	error: null,
	...extras,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.state = null;
	mocks.updateGame.mockResolvedValue({});
	mocks.fetchGame.mockResolvedValue(undefined);
	mocks.cancelGame.mockResolvedValue(undefined);
	mocks.getExes.mockResolvedValue({ exes: ["bin/game.exe"] });
	mocks.launchBridgeGame.mockResolvedValue({ session_id: "session-17" });
	mocks.refetch.mockResolvedValue({});
});

describe("useGameLaunchFlow web runtime", () => {
	it("absent/incomplete 開始下載，downloading 取消，running 不呼叫桌面 launch", async () => {
		mocks.state = state("absent");
		const { result, rerender } = renderHook(
			({ selected }) => useGameLaunchFlow(selected),
			{
				initialProps: { selected: game },
			},
		);
		await act(async () => result.current.launchGame(game));
		expect(mocks.fetchGame).toHaveBeenCalledWith(game.teledrive_path);

		mocks.state = state("incomplete");
		rerender({ selected: game });
		await act(async () => result.current.launchGame(game));
		expect(mocks.fetchGame).toHaveBeenCalledTimes(2);

		mocks.state = state("downloading");
		rerender({ selected: game });
		await act(async () => result.current.launchGame(game));
		expect(mocks.cancelGame).toHaveBeenCalledWith(game.teledrive_path);

		mocks.state = state("running");
		rerender({ selected: game });
		await act(async () => result.current.launchGame(game));
		expect(mocks.launchDesktopGame).not.toHaveBeenCalled();
		expect(mocks.launchBridgeGame).not.toHaveBeenCalled();
		expect(mocks.handleExeFile).not.toHaveBeenCalled();
	});

	it("ready/no exe 讀取清單並把相對 exe path 保存到 server 後啟動", async () => {
		mocks.state = state("ready", { capabilities: { locale_emulator: true } });
		const { result } = renderHook(() => useGameLaunchFlow(game));
		await act(async () => result.current.launchGame(game));
		expect(mocks.getExes).toHaveBeenCalledWith(game.teledrive_path);
		expect(result.current.exeChoices).toEqual(["bin/game.exe"]);

		await act(async () => result.current.selectBridgeExe(game, "bin/game.exe"));
		expect(mocks.updateGame).toHaveBeenCalledWith({
			gameId: 17,
			updates: { exe_relpath: "bin/game.exe" },
		});
		act(() => result.current.setLocaleEmulator(true));
		await act(async () => result.current.launchGame(game));
		expect(mocks.launchBridgeGame).toHaveBeenCalledWith({
			path: game.teledrive_path,
			exe_relpath: "bin/game.exe",
			game_id: 17,
			locale_emulator: true,
		});
	});

	it("exe 失效只要求重新選擇而不改 server 值；取消完成競態時刷新狀態", async () => {
		mocks.state = state("ready");
		mocks.launchBridgeGame.mockRejectedValueOnce(
			Object.assign(new Error("exe invalid"), { code: "bridge_exe_invalid" }),
		);
		const savedGame = { ...game, exe_relpath: "bin/old.exe" };
		const { result, rerender } = renderHook(
			({ selected }) => useGameLaunchFlow(selected),
			{ initialProps: { selected: savedGame } },
		);
		await act(async () => result.current.launchGame(savedGame));
		// exe_relpath 是跨裝置共用資料，單一電腦的失效不能清掉 server 上的值
		expect(mocks.updateGame).not.toHaveBeenCalled();
		expect(mocks.getExes).toHaveBeenCalledWith(game.teledrive_path);
		expect(result.current.forceExeSelection).toBe(true);

		mocks.state = state("downloading");
		mocks.cancelGame.mockRejectedValueOnce(
			Object.assign(new Error("finished"), { code: "download_not_active" }),
		);
		rerender({ selected: savedGame });
		await act(async () => result.current.launchGame(savedGame));
		expect(mocks.refetch).toHaveBeenCalledTimes(1);
	});

	it.each(["bridge_game_running", "bridge_game_not_ready"])(
		"%s 只刷新狀態，不清除 exe 也不進入重選",
		async (code) => {
			mocks.state = state("ready");
			mocks.launchBridgeGame.mockRejectedValueOnce(
				Object.assign(new Error(code), { code }),
			);
			const savedGame = { ...game, exe_relpath: "bin/game.exe" };
			const { result } = renderHook(() => useGameLaunchFlow(savedGame));
			await act(async () => result.current.launchGame(savedGame));
			expect(mocks.refetch).toHaveBeenCalledTimes(1);
			expect(mocks.updateGame).not.toHaveBeenCalled();
			expect(mocks.getExes).not.toHaveBeenCalled();
			expect(result.current.forceExeSelection).toBe(false);
		},
	);

	it("Web 路徑不會載入桌面 exe 對話框", async () => {
		const { result } = renderHook(() => useGameLaunchFlow(game));
		await act(async () =>
			expect(result.current.syncLocalPath(game)).resolves.toBe(false),
		);
		expect(mocks.handleExeFile).not.toHaveBeenCalled();
		expect(mocks.splitExecutablePath).not.toHaveBeenCalled();
	});
});
