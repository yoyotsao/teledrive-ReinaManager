//! 以使用者自己的 TeleDrive JWT 讀取列表。
//! `/folders` 一次回傳，`/files` 以 page_size=10000 分頁直到讀完。

use serde::Deserialize;

use crate::api::scan::naming::ListingRow;

/// 與 bridge `tdapi.PAGE_SIZE` 相同。
pub const PAGE_SIZE: usize = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum TeleDriveError {
    #[error("teledrive rejected the token")]
    Unauthorized,
    #[error("teledrive unavailable: {0}")]
    Unavailable(String),
}

#[derive(Deserialize)]
struct ListResponse {
    #[serde(default)]
    files: Vec<ListingRow>,
    #[serde(default)]
    total: usize,
}

pub struct TeleDriveClient {
    http: reqwest::Client,
    base: url::Url,
    token: String,
}

impl TeleDriveClient {
    pub fn new(http: reqwest::Client, base: url::Url, token: String) -> Self {
        Self { http, base, token }
    }

    async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<ListResponse, TeleDriveError> {
        let url = self
            .base
            .join(path)
            .map_err(|error| TeleDriveError::Unavailable(error.to_string()))?;
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .query(query)
            .send()
            .await
            .map_err(|error| TeleDriveError::Unavailable(error.to_string()))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TeleDriveError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(TeleDriveError::Unavailable(format!(
                "HTTP {}",
                response.status()
            )));
        }
        response
            .json()
            .await
            .map_err(|error| TeleDriveError::Unavailable(error.to_string()))
    }

    /// 根目錄下名稱完全相同的資料夾；重複時取最新。
    pub async fn find_game_folder(&self, name: &str) -> Result<Option<String>, TeleDriveError> {
        let root = self.get("/api/v1/folders", &[]).await?;
        Ok(root
            .files
            .into_iter()
            .filter(|row| row.is_dir && row.filename == name)
            .max_by(|a, b| a.created_at.cmp(&b.created_at))
            .map(|row| row.file_id))
    }

    pub async fn list_children(&self, parent_id: &str) -> Result<Vec<ListingRow>, TeleDriveError> {
        let mut rows = self
            .get("/api/v1/folders", &[("parent_id", parent_id.to_string())])
            .await?
            .files;

        let mut page = 1usize;
        let mut files = Vec::new();
        loop {
            let batch = self
                .get(
                    "/api/v1/files",
                    &[
                        ("parent_id", parent_id.to_string()),
                        ("page", page.to_string()),
                        ("page_size", PAGE_SIZE.to_string()),
                    ],
                )
                .await?;
            let count = batch.files.len();
            files.extend(batch.files);
            if count < PAGE_SIZE || files.len() >= batch.total {
                break;
            }
            page += 1;
        }
        rows.extend(files);
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use std::collections::HashMap;

    async fn spawn(router: Router) -> url::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        url::Url::parse(&format!("http://{addr}")).unwrap()
    }

    fn auth_ok(headers: &HeaderMap) -> bool {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            == Some("Bearer tok")
    }

    #[tokio::test]
    async fn 讀完所有分頁並帶上使用者的_token() {
        let base = spawn(
            Router::new()
                .route(
                    "/api/v1/folders",
                    get(
                        |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| async move {
                            if !auth_ok(&headers) {
                                return Err(StatusCode::UNAUTHORIZED);
                            }
                            let files = if query.get("parent_id").is_none() {
                                json!([{
                                    "file_id": "g",
                                    "filename": "game",
                                    "isDir": true,
                                    "created_at": "2026-01-01T00:00:00"
                                }])
                            } else {
                                json!([{
                                    "file_id": "d1",
                                    "filename": "Foo",
                                    "isDir": true,
                                    "created_at": "2026-01-01T00:00:00"
                                }])
                            };
                            Ok(Json(json!({
                                "files": files,
                                "total": 1,
                                "page": 1,
                                "page_size": 1
                            })))
                        },
                    ),
                )
                .route(
                    "/api/v1/files",
                    get(
                        |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| async move {
                            if !auth_ok(&headers) {
                                return Err(StatusCode::UNAUTHORIZED);
                            }
                            assert_eq!(query["parent_id"], "g");
                            assert_eq!(query["page_size"], "10000");
                            let page: u32 = query["page"].parse().unwrap();
                            let batch: Vec<_> = if page == 1 {
                                (0..10000)
                                    .map(|index| {
                                        json!({
                                            "file_id": format!("f{index}"),
                                            "filename": format!("g{index}.zip"),
                                            "isDir": false,
                                            "created_at": "2026-01-01T00:00:00"
                                        })
                                    })
                                    .collect()
                            } else {
                                vec![json!({
                                    "file_id": "last",
                                    "filename": "Last.zip",
                                    "isDir": false,
                                    "created_at": "2026-01-01T00:00:00"
                                })]
                            };
                            Ok(Json(json!({
                                "files": batch,
                                "total": 10001,
                                "page": page,
                                "page_size": 10000
                            })))
                        },
                    ),
                ),
        )
        .await;

        let client = TeleDriveClient::new(reqwest::Client::new(), base, "tok".into());
        let game = client.find_game_folder("game").await.unwrap().unwrap();
        assert_eq!(game, "g");
        let rows = client.list_children(&game).await.unwrap();
        assert_eq!(rows.len(), 1 + 10001);
        assert!(rows.iter().any(|row| row.filename == "Last.zip"));
    }

    #[tokio::test]
    async fn token_失效回傳_unauthorized_找不到資料夾回傳_none() {
        let base = spawn(Router::new().route(
            "/api/v1/folders",
            get(|headers: HeaderMap| async move {
                if !auth_ok(&headers) {
                    return Err(StatusCode::UNAUTHORIZED);
                }
                Ok(Json(json!({
                    "files": [],
                    "total": 0,
                    "page": 1,
                    "page_size": 0
                })))
            }),
        ))
        .await;
        let bad = TeleDriveClient::new(reqwest::Client::new(), base.clone(), "wrong".into());
        assert!(matches!(
            bad.find_game_folder("game").await,
            Err(TeleDriveError::Unauthorized)
        ));
        let good = TeleDriveClient::new(reqwest::Client::new(), base, "tok".into());
        assert!(good.find_game_folder("game").await.unwrap().is_none());
    }
}
