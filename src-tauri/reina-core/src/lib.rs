//! ReinaManager 的共用数据层：entity、DTO、repository 与纯验证函数。
//!
//! 本 crate 不得依赖 Tauri、AppHandle 或任何桌面插件，让桌面版与 Linux 服务器共用。

pub mod database;
pub mod entity;
pub mod validation;
