//! GET /v1/fees?chain= — три рівні комісії мережі (F3.2–F3.4).
//!
//! Реальні дані: `eth_feeHistory` (EVM), `getRecentPrioritizationFees`
//! (Solana), `/v1/fees/recommended` mempool.space (Bitcoin) — через
//! `ChainAdapter::estimate_fees`.

use axum::{
    extract::{Query, State},
    Json,
};
use std::sync::Arc;
use std::time::Duration;

use chain_adapters::ChainId;

use crate::dto::{FeeEstimateQuery, FeeEstimateResponse};
use crate::handlers::{now_secs, ApiError};
use crate::state::AppState;

const FEES_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn fees(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FeeEstimateQuery>,
) -> Result<Json<FeeEstimateResponse>, ApiError> {
    let chain: ChainId = q
        .chain
        .parse()
        .map_err(|_| ApiError::bad_request(format!("невідома мережа: {}", q.chain)))?;

    let adapter = state.adapter(chain);
    let estimate = tokio::time::timeout(FEES_TIMEOUT, adapter.estimate_fees())
        .await
        .map_err(|_| {
            ApiError::bad_gateway(format!(
                "{chain}: таймаут оцінки комісій ({} с)",
                FEES_TIMEOUT.as_secs()
            ))
        })??;

    Ok(Json(FeeEstimateResponse {
        chain: chain.to_string(),
        estimate,
        updated_at: now_secs(),
    }))
}
