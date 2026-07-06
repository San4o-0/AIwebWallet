//! GET /v1/history — історія транзакцій з людськими описами (F3.6, F4.4). МОК.

use axum::{
    extract::{Query, State},
    Json,
};
use std::sync::Arc;

use crate::dto::{HistoryItem, HistoryQuery, HistoryResponse, TxCategory};
use crate::handlers::now_secs;
use crate::state::AppState;

pub async fn history(
    State(_state): State<Arc<AppState>>,
    Query(q): Query<HistoryQuery>,
) -> Json<HistoryResponse> {
    // TODO: indexer — вибірка з PostgreSQL за (address, chain) з
    // cursor-пагінацією; збагачення через Helius (Solana) / Alchemy (EVM);
    // категоризація (F6.2) і людські описи через ai-service (F4.4).
    let now = now_secs();
    let chain = q.chain.unwrap_or_else(|| "ethereum".to_string());

    let items = vec![
        HistoryItem {
            tx_hash: "0x8f3b1c9e42a7d5f6b0a1e2c3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3".into(),
            chain: chain.clone(),
            timestamp: now - 3600,
            category: TxCategory::Transfer,
            description: "Отримано 150 USDC від 0xab58…ec9b".into(),
            direction: "in".into(),
            amount: "150".into(),
            symbol: "USDC".into(),
            counterparty: Some("0xab5801a7d398351b8be11c439e05c5b3259aec9b".into()),
            fee_usd: 0.0,
            status: "confirmed".into(),
        },
        HistoryItem {
            tx_hash: "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b".into(),
            chain: chain.clone(),
            timestamp: now - 86_400,
            category: TxCategory::Approve,
            description: "Надано Uniswap Router дозвіл витрачати до 500 USDC".into(),
            direction: "out".into(),
            amount: "0".into(),
            symbol: "USDC".into(),
            counterparty: Some("0x66a9893cc07d91d95644aedd05d03f95e1dba8af".into()),
            fee_usd: 1.42,
            status: "confirmed".into(),
        },
        HistoryItem {
            tx_hash: "0x9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d".into(),
            chain,
            timestamp: now - 2 * 86_400,
            category: TxCategory::Swap,
            description: "Обмін 0.2 ETH на 698.4 USDC через Uniswap".into(),
            direction: "self".into(),
            amount: "0.2".into(),
            symbol: "ETH".into(),
            counterparty: Some("0x66a9893cc07d91d95644aedd05d03f95e1dba8af".into()),
            fee_usd: 3.87,
            status: "confirmed".into(),
        },
    ];

    Json(HistoryResponse {
        items,
        // TODO: реальний cursor з indexer.
        next_cursor: None,
    })
}
