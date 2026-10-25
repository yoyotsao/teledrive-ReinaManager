//! 网页版开放的 command 白名单与读写分类。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Read,
    Write,
}

/// 只读取数据的 command：不开 transaction，不递增 data_version
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadCommand {
    FindGameById,
    FindAllGames,
    FindGameIds,
    CountGames,
    GetSourceBindings,
    GetGameSessions,
    GetRecentSessionsForAll,
    GetGameStatistics,
    GetAllGameStatistics,
    GetAllGameLastPlayed,
    GetStatisticsDistribution,
    GetAllSettings,
    FindRootCollections,
    GetRootCollectionsWithCount,
    GetGamesInCollection,
    GetGameCollectionIds,
    CountGamesInGroup,
    GetCategoriesWithCount,
}

/// 会修改数据的 command：在 transaction 里执行，成功才递增 data_version
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteCommand {
    InsertGame,
    InsertGamesBatch,
    UpdateGame,
    UpdateGamesBatch,
    DeleteGame,
    DeleteGamesBatch,
    CreateManualGameSession,
    DeleteGameSession,
    UpdateSettings,
    CreateCollection,
    UpdateCollection,
    DeleteCollection,
    RemoveGamesFromCollection,
    AddGamesToCollections,
    SetGameCollections,
    UpdateCategoryGames,
}

/// 读写性质由所属的 enum 决定：新增 command 时必须选一个 enum，
/// 而 `name()` 与分派函数都是没有万用分支的 match，漏写就无法编译。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Read(ReadCommand),
    Write(WriteCommand),
}

impl ReadCommand {
    pub const ALL: [ReadCommand; 18] = [
        Self::FindGameById,
        Self::FindAllGames,
        Self::FindGameIds,
        Self::CountGames,
        Self::GetSourceBindings,
        Self::GetGameSessions,
        Self::GetRecentSessionsForAll,
        Self::GetGameStatistics,
        Self::GetAllGameStatistics,
        Self::GetAllGameLastPlayed,
        Self::GetStatisticsDistribution,
        Self::GetAllSettings,
        Self::FindRootCollections,
        Self::GetRootCollectionsWithCount,
        Self::GetGamesInCollection,
        Self::GetGameCollectionIds,
        Self::CountGamesInGroup,
        Self::GetCategoriesWithCount,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::FindGameById => "find_game_by_id",
            Self::FindAllGames => "find_all_games",
            Self::FindGameIds => "find_game_ids",
            Self::CountGames => "count_games",
            Self::GetSourceBindings => "get_source_bindings",
            Self::GetGameSessions => "get_game_sessions",
            Self::GetRecentSessionsForAll => "get_recent_sessions_for_all",
            Self::GetGameStatistics => "get_game_statistics",
            Self::GetAllGameStatistics => "get_all_game_statistics",
            Self::GetAllGameLastPlayed => "get_all_game_last_played",
            Self::GetStatisticsDistribution => "get_statistics_distribution",
            Self::GetAllSettings => "get_all_settings",
            Self::FindRootCollections => "find_root_collections",
            Self::GetRootCollectionsWithCount => "get_root_collections_with_count",
            Self::GetGamesInCollection => "get_games_in_collection",
            Self::GetGameCollectionIds => "get_game_collection_ids",
            Self::CountGamesInGroup => "count_games_in_group",
            Self::GetCategoriesWithCount => "get_categories_with_count",
        }
    }
}

impl WriteCommand {
    pub const ALL: [WriteCommand; 16] = [
        Self::InsertGame,
        Self::InsertGamesBatch,
        Self::UpdateGame,
        Self::UpdateGamesBatch,
        Self::DeleteGame,
        Self::DeleteGamesBatch,
        Self::CreateManualGameSession,
        Self::DeleteGameSession,
        Self::UpdateSettings,
        Self::CreateCollection,
        Self::UpdateCollection,
        Self::DeleteCollection,
        Self::RemoveGamesFromCollection,
        Self::AddGamesToCollections,
        Self::SetGameCollections,
        Self::UpdateCategoryGames,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::InsertGame => "insert_game",
            Self::InsertGamesBatch => "insert_games_batch",
            Self::UpdateGame => "update_game",
            Self::UpdateGamesBatch => "update_games_batch",
            Self::DeleteGame => "delete_game",
            Self::DeleteGamesBatch => "delete_games_batch",
            Self::CreateManualGameSession => "create_manual_game_session",
            Self::DeleteGameSession => "delete_game_session",
            Self::UpdateSettings => "update_settings",
            Self::CreateCollection => "create_collection",
            Self::UpdateCollection => "update_collection",
            Self::DeleteCollection => "delete_collection",
            Self::RemoveGamesFromCollection => "remove_games_from_collection",
            Self::AddGamesToCollections => "add_games_to_collections",
            Self::SetGameCollections => "set_game_collections",
            Self::UpdateCategoryGames => "update_category_games",
        }
    }
}

impl Command {
    pub fn parse(name: &str) -> Option<Self> {
        ReadCommand::ALL
            .into_iter()
            .find(|command| command.name() == name)
            .map(Self::Read)
            .or_else(|| {
                WriteCommand::ALL
                    .into_iter()
                    .find(|command| command.name() == name)
                    .map(Self::Write)
            })
    }

    pub fn kind(self) -> CommandKind {
        match self {
            Self::Read(_) => CommandKind::Read,
            Self::Write(_) => CommandKind::Write,
        }
    }
}

pub fn command_kind(name: &str) -> Option<CommandKind> {
    Command::parse(name).map(Command::kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn 每个名称都能解析回同一个_command() {
        for command in ReadCommand::ALL {
            assert_eq!(Command::parse(command.name()), Some(Command::Read(command)));
        }
        for command in WriteCommand::ALL {
            assert_eq!(
                Command::parse(command.name()),
                Some(Command::Write(command))
            );
        }
    }

    #[test]
    fn 名称不重复而且数量正确() {
        let names: HashSet<&str> = ReadCommand::ALL
            .iter()
            .map(|c| c.name())
            .chain(WriteCommand::ALL.iter().map(|c| c.name()))
            .collect();
        assert_eq!(ReadCommand::ALL.len(), 18);
        assert_eq!(WriteCommand::ALL.len(), 16);
        assert_eq!(names.len(), 34);
    }

    #[test]
    fn 读取与写入分类正确() {
        assert_eq!(command_kind("find_all_games"), Some(CommandKind::Read));
        assert_eq!(command_kind("find_game_by_id"), Some(CommandKind::Read));
        assert_eq!(command_kind("get_all_settings"), Some(CommandKind::Read));
        assert_eq!(command_kind("insert_game"), Some(CommandKind::Write));
        assert_eq!(command_kind("update_settings"), Some(CommandKind::Write));
        assert_eq!(
            command_kind("delete_game_session"),
            Some(CommandKind::Write)
        );
    }

    #[test]
    fn 桌面专属_command_不开放() {
        let desktop_only = [
            "launch_game",
            "stop_game",
            "open_directory",
            "resolve_dropped_local_path",
            "resolve_bulk_import_paths",
            "is_portable_mode",
            "scan_directory_for_games",
            "scan_steam_launch_targets",
            "resolve_steam_shortcut_file",
            "take_pending_install_requests",
            "take_pending_install_rejections",
            "create_game_install_task",
            "list_tasks",
            "retry_task",
            "pause_task",
            "resume_task",
            "cancel_task",
            "delete_task",
            "complete_game_install_task",
            "fail_game_install_metadata",
            "move_backup_folder",
            "copy_file",
            "create_savedata_backup",
            "delete_savedata_backup",
            "restore_savedata_backup",
            "delete_file",
            "import_clipboard_image_to_temp",
            "delete_game_covers",
            "delete_cloud_cache",
            "backup_database",
            "backup_custom_covers",
            "import_database",
            "save_savedata_record",
            "get_savedata_count",
            "get_savedata_records",
            "rebuild_game_statistics",
            "update_proxy_config",
            "bgm_oauth_start_login",
            "bgm_oauth_cancel_login",
            "bgm_oauth_exchange_code",
            "bgm_oauth_refresh_token",
            "hikarinagi_oauth_start_login",
            "hikarinagi_oauth_cancel_login",
            "hikarinagi_oauth_exchange_code",
            "hikarinagi_oauth_refresh_token",
            "set_reina_log_level",
            "get_reina_log_level",
            "restart_app",
        ];
        for name in desktop_only {
            assert_eq!(command_kind(name), None, "{name} 不能开放给网页版");
        }
        assert_eq!(command_kind(""), None);
        assert_eq!(command_kind("FIND_ALL_GAMES"), None);
    }

    /// 分类表完整性：每个已注册的 command 都必须恰好属于 Read 或 Write 其中之一，
    /// 不能遗漏（`command_kind` 回传 None）也不能重复注册；不需要为每个 command 构造参数。
    #[test]
    fn 每个已注册的_command_恰好属于_read_或_write_其中之一() {
        let mut seen = HashSet::new();
        let mut read_count = 0;
        let mut write_count = 0;

        let all_names = ReadCommand::ALL
            .iter()
            .map(|command| command.name())
            .chain(WriteCommand::ALL.iter().map(|command| command.name()));

        for name in all_names {
            assert!(seen.insert(name), "{name} 被重复注册");
            match command_kind(name) {
                Some(CommandKind::Read) => read_count += 1,
                Some(CommandKind::Write) => write_count += 1,
                None => panic!("{name} 未能分类为 Read 或 Write 其中之一"),
            }
        }

        assert_eq!(read_count, ReadCommand::ALL.len());
        assert_eq!(write_count, WriteCommand::ALL.len());
        assert_eq!(seen.len(), ReadCommand::ALL.len() + WriteCommand::ALL.len());
    }
}
