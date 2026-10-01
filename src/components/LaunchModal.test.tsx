import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameData } from "@/types";
import { LaunchModal } from "./LaunchModal";

const mocks = vi.hoisted(() => ({
	flow: {
		launchGame: vi.fn(),
		syncLocalPath: vi.fn(),
		bridgeState: undefined as Record<string, unknown> | undefined,
		bridgeError: null as unknown,
		bridgeIsError: false,
		bridgeUnavailable: false,
		bridgeLoading: false,
		exeChoices: null as string[] | null,
		selectBridgeExe: vi.fn(),
		loadBridgeExes: vi.fn(),
		localeEmulator: false,
		setLocaleEmulator: vi.fn(),
		forceExeSelection: false,
		isBridgeBusy: false,
	},
	stopGame: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-i18next")>();
	return {
		...actual,
		useTranslation: () => ({
			t: (_key: string, fallback: string) => fallback,
		}),
	};
});
vi.mock("@/services/platform", () => ({ isWebRuntime: () => true }));
vi.mock("@/hooks/features/games/useGameLaunchFlow", () => ({
	useGameLaunchFlow: () => mocks.flow,
}));
vi.mock("@/store/gamePlayStore", () => ({
	useGamePlayStore: (selector: (state: Record<string, unknown>) => unknown) =>
		selector({
			stopGame: mocks.stopGame,
			isThisGameRunning: false,
			realTimeState: null,
			runningGameIds: new Set(),
			gameRealTimeStates: {},
		}),
}));

const game: GameData = {
	id: 9,
	id_type: "custom",
	sourceIds: {},
	teledrive_path: "game/A",
};

function setState(status: string, options: Record<string, unknown> = {}) {
	mocks.flow.bridgeState = {
		path: "game/A",
		status,
		completed_bytes: 512,
		total_bytes: 1024,
		elapsed_seconds: 125,
		error: null,
		...options,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(mocks.flow, {
		bridgeState: undefined,
		bridgeError: null,
		bridgeIsError: false,
		bridgeUnavailable: false,
		bridgeLoading: false,
		exeChoices: null,
		localeEmulator: false,
		forceExeSelection: false,
		isBridgeBusy: false,
	});
});

describe("LaunchModal Web UI", () => {
	it("absent/incomplete/download/running 狀態使用對應文案與資訊", () => {
		setState("absent");
		const { rerender } = render(<LaunchModal game={game} />);
		expect(screen.getByRole("button", { name: "下载到本机" })).toBeTruthy();

		setState("incomplete", { error: "network interrupted" });
		rerender(<LaunchModal game={game} />);
		expect(screen.getByRole("button", { name: "继续下载" })).toBeTruthy();
		expect(screen.getByText("network interrupted")).toBeTruthy();

		setState("downloading");
		rerender(<LaunchModal game={game} />);
		expect(screen.getByText(/512 B \/ 1.0 KB/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "取消下载" })).toBeTruthy();

		setState("running");
		rerender(<LaunchModal game={game} />);
		expect(screen.getByRole("button", { name: "运行中 2:05" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "运行中 2:05" }));
		expect(mocks.stopGame).not.toHaveBeenCalled();
	});

	it("ready/no exe 提供选择，ready/exe 提供启动，Locale Emulator 只在 capability 为 true 时显示", () => {
		setState("ready");
		const { rerender } = render(<LaunchModal game={game} />);
		expect(screen.getByRole("button", { name: "选择可执行文件" })).toBeTruthy();
		expect(screen.queryByLabelText("使用 Locale Emulator")).toBeNull();

		setState("ready", { capabilities: { locale_emulator: true } });
		mocks.flow.exeChoices = ["bin/game.exe"];
		rerender(<LaunchModal game={game} />);
		const select = screen.getByRole("combobox", { name: "选择可执行文件" });
		fireEvent.change(select, { target: { value: "bin/game.exe" } });
		expect(mocks.flow.selectBridgeExe).toHaveBeenCalledWith(
			game,
			"bin/game.exe",
		);
		expect(screen.getByLabelText("使用 Locale Emulator")).toBeTruthy();

		mocks.flow.exeChoices = null;
		rerender(<LaunchModal game={{ ...game, exe_relpath: "bin/game.exe" }} />);
		expect(screen.getByRole("button", { name: "启动游戏" })).toBeTruthy();
	});

	it("無 bridge 或無 teledrive_path 時顯示停用原因，不顯示 absent/下載", () => {
		mocks.flow.bridgeUnavailable = true;
		mocks.flow.bridgeIsError = true;
		const { rerender } = render(<LaunchModal game={game} />);
		expect(
			screen
				.getByRole("button", { name: /本机 bridge 不可用/ })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(screen.queryByRole("button", { name: "下载到本机" })).toBeNull();

		mocks.flow.bridgeUnavailable = false;
		mocks.flow.bridgeIsError = false;
		rerender(<LaunchModal game={{ ...game, teledrive_path: undefined }} />);
		expect(
			screen
				.getByRole("button", { name: /未配置 TeleDrive 游戏路径/ })
				.hasAttribute("disabled"),
		).toBe(true);
	});
});
