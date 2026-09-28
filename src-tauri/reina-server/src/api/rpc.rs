//! `POST /game/api/rpc/{command}`：对应原本的 Tauri command。

pub mod args;
pub mod commands;
pub mod handler;
pub mod read;
pub mod write;

pub use handler::call;
