//! ReinaManager 网页版服务器：提供 `/game/` 前端与 `/game/api/*`。

pub mod api;
pub mod app;
pub mod config;
pub mod error;
pub mod hgamefree;
pub mod static_files;
pub mod stores;
pub mod tx;
pub mod upstream;

pub use app::{AppState, build_router};
pub use config::Config;
