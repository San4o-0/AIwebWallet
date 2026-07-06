//! GET /v1/analytics/* — РЕАЛЬНА аналітика витрат і комісій (F6.1, F6.2).
//!
//! Агрегація з реальної історії: BTC/Solana — через chain-adapters,
//! EVM — через індексер Etherscan v2 (якщо задано ETHERSCAN_API_KEY;
//! без ключа EVM-мережі пропускаються, відповідь має поле `note`).
//!
//! - `/analytics/fees`: сума комісій за період (7d/30d/90d/1y) у USD,
//!   розподіл по мережах + денний таймлайн.
//! - `/analytics/summary`: кількість транзакцій, обсяги in/out у USD,
//!   розподіл по мережах і категоріях.
//!
//! Зібрана історія кешується в пам'яті (TTL 60 с), щоб два ендпоінти й
//! повторні запити не палили rate limit Etherscan / публічних нод.

use axum::{
    extract::{Query, State},
    Json,
};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use chain_adapters::{Address, ChainId};

use crate::chains::{native_coingecko_id, token_coingecko_id, EVM_CHAINS};
use crate::dto::{
    AnalyticsQuery, CategorySummary, ChainFees, FeePoint, FeesResponse, HistoryItem,
    SummaryResponse, TxCategory,
};
use crate::handlers::history::record_to_item;
use crate::handlers::{now_secs, ApiError};
use crate::indexer;
use crate::state::AppState;

const DAY: u64 = 86_400;
/// TTL кешу зібраної історії для аналітики.
const CACHE_TTL: Duration = Duration::from_secs(60);
/// Таймаут збору історії з однієї мережі.
const PER_CHAIN_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Кеш
// ---------------------------------------------------------------------------

/// Запис кешу: (час збору, історія, note).
type CachedHistory = (Instant, Vec<HistoryItem>, Option<String>);

/// In-memory кеш зібраної історії: адреса → (час, історія, note).
#[derive(Default)]
pub struct AnalyticsCache {
    inner: RwLock<HashMap<String, CachedHistory>>,
}

impl AnalyticsCache {
    async fn get(&self, key: &str) -> Option<(Vec<HistoryItem>, Option<String>)> {
        let cache = self.inner.read().await;
        cache.get(key).and_then(|(at, items, note)| {
            (at.elapsed() < CACHE_TTL).then(|| (items.clone(), note.clone()))
        })
    }

    async fn put(&self, key: String, items: Vec<HistoryItem>, note: Option<String>) {
        self.inner
            .write()
            .await
            .insert(key, (Instant::now(), items, note));
    }
}

// ---------------------------------------------------------------------------
// Хендлери
// ---------------------------------------------------------------------------

pub async fn fees(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AnalyticsQuery>,
) -> Result<Json<FeesResponse>, ApiError> {
    let period = q.period.unwrap_or_else(|| "30d".to_string());
    let seconds = period_seconds(&period)
        .ok_or_else(|| ApiError::bad_request(format!("невідомий період: {period} (7d/30d/90d/1y)")))?;

    let (items, note) = collect_history(&state, &q.address).await?;
    let mut resp = aggregate_fees(&q.address, &period, now_secs(), seconds, &items);
    resp.note = note;
    Ok(Json(resp))
}

pub async fn summary(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AnalyticsQuery>,
) -> Result<Json<SummaryResponse>, ApiError> {
    let period = q.period.unwrap_or_else(|| "30d".to_string());
    let seconds = period_seconds(&period)
        .ok_or_else(|| ApiError::bad_request(format!("невідомий період: {period} (7d/30d/90d/1y)")))?;

    let (items, note) = collect_history(&state, &q.address).await?;

    // Ціни для оцінки обсягів у USD — одним запитом за всіма символами.
    let ids: Vec<String> = items
        .iter()
        .filter_map(|i| symbol_coingecko_id(&i.symbol))
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let (price_map, _) = state.prices.get_prices(&ids).await;
    let usd_by_symbol: HashMap<String, f64> = items
        .iter()
        .map(|i| {
            let usd = symbol_coingecko_id(&i.symbol)
                .and_then(|id| price_map.get(id))
                .map(|p| p.usd)
                .unwrap_or(0.0);
            (i.symbol.clone(), usd)
        })
        .collect();

    let mut resp = aggregate_summary(&q.address, &period, now_secs(), seconds, &items, &usd_by_symbol);
    resp.note = note;
    Ok(Json(resp))
}

// ---------------------------------------------------------------------------
// Збір історії з усіх мереж, релевантних адресі
// ---------------------------------------------------------------------------

/// Історія адреси по всіх релевантних мережах (EVM ×5 / BTC / Solana),
/// з кешем TTL 60 с. Фейл однієї мережі не валить агрегацію (fail-safe).
async fn collect_history(
    state: &AppState,
    address: &str,
) -> Result<(Vec<HistoryItem>, Option<String>), ApiError> {
    let key = address.to_ascii_lowercase();
    if let Some(cached) = state.analytics_cache.get(&key).await {
        return Ok(cached);
    }

    let chains = chains_for_address(address)
        .ok_or_else(|| ApiError::bad_request(format!("нерозпізнана адреса: {address}")))?;

    let mut items: Vec<HistoryItem> = Vec::new();
    let mut note: Option<String> = None;

    for chain in chains {
        if chain.is_evm() {
            if !state.indexer.enabled() {
                note = Some(indexer::NO_KEY_NOTE.to_string());
                continue;
            }
            let (prices, _) = state
                .prices
                .get_prices(&[native_coingecko_id(chain).to_string()])
                .await;
            let native_usd = prices
                .get(native_coingecko_id(chain))
                .map(|p| p.usd)
                .unwrap_or(0.0);
            // Послідовно по мережах — rate limit Etherscan (5 rps).
            match tokio::time::timeout(
                PER_CHAIN_TIMEOUT,
                state.indexer.history(chain, &key, native_usd),
            )
            .await
            {
                Ok(Ok(chain_items)) => items.extend(chain_items),
                Ok(Err(e)) => {
                    tracing::warn!("analytics: {chain} пропущено: {}", e.message);
                }
                Err(_) => tracing::warn!("analytics: {chain} пропущено: таймаут"),
            }
        } else {
            let Ok(addr) = Address::new(chain, address.to_string()) else {
                continue;
            };
            let adapter = state.adapter(chain);
            let (prices, _) = state
                .prices
                .get_prices(&[native_coingecko_id(chain).to_string()])
                .await;
            let native_usd = prices
                .get(native_coingecko_id(chain))
                .map(|p| p.usd)
                .unwrap_or(0.0);
            match tokio::time::timeout(
                PER_CHAIN_TIMEOUT,
                adapter.get_transaction_history(&addr, None),
            )
            .await
            {
                Ok(Ok((records, _))) => {
                    items.extend(records.iter().map(|r| record_to_item(address, r, native_usd)));
                }
                Ok(Err(e)) => tracing::warn!("analytics: {chain} пропущено: {e}"),
                Err(_) => tracing::warn!("analytics: {chain} пропущено: таймаут"),
            }
        }
    }

    items.sort_by_key(|i| std::cmp::Reverse(i.timestamp));
    state
        .analytics_cache
        .put(key, items.clone(), note.clone())
        .await;
    Ok((items, note))
}

/// Мережі, релевантні синтаксису адреси: EVM (0x…) → всі 5 EVM-мереж;
/// далі Bitcoin; далі Solana (порядок важливий — коротка base58 BTC-адреса
/// не має потрапити в Solana).
fn chains_for_address(address: &str) -> Option<Vec<ChainId>> {
    if Address::new(ChainId::Ethereum, address.to_string()).is_ok() {
        return Some(EVM_CHAINS.to_vec());
    }
    if Address::bitcoin(address.to_string()).is_ok() {
        return Some(vec![ChainId::Bitcoin]);
    }
    if Address::solana(address.to_string()).is_ok() {
        return Some(vec![ChainId::Solana]);
    }
    None
}

// ---------------------------------------------------------------------------
// Чиста агрегація (юніт-тестується на фікстурній історії)
// ---------------------------------------------------------------------------

/// "7d" | "30d" | "90d" | "1y" → секунди.
pub(crate) fn period_seconds(period: &str) -> Option<u64> {
    match period {
        "7d" => Some(7 * DAY),
        "30d" => Some(30 * DAY),
        "90d" => Some(90 * DAY),
        "1y" => Some(365 * DAY),
        _ => None,
    }
}

/// Комісії за період: платимо лише за вихідні/власні транзакції
/// (для вхідних комісію платив відправник).
fn paid_fee(item: &HistoryItem) -> f64 {
    if item.direction == "in" {
        0.0
    } else {
        item.fee_usd
    }
}

/// Агрегація комісій (F6.1): сума в USD, розподіл по мережах, таймлайн по днях.
pub(crate) fn aggregate_fees(
    address: &str,
    period: &str,
    now: u64,
    period_secs: u64,
    items: &[HistoryItem],
) -> FeesResponse {
    let cutoff = now.saturating_sub(period_secs);
    let in_period: Vec<&HistoryItem> = items
        .iter()
        .filter(|i| i.timestamp >= cutoff && i.timestamp <= now + DAY)
        .collect();

    let mut by_chain: BTreeMap<String, (f64, u32)> = BTreeMap::new();
    let mut by_day: BTreeMap<u64, f64> = BTreeMap::new();
    let mut total = 0.0;

    for item in &in_period {
        let fee = paid_fee(item);
        total += fee;
        let entry = by_chain.entry(item.chain.clone()).or_insert((0.0, 0));
        entry.0 += fee;
        entry.1 += 1;
        if fee > 0.0 {
            *by_day.entry(item.timestamp - item.timestamp % DAY).or_insert(0.0) += fee;
        }
    }

    FeesResponse {
        address: address.to_string(),
        period: period.to_string(),
        total_fees_usd: total,
        by_chain: by_chain
            .into_iter()
            .map(|(chain, (fees_usd, tx_count))| ChainFees { chain, fees_usd, tx_count })
            .collect(),
        timeline: by_day
            .into_iter()
            .map(|(date, fees_usd)| FeePoint { date, fees_usd })
            .collect(),
        note: None,
    }
}

/// Дашборд (F6.1, F6.2): кількість транзакцій, обсяги in/out у USD,
/// розподіл по категоріях і мережах. `usd_by_symbol` — ціна одиниці активу.
pub(crate) fn aggregate_summary(
    address: &str,
    period: &str,
    now: u64,
    period_secs: u64,
    items: &[HistoryItem],
    usd_by_symbol: &HashMap<String, f64>,
) -> SummaryResponse {
    let cutoff = now.saturating_sub(period_secs);
    let in_period: Vec<&HistoryItem> = items
        .iter()
        .filter(|i| i.timestamp >= cutoff && i.timestamp <= now + DAY)
        .collect();

    let mut total_in = 0.0;
    let mut total_out = 0.0;
    let mut total_fees = 0.0;
    let mut by_category: BTreeMap<&'static str, (TxCategory, u32, f64)> = BTreeMap::new();
    let mut by_chain: BTreeMap<String, (f64, u32)> = BTreeMap::new();

    for item in &in_period {
        let unit_usd = usd_by_symbol.get(&item.symbol).copied().unwrap_or(0.0);
        let volume = item.amount.parse::<f64>().unwrap_or(0.0) * unit_usd;
        match item.direction.as_str() {
            "in" => total_in += volume,
            "out" => total_out += volume,
            _ => {}
        }
        total_fees += paid_fee(item);

        let cat_key = category_key(item.category);
        let entry = by_category.entry(cat_key).or_insert((item.category, 0, 0.0));
        entry.1 += 1;
        entry.2 += volume;

        let chain_entry = by_chain.entry(item.chain.clone()).or_insert((0.0, 0));
        chain_entry.0 += paid_fee(item);
        chain_entry.1 += 1;
    }

    SummaryResponse {
        address: address.to_string(),
        period: period.to_string(),
        total_in_usd: total_in,
        total_out_usd: total_out,
        total_fees_usd: total_fees,
        tx_count: in_period.len() as u32,
        by_category: by_category
            .into_values()
            .map(|(category, tx_count, volume_usd)| CategorySummary { category, tx_count, volume_usd })
            .collect(),
        by_chain: by_chain
            .into_iter()
            .map(|(chain, (fees_usd, tx_count))| ChainFees { chain, fees_usd, tx_count })
            .collect(),
        note: None,
    }
}

fn category_key(c: TxCategory) -> &'static str {
    match c {
        TxCategory::Transfer => "transfer",
        TxCategory::Swap => "swap",
        TxCategory::Approve => "approve",
        TxCategory::Mint => "mint",
        TxCategory::DappInteraction => "dapp_interaction",
    }
}

/// CoinGecko id за тикером активу: нативні монети мереж + стейблкоїни MVP.
pub(crate) fn symbol_coingecko_id(symbol: &str) -> Option<&'static str> {
    match symbol {
        "ETH" => Some("ethereum"),
        "BTC" => Some("bitcoin"),
        "SOL" => Some("solana"),
        "POL" => Some("polygon-ecosystem-token"),
        "BNB" => Some("binancecoin"),
        other => token_coingecko_id(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(
        chain: &str,
        ts: u64,
        category: TxCategory,
        direction: &str,
        amount: &str,
        symbol: &str,
        fee_usd: f64,
    ) -> HistoryItem {
        HistoryItem {
            tx_hash: format!("0x{ts}"),
            chain: chain.to_string(),
            timestamp: ts,
            category,
            description: String::new(),
            direction: direction.to_string(),
            amount: amount.to_string(),
            symbol: symbol.to_string(),
            counterparty: None,
            fee_usd,
            status: "confirmed".to_string(),
        }
    }

    /// Фікстурна історія: 3 мережі, різні категорії й напрямки.
    fn fixture(now: u64) -> Vec<HistoryItem> {
        vec![
            // Сьогодні: вихідний переказ 1 ETH, fee 1.47.
            item("ethereum", now - 3_600, TxCategory::Transfer, "out", "1", "ETH", 1.47),
            // Вчора: вхідні 150 USDC (fee платив відправник).
            item("ethereum", now - DAY, TxCategory::Transfer, "in", "150", "USDC", 0.0),
            // 2 дні тому: своп (self), fee 3.87.
            item("ethereum", now - 2 * DAY, TxCategory::Swap, "self", "0.2", "ETH", 3.87),
            // 10 днів тому: BTC out.
            item("bitcoin", now - 10 * DAY, TxCategory::Transfer, "out", "0.001", "BTC", 0.5),
            // 40 днів тому: поза періодом 30d.
            item("solana", now - 40 * DAY, TxCategory::Transfer, "out", "2", "SOL", 0.01),
            // Вхідна з fee_usd > 0 (комісію платив відправник — не рахуємо).
            item("bitcoin", now - 3 * DAY, TxCategory::Transfer, "in", "0.005", "BTC", 0.9),
        ]
    }

    #[test]
    fn period_parsing() {
        assert_eq!(period_seconds("7d"), Some(7 * DAY));
        assert_eq!(period_seconds("30d"), Some(30 * DAY));
        assert_eq!(period_seconds("90d"), Some(90 * DAY));
        assert_eq!(period_seconds("1y"), Some(365 * DAY));
        assert_eq!(period_seconds("14d"), None);
    }

    #[test]
    fn fees_aggregation_over_30d() {
        let now = 1_750_000_000;
        let resp = aggregate_fees("addr", "30d", now, 30 * DAY, &fixture(now));

        // 1.47 + 3.87 + 0.5 (SOL поза періодом, вхідні не рахуються).
        assert!((resp.total_fees_usd - 5.84).abs() < 1e-9);

        // По мережах: bitcoin (2 tx), ethereum (3 tx).
        assert_eq!(resp.by_chain.len(), 2);
        let eth = resp.by_chain.iter().find(|c| c.chain == "ethereum").unwrap();
        assert_eq!(eth.tx_count, 3);
        assert!((eth.fees_usd - 5.34).abs() < 1e-9);
        let btc = resp.by_chain.iter().find(|c| c.chain == "bitcoin").unwrap();
        assert_eq!(btc.tx_count, 2);
        assert!((btc.fees_usd - 0.5).abs() < 1e-9);

        // Таймлайн: 3 дні з ненульовими комісіями, за зростанням дати.
        assert_eq!(resp.timeline.len(), 3);
        assert!(resp.timeline.windows(2).all(|w| w[0].date < w[1].date));
        let sum: f64 = resp.timeline.iter().map(|p| p.fees_usd).sum();
        assert!((sum - resp.total_fees_usd).abs() < 1e-9);
    }

    #[test]
    fn fees_aggregation_over_7d_excludes_older() {
        let now = 1_750_000_000;
        let resp = aggregate_fees("addr", "7d", now, 7 * DAY, &fixture(now));
        // Лише ethereum-транзакції (BTC out — 10 днів тому).
        assert!((resp.total_fees_usd - 5.34).abs() < 1e-9);
    }

    #[test]
    fn summary_aggregation_with_prices() {
        let now = 1_750_000_000;
        let prices: HashMap<String, f64> = [
            ("ETH".to_string(), 3500.0),
            ("USDC".to_string(), 1.0),
            ("BTC".to_string(), 100_000.0),
        ]
        .into_iter()
        .collect();
        let resp = aggregate_summary("addr", "30d", now, 30 * DAY, &fixture(now), &prices);

        assert_eq!(resp.tx_count, 5); // SOL поза періодом
        // in: 150 USDC + 0.005 BTC = 150 + 500 = 650.
        assert!((resp.total_in_usd - 650.0).abs() < 1e-9);
        // out: 1 ETH + 0.001 BTC = 3500 + 100 = 3600.
        assert!((resp.total_out_usd - 3600.0).abs() < 1e-9);
        assert!((resp.total_fees_usd - 5.84).abs() < 1e-9);

        // Категорії: transfer (4) і swap (1).
        assert_eq!(resp.by_category.len(), 2);
        let transfer = resp
            .by_category
            .iter()
            .find(|c| c.category == TxCategory::Transfer)
            .unwrap();
        assert_eq!(transfer.tx_count, 4);
        let swap = resp
            .by_category
            .iter()
            .find(|c| c.category == TxCategory::Swap)
            .unwrap();
        assert_eq!(swap.tx_count, 1);
        // Своп self не входить ані в in, ані в out, але має обсяг.
        assert!((swap.volume_usd - 700.0).abs() < 1e-9); // 0.2 ETH

        assert_eq!(resp.by_chain.len(), 2);
    }

    #[test]
    fn empty_history_yields_zeroes() {
        let resp = aggregate_fees("addr", "30d", 1_750_000_000, 30 * DAY, &[]);
        assert_eq!(resp.total_fees_usd, 0.0);
        assert!(resp.by_chain.is_empty());
        assert!(resp.timeline.is_empty());

        let resp =
            aggregate_summary("addr", "1y", 1_750_000_000, 365 * DAY, &[], &HashMap::new());
        assert_eq!(resp.tx_count, 0);
        assert_eq!(resp.total_in_usd, 0.0);
    }

    #[test]
    fn symbol_price_ids_cover_natives_and_stables() {
        assert_eq!(symbol_coingecko_id("ETH"), Some("ethereum"));
        assert_eq!(symbol_coingecko_id("POL"), Some("polygon-ecosystem-token"));
        assert_eq!(symbol_coingecko_id("USDT"), Some("tether"));
        assert_eq!(symbol_coingecko_id("WIF"), None);
    }

    #[test]
    fn evm_address_maps_to_five_chains_btc_and_sol_to_one() {
        let evm = chains_for_address("0xd8da6bf26964af9d7eed9e03e53415d37aa96045").unwrap();
        assert_eq!(evm.len(), 5);
        let btc = chains_for_address("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").unwrap();
        assert_eq!(btc, vec![ChainId::Bitcoin]);
        let sol = chains_for_address("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T").unwrap();
        assert_eq!(sol, vec![ChainId::Solana]);
        assert!(chains_for_address("не-адреса").is_none());
    }
}
