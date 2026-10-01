//! reina-server 启动程序。设定全部来自环境变量（见 `Config::from_lookup`）。

use std::net::SocketAddr;

use reina_server::hgamefree::sync::spawn_background;
use reina_server::{AppState, Config, build_router};

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    if let Err(error) = run().await {
        // 不输出设定内容，避免密钥出现在日志
        log::error!("reina-server 启动失败: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    tokio::fs::create_dir_all(&config.data_dir).await?;

    let address = SocketAddr::from(([0, 0, 0, 0], config.port));
    log::info!(
        "reina-server 监听 {address}，数据目录 {}，静态文件 {}",
        config.data_dir.display(),
        config.static_dir.display()
    );

    let listener = tokio::net::TcpListener::bind(address).await?;
    let state = AppState::new(config);
    // 只在正式启动时同步；测试直接用 AppState::new，不会连外部站台
    spawn_background(state.hgamefree.clone(), state.config.clone());
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Docker 停止容器时送 SIGTERM；本机开发按 Ctrl+C
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
