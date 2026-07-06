//! GET /v1/analytics/* — аналітика витрат (F6.1, F6.2). МОК.

use axum::{
    extract::{Query, State},
    Json,
};
use std::sync::Arc;

use crate::dto::{
    AnalyticsQuery, CategorySummary, ChainFees, FeePoint, FeesResponse, SummaryResponse,
    TxCategory,
};
use crate::handlers::now_secs;
use crate::state::AppState;

const DAY: u64 = 86_400;

pub async fn fees(
    State(_state): State<Arc<AppState>>,
    Query(q): Query<AnalyticsQuery>,
) -> Json<FeesResponse> {
    // TODO: indexer — агрегація SUM(fee_usd) з PostgreSQL за період,
    // GROUP BY chain / day; кеш агрегатів у Redis.
    let period = q.period.unwrap_or_else(|| "30d".to_string());
    let now = now_secs();

    Json(FeesResponse {
        address: q.address,
        period,
        total_fees_usd: 12.47,
        by_chain: vec![
            ChainFees { chain: "ethereum".into(), fees_usd: 9.80, tx_count: 8 },
            ChainFees { chain: "polygon".into(), fees_usd: 1.12, tx_count: 9 },
            ChainFees { chain: "solana".into(), fees_usd: 1.55, tx_count: 6 },
        ],
        timeline: vec![
            FeePoint { date: now - 6 * DAY, fees_usd: 0.42 },
            FeePoint { date: now - 5 * DAY, fees_usd: 0.0 },
            FeePoint { date: now - 4 * DAY, fees_usd: 2.15 },
            FeePoint { date: now - 3 * DAY, fees_usd: 3.87 },
            FeePoint { date: now - 2 * DAY, fees_usd: 0.98 },
            FeePoint { date: now - DAY, fees_usd: 1.20 },
            FeePoint { date: now, fees_usd: 0.31 },
        ],
    })
}

pub async fn summary(
    State(_state): State<Arc<AppState>>,
    Query(q): Query<AnalyticsQuery>,
) -> Json<SummaryResponse> {
    // TODO: indexer — дашборд: обсяги in/out, розподіл по мережах і
    // категоріях (F6.1, F6.2) з PostgreSQL.
    let period = q.period.unwrap_or_else(|| "30d".to_string());

    Json(SummaryResponse {
        address: q.address,
        period,
        total_in_usd: 2350.00,
        total_out_usd: 1875.40,
        total_fees_usd: 12.47,
        tx_count: 23,
        by_category: vec![
            CategorySummary { category: TxCategory::Transfer, tx_count: 12, volume_usd: 2980.0 },
            CategorySummary { category: TxCategory::Swap, tx_count: 5, volume_usd: 1120.0 },
            CategorySummary { category: TxCategory::Approve, tx_count: 4, volume_usd: 0.0 },
            CategorySummary { category: TxCategory::DappInteraction, tx_count: 2, volume_usd: 125.4 },
        ],
        by_chain: vec![
            ChainFees { chain: "ethereum".into(), fees_usd: 9.80, tx_count: 8 },
            ChainFees { chain: "polygon".into(), fees_usd: 1.12, tx_count: 9 },
            ChainFees { chain: "solana".into(), fees_usd: 1.55, tx_count: 6 },
        ],
    })
}
