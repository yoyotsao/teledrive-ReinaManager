//! `/game/api` 底下的所有端点。

pub mod auth;
pub mod covers;
pub mod metadata;
pub mod router;
pub mod rpc;
pub mod scan;
pub mod sessions;
pub mod version;

pub use router::routes;
