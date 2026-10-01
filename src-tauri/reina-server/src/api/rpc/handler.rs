//! `POST /game/api/rpc/{command}`。

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use serde_json::{Value, json};

use super::commands::{Command, WriteCommand};
use super::{read, write};
use crate::api::auth::AuthUser;
use crate::app::AppState;
use crate::error::ApiError;
use crate::stores::UserStore;
use crate::tx;

pub async fn call(
    State(state): State<AppState>,
    user: AuthUser,
    Path(name): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let command = Command::parse(&name)
        .ok_or_else(|| ApiError::not_found(format!("不支持的指令: {name}")))?;
    let args = parse_body(&body)?;
    let value = match command {
        Command::Read(command) => read::dispatch_read(user.store.db(), command, args).await?,
        Command::Write(command) => run_write(&state, &user.store, command, args).await?,
    };
    Ok(Json(value))
}

/// 空 body 视为 `{}`（对应前端不带参数的 invoke）；其余必须是 JSON 对象
fn parse_body(body: &Bytes) -> Result<Value, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_slice(body)
        .map_err(|error| ApiError::bad_request(format!("请求内容不是合法 JSON: {error}")))?;
    if !value.is_object() {
        return Err(ApiError::bad_request("参数必须是 JSON 对象"));
    }
    Ok(value)
}

async fn run_write(
    state: &AppState,
    user_store: &UserStore,
    command: WriteCommand,
    args: Value,
) -> Result<Value, ApiError> {
    let deleted_ids = deleted_game_ids(&command, &args);
    let txn = tx::begin(user_store.db()).await?;
    let result = write::dispatch_write(&txn, command, args).await;
    let value = tx::finish(state, txn, result, |_| true).await?;
    // commit 已成功才清理封面文件；清理失败只记录警告，不影响已完成的删除
    if !deleted_ids.is_empty() {
        let store = crate::api::covers::handlers::cover_store(user_store);
        for id in deleted_ids {
            // 与进行中的封面更换串行，避免对方写档后被整个目录删掉之外的交错
            let _guard = store.lock_game(id).await;
            store.remove_game(id).await;
        }
    }
    Ok(value)
}

/// 从参数取出将被删除的游戏 ID；参数不合法时返回空，交给 dispatch_write 回报 400
fn deleted_game_ids(command: &WriteCommand, args: &Value) -> Vec<i32> {
    let as_id = |value: &Value| value.as_i64().and_then(|id| i32::try_from(id).ok());
    match command {
        WriteCommand::DeleteGame => args.get("id").and_then(as_id).into_iter().collect(),
        WriteCommand::DeleteGamesBatch => args
            .get("ids")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(as_id).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}
