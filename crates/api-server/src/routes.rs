//! Роутер `/v1` + мідлвари (CORS, trace).

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::handlers;
use crate::state::AppState;

/// Збирає повний роутер застосунку. Використовується і в main, і в тестах.
pub fn build_router(state: Arc<AppState>) -> Router {
    // TODO: CORS allowlist — тільки extension origin (ТЗ розділ 6, п.6),
    // з state.config.allowed_origins. Для розробки — permissive.
    let cors = CorsLayer::permissive();

    // TODO: rate limiting (tower_governor / Redis-лічильники, ТЗ розділ 6, п.6).
    // TODO: аутентифікація — анонімна сесія через підпис повідомлення адресою
    // (SIWE-подібно, ТЗ розділ 5).

    let v1 = Router::new()
        .route("/balances", post(handlers::balances::balances))
        .route("/history", get(handlers::history::history))
        .route("/fees", get(handlers::fees::fees))
        .route("/tx/decode", post(handlers::tx::decode))
        .route("/tx/simulate", post(handlers::tx::simulate))
        .route("/tx/risk", post(handlers::tx::risk))
        .route("/tx/explain", post(handlers::tx::explain))
        .route("/tx/broadcast", post(handlers::tx::broadcast))
        .route("/chat", post(handlers::chat::chat))
        .route("/analytics/fees", get(handlers::analytics::fees))
        .route("/analytics/summary", get(handlers::analytics::summary))
        .route("/prices", get(handlers::prices::prices))
        .route("/health", get(handlers::health::health));

    Router::new()
        .nest("/v1", v1)
        // Дублюємо health на корені для простих LB-проб.
        .route("/health", get(handlers::health::health))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}
