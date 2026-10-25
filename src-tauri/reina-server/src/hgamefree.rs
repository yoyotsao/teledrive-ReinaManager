//! HGameFree 下载站文章的本机索引。
//!
//! 站台每个请求都要 4～5 秒，所以把每篇文章的标题、封面网址和下载压缩包文件名
//! 同步到一张 SQLite 表，搜索直接查本机。这是全站共用的数据，不属于任何使用者。

pub mod index;
pub mod parse;
pub mod sync;
