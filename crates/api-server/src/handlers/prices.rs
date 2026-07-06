//! GET /v1/prices — реальні ціни CoinGecko з кешем (F2.5).
//!
//! Кеш — in-memory, TTL 60 с (див. `crate::pricing`); при недоступності
//! CoinGecko повертається застарілий кеш (fail-safe, ТЗ §1.2).
//! TODO(redis): спільний кеш між репліками.

use axum::{
    extract::{Query, State},
    Json,
};
use std::sync::Arc;

use crate::dto::{PricesQuery, PricesResponse};
use crate::handlers::ApiError;
use crate::state::AppState;

/// Захист від зловживання: скільки id можна запитати за раз.
const MAX_IDS: usize = 50;

pub async fn prices(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PricesQuery>,
) -> Result<Json<PricesResponse>, ApiError> {
    let ids: Vec<String> = q
        .ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();

    if ids.is_empty() {
        return Err(ApiError::bad_request("параметр ids порожній"));
    }
    if ids.len() > MAX_IDS {
        return Err(ApiError::bad_request(format!(
            "занадто багато ids (максимум {MAX_IDS})"
        )));
    }

    let (prices, updated_at) = state.prices.get_prices(&ids).await;
    Ok(Json(PricesResponse { prices, updated_at }))
}
