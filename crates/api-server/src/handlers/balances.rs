//! POST /v1/balances — агрегований портфель (F2.1–F2.5). МОК.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::dto::{
    AddressBook, BalancesRequest, BalancesResponse, ChainBalance, TokenBalance,
};
use crate::handlers::now_secs;
use crate::state::AppState;

pub async fn balances(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<BalancesRequest>,
) -> Json<BalancesResponse> {
    // TODO: balance-service — RPC-запити балансів (Alloy для EVM,
    // solana-client, mempool.space для BTC), автовиявлення токенів через
    // індексер, ціни з CoinGecko з кешем у Redis (F2.5).
    let AddressBook { evm, solana, bitcoin } = &req.addresses;

    let mut chains: Vec<ChainBalance> = Vec::new();

    for addr in evm {
        chains.push(ChainBalance {
            chain: "ethereum".into(),
            address: addr.clone(),
            native: TokenBalance {
                symbol: "ETH".into(),
                name: "Ether".into(),
                contract_address: None,
                amount: "1250000000000000000".into(), // 1.25 ETH
                decimals: 18,
                usd_value: 4375.0,
            },
            tokens: vec![TokenBalance {
                symbol: "USDC".into(),
                name: "USD Coin".into(),
                contract_address: Some(
                    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into(),
                ),
                amount: "532100000".into(), // 532.10 USDC
                decimals: 6,
                usd_value: 532.10,
            }],
            usd_value: 4907.10,
        });
    }
    for addr in solana {
        chains.push(ChainBalance {
            chain: "solana".into(),
            address: addr.clone(),
            native: TokenBalance {
                symbol: "SOL".into(),
                name: "Solana".into(),
                contract_address: None,
                amount: "12400000000".into(), // 12.4 SOL
                decimals: 9,
                usd_value: 2108.0,
            },
            tokens: vec![],
            usd_value: 2108.0,
        });
    }
    for addr in bitcoin {
        chains.push(ChainBalance {
            chain: "bitcoin".into(),
            address: addr.clone(),
            native: TokenBalance {
                symbol: "BTC".into(),
                name: "Bitcoin".into(),
                contract_address: None,
                amount: "2500000".into(), // 0.025 BTC (sats)
                decimals: 8,
                usd_value: 2437.50,
            },
            tokens: vec![],
            usd_value: 2437.50,
        });
    }

    let total_usd = chains.iter().map(|c| c.usd_value).sum();

    Json(BalancesResponse {
        total_usd,
        chains,
        prices_updated_at: now_secs(),
    })
}
