//! POST /v1/balances — агрегований портфель (F2.1–F2.5).
//!
//! Реальні дані: фан-аут по адресах × мережах паралельно через chain-adapters,
//! таймаут ~5 с на мережу. Часткові фейли не валять відповідь — для мережі
//! повертається нульовий баланс із полем `error` (fail-safe, ТЗ §1.2).
//! Ціни — CoinGecko з in-memory кешем (TTL 60 с).

use axum::{extract::State, Json};
use futures::future::join_all;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use chain_adapters::{Address, ChainId};

use crate::chains::{
    native_coingecko_id, native_name, token_coingecko_id, token_name, EVM_CHAINS,
};
use crate::dto::{BalancesRequest, BalancesResponse, ChainBalance, PriceInfo, TokenBalance};
use crate::state::AppState;

/// Таймаут на одну мережу (ТЗ: повільна мережа не блокує портфель).
const CHAIN_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn balances(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BalancesRequest>,
) -> Json<BalancesResponse> {
    // Фан-аут: кожна EVM-адреса опитується в усіх 5 EVM-мережах,
    // Solana/Bitcoin-адреси — у своїх мережах. Усе — паралельно.
    let mut tasks = Vec::new();
    for addr in &req.addresses.evm {
        for chain in EVM_CHAINS {
            tasks.push(fetch_chain_balance(Arc::clone(&state), chain, addr.clone()));
        }
    }
    for addr in &req.addresses.solana {
        tasks.push(fetch_chain_balance(Arc::clone(&state), ChainId::Solana, addr.clone()));
    }
    for addr in &req.addresses.bitcoin {
        tasks.push(fetch_chain_balance(Arc::clone(&state), ChainId::Bitcoin, addr.clone()));
    }

    let mut chains: Vec<ChainBalance> = join_all(tasks).await;

    // Збагачення цінами: збираємо потрібні CoinGecko id одним запитом.
    let ids: BTreeSet<String> = chains
        .iter()
        .flat_map(price_ids_for)
        .collect();
    let ids: Vec<String> = ids.into_iter().collect();
    let (prices, prices_updated_at) = state.prices.get_prices(&ids).await;

    for cb in &mut chains {
        enrich_usd(cb, &prices);
    }
    let total_usd = chains.iter().map(|c| c.usd_value).sum();

    Json(BalancesResponse {
        total_usd,
        chains,
        prices_updated_at,
    })
}

/// Баланси однієї адреси в одній мережі. Ніколи не панікує і не повертає
/// помилку — фейл мережі кодується в `ChainBalance.error`.
async fn fetch_chain_balance(
    state: Arc<AppState>,
    chain: ChainId,
    address: String,
) -> ChainBalance {
    let addr = match Address::new(chain, address.clone()) {
        Ok(a) => a,
        Err(e) => return failed_balance(chain, address, e.to_string()),
    };
    let adapter = state.adapter(chain);

    let fetched = tokio::time::timeout(CHAIN_TIMEOUT, async {
        // Нативний баланс і токени — теж паралельно.
        tokio::join!(
            adapter.get_native_balance(&addr),
            adapter.get_token_balances(&addr)
        )
    })
    .await;

    match fetched {
        Ok((Ok(native), tokens)) => {
            // Фейл токенів — м'який: нативний баланс реальний, помилку фіксуємо.
            let (tokens, error) = match tokens {
                Ok(list) => (list, None),
                Err(e) => {
                    tracing::warn!("{chain}: токен-баланси недоступні: {e}");
                    (Vec::new(), Some(format!("токен-баланси недоступні: {e}")))
                }
            };
            ChainBalance {
                chain: chain.to_string(),
                address,
                native: to_dto_balance(chain, &native),
                tokens: tokens.iter().map(|t| to_dto_balance(chain, t)).collect(),
                usd_value: 0.0, // заповнюється в enrich_usd
                error,
            }
        }
        Ok((Err(e), _)) => {
            tracing::warn!("{chain}: баланс недоступний: {e}");
            failed_balance(chain, address, e.to_string())
        }
        Err(_) => {
            tracing::warn!("{chain}: таймаут {CHAIN_TIMEOUT:?}");
            failed_balance(
                chain,
                address,
                format!("таймаут мережі ({} с)", CHAIN_TIMEOUT.as_secs()),
            )
        }
    }
}

/// Нульовий баланс із причиною фейлу (fail-safe, ТЗ §1.2).
fn failed_balance(chain: ChainId, address: String, error: String) -> ChainBalance {
    ChainBalance {
        chain: chain.to_string(),
        address,
        native: TokenBalance {
            symbol: chain.native_symbol().to_string(),
            name: native_name(chain).to_string(),
            contract_address: None,
            amount: "0".into(),
            decimals: chain.native_decimals(),
            usd_value: 0.0,
        },
        tokens: Vec::new(),
        usd_value: 0.0,
        error: Some(error),
    }
}

/// Маппінг adapter → DTO. USD заповнюється пізніше (enrich_usd).
pub(crate) fn to_dto_balance(
    chain: ChainId,
    tb: &chain_adapters::TokenBalance,
) -> TokenBalance {
    let name = match &tb.token_address {
        None => native_name(chain).to_string(),
        Some(_) => token_name(&tb.symbol).to_string(),
    };
    TokenBalance {
        symbol: tb.symbol.clone(),
        name,
        contract_address: tb.token_address.clone(),
        amount: tb.amount.to_string(),
        decimals: tb.decimals,
        usd_value: 0.0,
    }
}

/// CoinGecko id-и, потрібні для оцінки цієї мережі.
fn price_ids_for(cb: &ChainBalance) -> Vec<String> {
    let mut ids = Vec::new();
    if let Ok(chain) = cb.chain.parse::<ChainId>() {
        ids.push(native_coingecko_id(chain).to_string());
    }
    for token in &cb.tokens {
        if let Some(id) = token_coingecko_id(&token.symbol) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// USD-оцінка балансу мережі: нативна монета + відомі токени.
/// Невідомі токени (без CoinGecko id) лишаються з usd_value = 0.
pub(crate) fn enrich_usd(cb: &mut ChainBalance, prices: &HashMap<String, PriceInfo>) {
    let Ok(chain) = cb.chain.parse::<ChainId>() else {
        return;
    };
    if let Some(price) = prices.get(native_coingecko_id(chain)) {
        cb.native.usd_value = ui_amount(&cb.native.amount, cb.native.decimals) * price.usd;
    }
    for token in &mut cb.tokens {
        if let Some(price) = token_coingecko_id(&token.symbol).and_then(|id| prices.get(id)) {
            token.usd_value = ui_amount(&token.amount, token.decimals) * price.usd;
        }
    }
    cb.usd_value = cb.native.usd_value + cb.tokens.iter().map(|t| t.usd_value).sum::<f64>();
}

/// Людська кількість з рядка в мінімальних одиницях (лише для USD-оцінки).
fn ui_amount(amount: &str, decimals: u8) -> f64 {
    amount.parse::<u128>().map(|v| v as f64).unwrap_or(0.0) / 10f64.powi(decimals as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_balance_maps_to_dto() {
        let native = chain_adapters::TokenBalance {
            symbol: "ETH".into(),
            decimals: 18,
            amount: 1_250_000_000_000_000_000,
            token_address: None,
            usd_value: None,
        };
        let dto = to_dto_balance(ChainId::Ethereum, &native);
        assert_eq!(dto.symbol, "ETH");
        assert_eq!(dto.name, "Ether");
        assert_eq!(dto.amount, "1250000000000000000");
        assert_eq!(dto.decimals, 18);
        assert!(dto.contract_address.is_none());

        let usdc = chain_adapters::TokenBalance {
            symbol: "USDC".into(),
            decimals: 6,
            amount: 532_100_000,
            token_address: Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()),
            usd_value: None,
        };
        let dto = to_dto_balance(ChainId::Ethereum, &usdc);
        assert_eq!(dto.name, "USD Coin");
        assert_eq!(
            dto.contract_address.as_deref(),
            Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
        );
    }

    #[test]
    fn enrich_usd_prices_native_and_tokens() {
        let mut cb = ChainBalance {
            chain: "ethereum".into(),
            address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045".into(),
            native: TokenBalance {
                symbol: "ETH".into(),
                name: "Ether".into(),
                contract_address: None,
                amount: "2000000000000000000".into(), // 2 ETH
                decimals: 18,
                usd_value: 0.0,
            },
            tokens: vec![TokenBalance {
                symbol: "USDC".into(),
                name: "USD Coin".into(),
                contract_address: Some("0xa0b8...".into()),
                amount: "100000000".into(), // 100 USDC
                decimals: 6,
                usd_value: 0.0,
            }],
            usd_value: 0.0,
            error: None,
        };
        let prices = HashMap::from([
            ("ethereum".to_string(), PriceInfo { usd: 3500.0, usd_24h_change: 0.0 }),
            ("usd-coin".to_string(), PriceInfo { usd: 1.0, usd_24h_change: 0.0 }),
        ]);
        enrich_usd(&mut cb, &prices);
        assert!((cb.native.usd_value - 7000.0).abs() < 1e-6);
        assert!((cb.tokens[0].usd_value - 100.0).abs() < 1e-6);
        assert!((cb.usd_value - 7100.0).abs() < 1e-6);
    }

    #[test]
    fn enrich_usd_without_price_keeps_zero() {
        let mut cb = ChainBalance {
            chain: "solana".into(),
            address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T".into(),
            native: TokenBalance {
                symbol: "SOL".into(),
                name: "Solana".into(),
                contract_address: None,
                amount: "12400000000".into(),
                decimals: 9,
                usd_value: 0.0,
            },
            tokens: vec![],
            usd_value: 0.0,
            error: None,
        };
        enrich_usd(&mut cb, &HashMap::new());
        assert_eq!(cb.usd_value, 0.0);
    }

    #[test]
    fn failed_balance_is_zero_with_error() {
        let cb = failed_balance(
            ChainId::Bitcoin,
            "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".into(),
            "таймаут".into(),
        );
        assert_eq!(cb.chain, "bitcoin");
        assert_eq!(cb.native.amount, "0");
        assert_eq!(cb.native.symbol, "BTC");
        assert_eq!(cb.error.as_deref(), Some("таймаут"));
    }
}
