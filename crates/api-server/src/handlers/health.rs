//! GET /v1/health

use axum::Json;

use crate::dto::HealthResponse;

pub async fn health() -> Json<HealthResponse> {
    // TODO: перевірка доступності Postgres/Redis/RPC (readiness) —
    // окремо від liveness.
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
