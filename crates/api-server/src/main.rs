//! AI Wallet API-сервер — точка входу.

use std::sync::Arc;

use tokio::signal;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use api_server::config::Config;
use api_server::routes::build_router;
use api_server::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Логування: RUST_LOG=api_server=debug,tower_http=debug
    // TODO: OpenTelemetry-експортер + Prometheus-метрики (ТЗ 4.2).
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("api_server=info,tower_http=info")),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env();
    let port = config.port;

    if config.database_url.is_none() {
        info!("DATABASE_URL не задано — Postgres вимкнено (TODO: sqlx pool)");
    }
    if config.redis_url.is_none() {
        info!("REDIS_URL не задано — Redis вимкнено (TODO: fred pool)");
    }

    let state: Arc<AppState> = AppState::new(config);
    let app = build_router(state);

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("api-server слухає на http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("api-server зупинено");
    Ok(())
}

/// Graceful shutdown: Ctrl+C або SIGTERM (Docker/K8s).
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("не вдалося встановити обробник Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("не вдалося встановити обробник SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => info!("отримано Ctrl+C — завершуємось"),
        _ = terminate => info!("отримано SIGTERM — завершуємось"),
    }
}
