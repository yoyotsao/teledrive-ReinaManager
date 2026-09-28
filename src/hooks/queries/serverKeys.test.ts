import { describe, expect, it } from "vitest";
import { SERVER_QUERY_ROOT, serverKey } from "./serverKeys";
import { collectionKeys } from "./useCollections";
import { gameKeys } from "./useGames";
import { playStatusKeys } from "./usePlayStatus";
import { saveDataKeys } from "./useSavedata";
import { settingsKeys } from "./useSettings";
import { statsKeys } from "./useStats";
import { taskKeys } from "./useTasks";

describe("伺服器 query key", () => {
	it("serverKey 在前面加上 server", () => {
		expect(serverKey("games", 1)).toEqual(["server", "games", 1]);
		expect(SERVER_QUERY_ROOT).toEqual(["server"]);
	});

	it("所有资料库来源的 key 都以 server 开头", () => {
		const keys = [
			gameKeys.all,
			gameKeys.index(),
			gameKeys.idLists(),
			gameKeys.bgmIds(),
			collectionKeys.all,
			collectionKeys.games(3),
			statsKeys.all,
			statsKeys.gameStats(3),
			settingsKeys.all,
			settingsKeys.allSettings(),
			playStatusKeys.all,
			playStatusKeys.game(3),
			saveDataKeys.all,
			saveDataKeys.backups(3),
			saveDataKeys.backupCount(3),
		];
		for (const key of keys) {
			expect(key[0]).toBe("server");
		}
	});

	it("桌面安装任务不属于服务器资料", () => {
		expect(taskKeys.all[0]).toBe("tasks");
	});
});
