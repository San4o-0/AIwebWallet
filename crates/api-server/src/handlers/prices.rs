//! GET /v1/prices — ціни (F2.5). МОК.

use axum::{
    extract::{Query, State},
    Json,
};
use std::collections::HashMap;
use std::sync::Arc;

use crate::dto::{PriceInfo, PricesQuery, PricesResponse};
use crate::handlers::now_secs;
use crate::state::AppState;

pub async fn prices(
    State(_state): State<Arc<AppState>>,
    Query(q): Query<PricesQuery>,
) -> Json<PricesResponse> {
    // TODO: balance-service — CoinGecko /simple/price з кешем у Redis
    // (TTL ~60 с), rate limit до CoinGecko, fallback на застарілий кеш.
    let known: HashMap<&str, PriceInfo> = HashMap::from([
        ("ethereum", PriceInfo { usd: 3500.00, usd_24h_change: 2.4 }),
        ("solana", PriceInfo { usd: 170.00, usd_24h_change: -1.1 }),
        ("bitcoin", PriceInfo { usd: 97_500.00, usd_24h_change: 0.8 }),
        ("usd-coin", PriceInfo { usd: 1.00, usd_24h_change: 0.0 }),
        ("matic-network", PriceInfo { usd: 0.52, usd_24h_change: -0.6 }),
    ]);

    let prices = q
        .ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter_map(|id| known.get(id).map(|p| (id.to_string(), p.clone())))
        .collect();

    Json(PricesResponse {
        prices,
        updated_at: now_secs(),
    })
}
