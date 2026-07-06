//! GET /v1/history — історія транзакцій (F3.6, F4.4).
//!
//! Реальні дані для Bitcoin (mempool.space) і Solana (getSignaturesForAddress)
//! через chain-adapters. EVM — через індексер Etherscan API v2
//! (`crate::indexer`, потрібен ETHERSCAN_API_KEY; без ключа — порожній
//! список із полем `note`, graceful degradation).

use axum::{
    extract::{Query, State},
    Json,
};
use std::sync::Arc;
use std::time::Duration;

use chain_adapters::{Address, ChainId, TransactionRecord, TxStatus};

use crate::chains::{format_base_units, native_coingecko_id};
use crate::dto::{HistoryItem, HistoryQuery, HistoryResponse, TxCategory};
use crate::handlers::ApiError;
use crate::indexer;
use crate::state::AppState;

const HISTORY_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn history(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<HistoryResponse>, ApiError> {
    let chain: ChainId = q
        .chain
        .as_deref()
        .unwrap_or("ethereum")
        .parse()
        .map_err(|_| ApiError::bad_request(format!("невідома мережа: {:?}", q.chain)))?;

    if chain.is_evm() {
        return evm_history(&state, chain, &q).await.map(Json);
    }

    let address = Address::new(chain, q.address.clone()).map_err(ApiError::from)?;
    let adapter = state.adapter(chain);

    let (records, next_cursor) =
        tokio::time::timeout(HISTORY_TIMEOUT, adapter.get_transaction_history(&address, q.cursor))
            .await
            .map_err(|_| {
                ApiError::bad_gateway(format!(
                    "{chain}: таймаут історії ({} с)",
                    HISTORY_TIMEOUT.as_secs()
                ))
            })??;

    // Ціна нативної монети — для fee_usd (фейл цін не валить історію).
    let (prices, _) = state
        .prices
        .get_prices(&[native_coingecko_id(chain).to_string()])
        .await;
    let native_usd = prices
        .get(native_coingecko_id(chain))
        .map(|p| p.usd)
        .unwrap_or(0.0);

    let mut items: Vec<HistoryItem> = records
        .iter()
        .map(|r| record_to_item(&q.address, r, native_usd))
        .collect();
    if let Some(limit) = q.limit {
        items.truncate(limit as usize);
    }

    Ok(Json(HistoryResponse { items, next_cursor, note: None }))
}

/// EVM-історія через індексер Etherscan v2 (кеш TTL 30 с усередині).
async fn evm_history(
    state: &AppState,
    chain: ChainId,
    q: &HistoryQuery,
) -> Result<HistoryResponse, ApiError> {
    // Валідація адреси тим самим механізмом, що й для інших мереж.
    let address = Address::new(chain, q.address.clone()).map_err(ApiError::from)?;

    if !state.indexer.enabled() {
        // Graceful: без ключа не падаємо, а чесно пояснюємо (ТЗ §1.2).
        return Ok(HistoryResponse {
            items: Vec::new(),
            next_cursor: None,
            note: Some(indexer::NO_KEY_NOTE.to_string()),
        });
    }

    // Ціна нативної монети — для fee_usd (фейл цін не валить історію).
    let (prices, _) = state
        .prices
        .get_prices(&[native_coingecko_id(chain).to_string()])
        .await;
    let native_usd = prices
        .get(native_coingecko_id(chain))
        .map(|p| p.usd)
        .unwrap_or(0.0);

    let mut items = tokio::time::timeout(
        HISTORY_TIMEOUT,
        state.indexer.history(chain, address.as_str(), native_usd),
    )
    .await
    .map_err(|_| {
        ApiError::bad_gateway(format!(
            "{chain}: таймаут історії ({} с)",
            HISTORY_TIMEOUT.as_secs()
        ))
    })??;

    if let Some(limit) = q.limit {
        items.truncate(limit as usize);
    }
    Ok(HistoryResponse { items, next_cursor: None, note: None })
}

/// Маппінг adapter-запису в DTO історії з людським описом українською.
pub(crate) fn record_to_item(
    owner: &str,
    record: &TransactionRecord,
    native_usd: f64,
) -> HistoryItem {
    let chain = record.chain;
    let symbol = chain.native_symbol().to_string();
    let decimals = chain.native_decimals();

    let direction = match (record.from.as_deref(), record.to.as_deref()) {
        (Some(f), Some(t)) if f == owner && t == owner => "self",
        (_, Some(t)) if t == owner => "in",
        (Some(f), _) if f == owner => "out",
        _ => "self",
    };

    let amount = record
        .amount
        .map(|a| format_base_units(a, decimals))
        .unwrap_or_else(|| "0".to_string());

    let counterparty = match direction {
        "in" => record.from.clone().filter(|f| f != owner),
        "out" => record.to.clone().filter(|t| t != owner),
        _ => None,
    };

    let description = match (direction, record.amount, &counterparty) {
        ("in", Some(_), Some(from)) => {
            format!("Отримано {amount} {symbol} від {}", shorten(from))
        }
        ("in", Some(_), None) => format!("Отримано {amount} {symbol}"),
        ("out", Some(_), Some(to)) => {
            format!("Надіслано {amount} {symbol} до {}", shorten(to))
        }
        ("out", Some(_), None) => format!("Надіслано {amount} {symbol}"),
        // Suма невідома (Solana getSignaturesForAddress не повертає суми —
        // повний розбір потребує getTransaction / індексера Helius).
        _ => format!("Транзакція в мережі {chain}"),
    };

    let fee_usd = record
        .fee
        .map(|f| (f as f64 / 10f64.powi(decimals as i32)) * native_usd)
        .unwrap_or(0.0);

    HistoryItem {
        tx_hash: record.hash.clone(),
        chain: chain.to_string(),
        timestamp: record.timestamp.unwrap_or(0),
        // TODO(indexer): категоризація swap/approve/mint (F6.2) потребує
        // розбору логів/інструкцій — поки все "transfer".
        category: TxCategory::Transfer,
        description,
        direction: direction.to_string(),
        amount,
        symbol,
        counterparty,
        fee_usd,
        status: match record.status {
            TxStatus::Confirmed => "confirmed",
            TxStatus::Failed => "failed",
            TxStatus::Pending | TxStatus::Unknown => "pending",
        }
        .to_string(),
    }
}

/// "bc1qar0...f5mdq" — скорочення адреси для опису.
fn shorten(addr: &str) -> String {
    if addr.len() <= 13 {
        addr.to_string()
    } else {
        format!("{}…{}", &addr[..6], &addr[addr.len() - 4..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BTC_ADDR: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

    #[test]
    fn bitcoin_outgoing_record_maps_to_item() {
        let record = TransactionRecord {
            chain: ChainId::Bitcoin,
            hash: "aaa111".into(),
            from: Some(BTC_ADDR.into()),
            to: Some("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa".into()),
            amount: Some(60_141),
            token_address: None,
            fee: Some(141),
            status: TxStatus::Confirmed,
            block_height: Some(850_000),
            timestamp: Some(1_720_000_000),
        };
        let item = record_to_item(BTC_ADDR, &record, 100_000.0);
        assert_eq!(item.direction, "out");
        assert_eq!(item.amount, "0.00060141");
        assert_eq!(item.symbol, "BTC");
        assert_eq!(item.status, "confirmed");
        assert_eq!(
            item.counterparty.as_deref(),
            Some("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
        );
        assert!(item.description.starts_with("Надіслано 0.00060141 BTC до"));
        // 141 sat * 100k USD/BTC = 0.141 USD
        assert!((item.fee_usd - 0.141).abs() < 1e-9);
    }

    #[test]
    fn bitcoin_incoming_record_maps_to_item() {
        let record = TransactionRecord {
            chain: ChainId::Bitcoin,
            hash: "bbb222".into(),
            from: Some("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy".into()),
            to: Some(BTC_ADDR.into()),
            amount: Some(499_800),
            token_address: None,
            fee: Some(200),
            status: TxStatus::Pending,
            block_height: None,
            timestamp: None,
        };
        let item = record_to_item(BTC_ADDR, &record, 0.0);
        assert_eq!(item.direction, "in");
        assert_eq!(item.status, "pending");
        assert_eq!(item.timestamp, 0);
        assert!(item.description.starts_with("Отримано 0.004998 BTC від"));
        assert_eq!(item.fee_usd, 0.0);
    }

    #[test]
    fn solana_signature_without_amount_gets_generic_description() {
        let owner = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
        let record = TransactionRecord {
            chain: ChainId::Solana,
            hash: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXF".into(),
            from: Some(owner.into()),
            to: None,
            amount: None,
            token_address: None,
            fee: None,
            status: TxStatus::Confirmed,
            block_height: Some(114),
            timestamp: Some(1_720_526_751),
        };
        let item = record_to_item(owner, &record, 170.0);
        assert_eq!(item.description, "Транзакція в мережі solana");
        assert_eq!(item.amount, "0");
        assert_eq!(item.symbol, "SOL");
        assert_eq!(item.status, "confirmed");
    }

    #[test]
    fn failed_tx_maps_to_failed_status() {
        let owner = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
        let record = TransactionRecord {
            chain: ChainId::Solana,
            hash: "4bxsSXhPjidGyXipze5WYCFbLLcZs2mObjTKG9Uleg".into(),
            from: Some(owner.into()),
            to: None,
            amount: None,
            token_address: None,
            fee: None,
            status: TxStatus::Failed,
            block_height: Some(112),
            timestamp: None,
        };
        let item = record_to_item(owner, &record, 0.0);
        assert_eq!(item.status, "failed");
    }

    #[test]
    fn shorten_keeps_short_addresses() {
        assert_eq!(shorten("abc"), "abc");
        assert_eq!(
            shorten("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"),
            "bc1qar…5mdq"
        );
    }
}
