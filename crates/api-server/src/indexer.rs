//! EVM-індексер історії транзакцій (F3.6, F4.4, F6.2) через **Etherscan API v2**.
//!
//! Один `ETHERSCAN_API_KEY` покриває всі 5 EVM-мереж MVP — мережа обирається
//! параметром `chainid` (`https://api.etherscan.io/v2/api?chainid=...`).
//! Методи: `account.txlist` (звичайні транзакції) + `account.tokentx`
//! (ERC-20 переміщення). Відповіді нормалізуються в [`HistoryItem`] з
//! категоризацією (переказ / своп / approve / mint / contract call — за
//! селекторами, `functionName` і напрямком токен-переміщень) і людськими
//! описами українською, як у BTC-історії.
//!
//! Без ключа індексер вимкнено: історія EVM повертає порожній список із
//! полем `note` (graceful degradation — НЕ падає).
//!
//! In-memory кеш (TTL 30 с) на (мережа, адреса), щоб не палити rate limit
//! (безкоштовний тариф Etherscan — 5 запитів/с).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::RwLock;

use chain_adapters::ChainId;

use crate::chains::format_base_units;
use crate::config::Config;
use crate::dto::{HistoryItem, TxCategory};
use crate::handlers::ApiError;

/// TTL кешу історії (щоб не палити rate limit Etherscan).
const CACHE_TTL: Duration = Duration::from_secs(30);
/// Скільки записів тягнемо з кожного списку (txlist / tokentx).
const PAGE_SIZE: u32 = 100;
/// Таймаут запиту до Etherscan.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Примітка для відповіді history, коли ключа немає.
pub const NO_KEY_NOTE: &str =
    "Історія EVM-мереж потребує ETHERSCAN_API_KEY (Etherscan API v2, один ключ на всі мережі). \
     Без ключа повертається порожній список.";

// ---------------------------------------------------------------------------
// Сервіс
// ---------------------------------------------------------------------------

type CacheKey = (ChainId, String);

struct CacheEntry {
    fetched_at: Instant,
    items: Vec<HistoryItem>,
}

/// Індексер історії EVM-мереж поверх Etherscan API v2.
pub struct EvmIndexer {
    http: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    cache: RwLock<HashMap<CacheKey, CacheEntry>>,
}

impl EvmIndexer {
    pub fn new(config: &Config) -> Self {
        EvmIndexer {
            http: reqwest::Client::new(),
            base_url: config.rpc.etherscan.clone(),
            api_key: config.etherscan_api_key.clone(),
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// `true`, якщо задано ETHERSCAN_API_KEY.
    pub fn enabled(&self) -> bool {
        self.api_key.is_some()
    }

    /// Нормалізована історія (нові → старі) для EVM-адреси.
    ///
    /// `native_usd` — поточна ціна нативної монети (для fee_usd).
    /// З кешем TTL 30 с. Помилка — лише коли Etherscan реально недоступний;
    /// відсутність ключа обробляється викликачем через [`Self::enabled`].
    pub async fn history(
        &self,
        chain: ChainId,
        address: &str,
        native_usd: f64,
    ) -> Result<Vec<HistoryItem>, ApiError> {
        let Some(api_key) = &self.api_key else {
            return Ok(Vec::new());
        };
        let owner = address.to_ascii_lowercase();
        let key = (chain, owner.clone());

        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&key) {
                if entry.fetched_at.elapsed() < CACHE_TTL {
                    return Ok(entry.items.clone());
                }
            }
        }

        // Два запити послідовно (rate limit 5 rps на безкоштовному тарифі).
        let txlist = self.fetch(chain, api_key, "txlist", &owner).await?;
        let tokentx = self.fetch(chain, api_key, "tokentx", &owner).await?;
        let items = normalize_etherscan(chain, &owner, &txlist, &tokentx, native_usd);

        self.cache.write().await.insert(
            key,
            CacheEntry { fetched_at: Instant::now(), items: items.clone() },
        );
        Ok(items)
    }

    async fn fetch(
        &self,
        chain: ChainId,
        api_key: &str,
        action: &str,
        address: &str,
    ) -> Result<Vec<EtherscanTx>, ApiError> {
        let chain_id = chain.evm_chain_id().ok_or_else(|| {
            ApiError::bad_request(format!("{chain}: індексер підтримує лише EVM-мережі"))
        })?;
        let url = format!(
            "{}?chainid={chain_id}&module=account&action={action}&address={address}\
             &startblock=0&endblock=latest&page=1&offset={PAGE_SIZE}&sort=desc&apikey={api_key}",
            self.base_url
        );
        let envelope: EtherscanEnvelope = self
            .http
            .get(&url)
            .timeout(FETCH_TIMEOUT)
            .send()
            .await
            .map_err(|e| ApiError::bad_gateway(format!("etherscan недоступний: {e}")))?
            .json()
            .await
            .map_err(|e| ApiError::bad_gateway(format!("etherscan: некоректний JSON: {e}")))?;

        // status "0" + "No transactions found" — нормальний порожній результат.
        if envelope.status != "1" {
            if envelope.message.to_lowercase().contains("no transactions") {
                return Ok(Vec::new());
            }
            let detail = match &envelope.result {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            return Err(ApiError::bad_gateway(format!(
                "etherscan {action}: {} ({detail})",
                envelope.message
            )));
        }
        serde_json::from_value(envelope.result)
            .map_err(|e| ApiError::bad_gateway(format!("etherscan {action}: розбір: {e}")))
    }
}

// ---------------------------------------------------------------------------
// Форми відповіді Etherscan (юніт-тестуються на фікстурах)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct EtherscanEnvelope {
    pub status: String,
    pub message: String,
    pub result: serde_json::Value,
}

/// Один запис `txlist` або `tokentx` (спільна форма — зайві поля ігноруються).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct EtherscanTx {
    pub hash: String,
    #[serde(rename = "timeStamp", default)]
    pub time_stamp: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub input: String,
    #[serde(rename = "gasUsed", default)]
    pub gas_used: String,
    #[serde(rename = "gasPrice", default)]
    pub gas_price: String,
    #[serde(rename = "isError", default)]
    pub is_error: String,
    #[serde(rename = "functionName", default)]
    pub function_name: String,
    /// tokentx: тикер токена.
    #[serde(rename = "tokenSymbol", default)]
    pub token_symbol: String,
    /// tokentx: decimals токена (рядок).
    #[serde(rename = "tokenDecimal", default)]
    pub token_decimal: String,
}

// ---------------------------------------------------------------------------
// Нормалізація і категоризація (чисті функції)
// ---------------------------------------------------------------------------

/// Токен-переміщення в межах однієї транзакції.
#[derive(Debug, Clone)]
struct TokenMove {
    from: String,
    to: String,
    amount: u128,
    symbol: String,
    decimals: u8,
}

/// Нормалізує відповіді Etherscan (txlist + tokentx) в [`HistoryItem`]:
/// одна позиція на tx hash, нові → старі.
pub(crate) fn normalize_etherscan(
    chain: ChainId,
    owner: &str,
    txlist: &[EtherscanTx],
    tokentx: &[EtherscanTx],
    native_usd: f64,
) -> Vec<HistoryItem> {
    let owner = owner.to_ascii_lowercase();

    // Групуємо токен-переміщення за hash.
    let mut moves: HashMap<String, Vec<TokenMove>> = HashMap::new();
    for t in tokentx {
        moves.entry(t.hash.clone()).or_default().push(TokenMove {
            from: t.from.to_ascii_lowercase(),
            to: t.to.to_ascii_lowercase(),
            amount: t.value.parse().unwrap_or(0),
            symbol: if t.token_symbol.is_empty() { "TOKEN".into() } else { t.token_symbol.clone() },
            decimals: t.token_decimal.parse().unwrap_or(18),
        });
    }

    let mut items: Vec<HistoryItem> = Vec::new();
    for tx in txlist {
        let tx_moves = moves.remove(&tx.hash).unwrap_or_default();
        items.push(tx_to_item(chain, &owner, tx, &tx_moves, native_usd));
    }

    // tokentx без відповідного запису в txlist — найчастіше ВХІДНІ токен-
    // перекази (txlist показує лише транзакції, де адреса — from/to).
    let mut leftovers: Vec<(String, Vec<TokenMove>)> = moves.into_iter().collect();
    leftovers.sort_by(|a, b| a.0.cmp(&b.0)); // детермінований порядок
    for (hash, tx_moves) in leftovers {
        // Часова мітка з першого запису tokentx цієї транзакції.
        let ts = tokentx
            .iter()
            .find(|t| t.hash == hash)
            .and_then(|t| t.time_stamp.parse::<u64>().ok())
            .unwrap_or(0);
        if let Some(item) = token_only_item(chain, &owner, &hash, ts, &tx_moves) {
            items.push(item);
        }
    }

    items.sort_by_key(|i| std::cmp::Reverse(i.timestamp));
    items
}

/// Категоризація EVM-транзакції (F6.2) за селектором, functionName і
/// напрямком токен-переміщень.
pub(crate) fn categorize(
    input: &str,
    function_name: &str,
    sent_tokens: usize,
    received_tokens: usize,
) -> TxCategory {
    let hex_body = input.strip_prefix("0x").unwrap_or(input);
    if hex_body.is_empty() {
        return TxCategory::Transfer;
    }
    let selector = hex_body.get(..8).unwrap_or("").to_ascii_lowercase();
    let fname = function_name.to_ascii_lowercase();

    // ERC-20 transfer / transferFrom.
    if selector == "a9059cbb" || selector == "23b872dd" {
        return TxCategory::Transfer;
    }
    // approve / permit / setApprovalForAll / increaseAllowance.
    if ["095ea7b3", "d505accf", "a22cb465", "39509351"].contains(&selector.as_str())
        || fname.starts_with("approve")
        || fname.starts_with("permit")
    {
        return TxCategory::Approve;
    }
    // Свопи: відомі селектори роутерів (Uniswap V2/V3/Universal, 1inch) або
    // "swap" у functionName, або токени й туди, й сюди в одній транзакції.
    const SWAP_SELECTORS: [&str; 13] = [
        "38ed1739", "7ff36ab5", "18cbafe5", "8803dbee", "fb3bdb41", // Uniswap V2
        "5ae401dc", "04e45aaf", "c04b8d59", "414bf389", "db3e2198", // Uniswap V3
        "3593564c", // Universal Router execute
        "12aa3caf", "0502b1c5", // 1inch
    ];
    if SWAP_SELECTORS.contains(&selector.as_str())
        || fname.contains("swap")
        || (sent_tokens > 0 && received_tokens > 0)
    {
        return TxCategory::Swap;
    }
    // Мінти (токени/NFT).
    if ["1249c58b", "a0712d68", "40c10f19"].contains(&selector.as_str())
        || fname.starts_with("mint")
    {
        return TxCategory::Mint;
    }
    TxCategory::DappInteraction
}

/// Маппінг запису txlist (+ токен-переміщення цієї транзакції) в HistoryItem.
fn tx_to_item(
    chain: ChainId,
    owner: &str,
    tx: &EtherscanTx,
    tx_moves: &[TokenMove],
    native_usd: f64,
) -> HistoryItem {
    let from = tx.from.to_ascii_lowercase();
    let to = tx.to.to_ascii_lowercase();
    let value: u128 = tx.value.parse().unwrap_or(0);
    let decimals = chain.native_decimals();

    let sent: Vec<&TokenMove> = tx_moves.iter().filter(|m| m.from == owner).collect();
    let received: Vec<&TokenMove> = tx_moves.iter().filter(|m| m.to == owner).collect();
    let category = categorize(&tx.input, &tx.function_name, sent.len(), received.len());

    let direction = if from == owner && to == owner {
        "self"
    } else if from == owner {
        "out"
    } else if to == owner || !received.is_empty() {
        "in"
    } else {
        "self"
    };

    // Комісію платить відправник.
    let fee_usd = if from == owner {
        let fee_wei: u128 = tx.gas_used.parse::<u128>().unwrap_or(0)
            * tx.gas_price.parse::<u128>().unwrap_or(0);
        (fee_wei as f64 / 10f64.powi(decimals as i32)) * native_usd
    } else {
        0.0
    };

    // Сума/символ: нативна, якщо value > 0; інакше — токен-переміщення власника.
    let (amount, symbol, token_move): (String, String, Option<&TokenMove>) = if value > 0
        && category == TxCategory::Transfer
    {
        (format_base_units(value, decimals), chain.native_symbol().to_string(), None)
    } else if let Some(m) = sent.first().or_else(|| received.first()) {
        (format_base_units(m.amount, m.decimals), m.symbol.clone(), Some(m))
    } else if value > 0 {
        (format_base_units(value, decimals), chain.native_symbol().to_string(), None)
    } else {
        ("0".into(), chain.native_symbol().to_string(), None)
    };

    let counterparty = match direction {
        "out" => token_move
            .map(|m| m.to.clone())
            .or_else(|| (!to.is_empty()).then(|| to.clone())),
        "in" => token_move
            .map(|m| m.from.clone())
            .or_else(|| (!from.is_empty()).then(|| from.clone())),
        _ => None,
    };

    let description = describe(
        category,
        direction,
        &amount,
        &symbol,
        counterparty.as_deref(),
        &sent,
        &received,
        &tx.function_name,
        &to,
    );

    HistoryItem {
        tx_hash: tx.hash.clone(),
        chain: chain.to_string(),
        timestamp: tx.time_stamp.parse().unwrap_or(0),
        category,
        description,
        direction: direction.to_string(),
        amount,
        symbol,
        counterparty,
        fee_usd,
        status: if tx.is_error == "1" { "failed" } else { "confirmed" }.to_string(),
    }
}

/// Item для транзакції, видимої лише в tokentx (вхідний токен-переказ).
fn token_only_item(
    chain: ChainId,
    owner: &str,
    hash: &str,
    timestamp: u64,
    tx_moves: &[TokenMove],
) -> Option<HistoryItem> {
    let m = tx_moves
        .iter()
        .find(|m| m.to == owner)
        .or_else(|| tx_moves.iter().find(|m| m.from == owner))?;
    let direction = if m.to == owner { "in" } else { "out" };
    let amount = format_base_units(m.amount, m.decimals);
    let counterparty = if direction == "in" { m.from.clone() } else { m.to.clone() };
    let description = if direction == "in" {
        format!("Отримано {amount} {} від {}", m.symbol, shorten(&counterparty))
    } else {
        format!("Надіслано {amount} {} до {}", m.symbol, shorten(&counterparty))
    };
    Some(HistoryItem {
        tx_hash: hash.to_string(),
        chain: chain.to_string(),
        timestamp,
        category: TxCategory::Transfer,
        description,
        direction: direction.to_string(),
        amount,
        symbol: m.symbol.clone(),
        counterparty: Some(counterparty),
        fee_usd: 0.0,
        status: "confirmed".to_string(),
    })
}

/// Людський опис українською (як у BTC-історії).
#[allow(clippy::too_many_arguments)]
fn describe(
    category: TxCategory,
    direction: &str,
    amount: &str,
    symbol: &str,
    counterparty: Option<&str>,
    sent: &[&TokenMove],
    received: &[&TokenMove],
    function_name: &str,
    contract: &str,
) -> String {
    match category {
        TxCategory::Transfer => match (direction, counterparty) {
            ("in", Some(c)) => format!("Отримано {amount} {symbol} від {}", shorten(c)),
            ("in", None) => format!("Отримано {amount} {symbol}"),
            ("out", Some(c)) => format!("Надіслано {amount} {symbol} до {}", shorten(c)),
            ("out", None) => format!("Надіслано {amount} {symbol}"),
            _ => format!("Переказ {amount} {symbol}"),
        },
        TxCategory::Swap => match (sent.first(), received.first()) {
            (Some(s), Some(r)) => format!(
                "Обмін {} {} на {} {}",
                format_base_units(s.amount, s.decimals),
                s.symbol,
                format_base_units(r.amount, r.decimals),
                r.symbol
            ),
            (Some(s), None) => format!(
                "Обмін {} {} через {}",
                format_base_units(s.amount, s.decimals),
                s.symbol,
                shorten(contract)
            ),
            (None, Some(r)) => format!(
                "Обмін на {} {} через {}",
                format_base_units(r.amount, r.decimals),
                r.symbol,
                shorten(contract)
            ),
            (None, None) => format!("Своп через {}", shorten(contract)),
        },
        TxCategory::Approve => format!(
            "Надано дозвіл на витрачання токенів (контракт {})",
            shorten(contract)
        ),
        TxCategory::Mint => match received.first() {
            Some(r) => format!(
                "Мінт {} {}",
                format_base_units(r.amount, r.decimals),
                r.symbol
            ),
            None => format!("Мінт токенів через {}", shorten(contract)),
        },
        TxCategory::DappInteraction => {
            let method = function_name.split('(').next().unwrap_or("").trim();
            if method.is_empty() {
                format!("Взаємодія з контрактом {}", shorten(contract))
            } else {
                format!("Виклик {method} на контракті {}", shorten(contract))
            }
        }
    }
}

/// "0xd8da6b…6045" — скорочення адреси для опису.
fn shorten(addr: &str) -> String {
    if addr.len() <= 13 {
        addr.to_string()
    } else {
        format!("{}…{}", &addr[..8], &addr[addr.len() - 4..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const OTHER: &str = "0xab5801a7d398351b8be11c439e05c5b3259aec9b";
    const ROUTER: &str = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
    const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

    fn parse_txs(json: &str) -> Vec<EtherscanTx> {
        let envelope: EtherscanEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(envelope.status, "1");
        serde_json::from_value(envelope.result).unwrap()
    }

    /// Обрізана реальна форма відповіді txlist Etherscan API v2.
    fn txlist_fixture() -> Vec<EtherscanTx> {
        parse_txs(&format!(
            r#"{{
              "status": "1",
              "message": "OK",
              "result": [
                {{
                  "blockNumber": "19000010",
                  "timeStamp": "1720100000",
                  "hash": "0xaaa1",
                  "from": "{OWNER}",
                  "to": "{OTHER}",
                  "value": "1000000000000000000",
                  "gas": "21000",
                  "gasPrice": "20000000000",
                  "gasUsed": "21000",
                  "isError": "0",
                  "input": "0x",
                  "functionName": ""
                }},
                {{
                  "blockNumber": "19000009",
                  "timeStamp": "1720090000",
                  "hash": "0xbbb2",
                  "from": "{OWNER}",
                  "to": "{USDC}",
                  "value": "0",
                  "gas": "60000",
                  "gasPrice": "10000000000",
                  "gasUsed": "48000",
                  "isError": "0",
                  "input": "0x095ea7b30000000000000000000000001111111254eeb25477b68fb85ed929f73a960582ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                  "functionName": "approve(address spender, uint256 value)"
                }},
                {{
                  "blockNumber": "19000008",
                  "timeStamp": "1720080000",
                  "hash": "0xccc3",
                  "from": "{OWNER}",
                  "to": "{ROUTER}",
                  "value": "200000000000000000",
                  "gas": "200000",
                  "gasPrice": "15000000000",
                  "gasUsed": "150000",
                  "isError": "0",
                  "input": "0x3593564cdeadbeef",
                  "functionName": "execute(bytes commands,bytes[] inputs,uint256 deadline)"
                }},
                {{
                  "blockNumber": "19000007",
                  "timeStamp": "1720070000",
                  "hash": "0xddd4",
                  "from": "{OWNER}",
                  "to": "{ROUTER}",
                  "value": "0",
                  "gas": "100000",
                  "gasPrice": "10000000000",
                  "gasUsed": "90000",
                  "isError": "1",
                  "input": "0xdeadbeefcafe",
                  "functionName": "doSomething()"
                }}
              ]
            }}"#
        ))
    }

    /// tokentx: своп 0xccc3 (отримано USDC) + вхідний переказ 0xeee5,
    /// якого НЕМАЄ у txlist.
    fn tokentx_fixture() -> Vec<EtherscanTx> {
        parse_txs(&format!(
            r#"{{
              "status": "1",
              "message": "OK",
              "result": [
                {{
                  "blockNumber": "19000008",
                  "timeStamp": "1720080000",
                  "hash": "0xccc3",
                  "from": "{ROUTER}",
                  "to": "{OWNER}",
                  "value": "698400000",
                  "contractAddress": "{USDC}",
                  "tokenName": "USD Coin",
                  "tokenSymbol": "USDC",
                  "tokenDecimal": "6",
                  "gasPrice": "15000000000",
                  "gasUsed": "150000",
                  "input": "deprecated"
                }},
                {{
                  "blockNumber": "19000006",
                  "timeStamp": "1720060000",
                  "hash": "0xeee5",
                  "from": "{OTHER}",
                  "to": "{OWNER}",
                  "value": "150000000",
                  "contractAddress": "{USDC}",
                  "tokenName": "USD Coin",
                  "tokenSymbol": "USDC",
                  "tokenDecimal": "6",
                  "gasPrice": "10000000000",
                  "gasUsed": "65000",
                  "input": "deprecated"
                }}
              ]
            }}"#
        ))
    }

    #[test]
    fn normalization_merges_txlist_and_tokentx() {
        let items =
            normalize_etherscan(ChainId::Ethereum, OWNER, &txlist_fixture(), &tokentx_fixture(), 3500.0);
        // 4 txlist + 1 tokentx-only (0xeee5).
        assert_eq!(items.len(), 5);
        // Сортування: нові → старі.
        assert_eq!(items[0].tx_hash, "0xaaa1");
        assert_eq!(items[4].tx_hash, "0xeee5");
    }

    #[test]
    fn native_transfer_out_is_categorized_and_described() {
        let items =
            normalize_etherscan(ChainId::Ethereum, OWNER, &txlist_fixture(), &[], 3500.0);
        let item = items.iter().find(|i| i.tx_hash == "0xaaa1").unwrap();
        assert_eq!(item.category, TxCategory::Transfer);
        assert_eq!(item.direction, "out");
        assert_eq!(item.amount, "1");
        assert_eq!(item.symbol, "ETH");
        assert_eq!(item.counterparty.as_deref(), Some(OTHER));
        assert!(item.description.starts_with("Надіслано 1 ETH до"));
        // fee = 21000 * 20 gwei = 0.00042 ETH * 3500 = 1.47 USD
        assert!((item.fee_usd - 1.47).abs() < 1e-9);
        assert_eq!(item.status, "confirmed");
    }

    #[test]
    fn approve_is_categorized() {
        let items =
            normalize_etherscan(ChainId::Ethereum, OWNER, &txlist_fixture(), &[], 3500.0);
        let item = items.iter().find(|i| i.tx_hash == "0xbbb2").unwrap();
        assert_eq!(item.category, TxCategory::Approve);
        assert!(item.description.contains("дозвіл"));
    }

    #[test]
    fn swap_uses_token_moves_for_description() {
        let items = normalize_etherscan(
            ChainId::Ethereum,
            OWNER,
            &txlist_fixture(),
            &tokentx_fixture(),
            3500.0,
        );
        let item = items.iter().find(|i| i.tx_hash == "0xccc3").unwrap();
        assert_eq!(item.category, TxCategory::Swap);
        assert_eq!(item.symbol, "USDC");
        assert_eq!(item.amount, "698.4");
        assert!(item.description.contains("Обмін"));
        assert!(item.description.contains("698.4 USDC"));
    }

    #[test]
    fn failed_contract_call_maps_to_failed_dapp_interaction() {
        let items =
            normalize_etherscan(ChainId::Ethereum, OWNER, &txlist_fixture(), &[], 3500.0);
        let item = items.iter().find(|i| i.tx_hash == "0xddd4").unwrap();
        assert_eq!(item.category, TxCategory::DappInteraction);
        assert_eq!(item.status, "failed");
        assert!(item.description.contains("doSomething"));
    }

    #[test]
    fn incoming_token_transfer_from_tokentx_only() {
        let items = normalize_etherscan(
            ChainId::Ethereum,
            OWNER,
            &txlist_fixture(),
            &tokentx_fixture(),
            3500.0,
        );
        let item = items.iter().find(|i| i.tx_hash == "0xeee5").unwrap();
        assert_eq!(item.category, TxCategory::Transfer);
        assert_eq!(item.direction, "in");
        assert_eq!(item.amount, "150");
        assert_eq!(item.symbol, "USDC");
        assert_eq!(item.fee_usd, 0.0); // комісію платив відправник
        assert!(item.description.starts_with("Отримано 150 USDC від"));
    }

    #[test]
    fn categorization_by_selector_and_direction() {
        assert_eq!(categorize("0x", "", 0, 0), TxCategory::Transfer);
        assert_eq!(categorize("0xa9059cbb00", "", 0, 0), TxCategory::Transfer);
        assert_eq!(categorize("0x23b872dd00", "", 0, 0), TxCategory::Transfer);
        assert_eq!(categorize("0x095ea7b300", "", 0, 0), TxCategory::Approve);
        assert_eq!(
            categorize("0x38ed173900", "swapExactTokensForTokens(...)", 1, 1),
            TxCategory::Swap
        );
        // Невідомий селектор, але токени в обидва боки → своп.
        assert_eq!(categorize("0xdeadbeef00", "", 1, 1), TxCategory::Swap);
        assert_eq!(categorize("0x1249c58b", "mint()", 0, 1), TxCategory::Mint);
        assert_eq!(categorize("0xdeadbeef00", "", 0, 0), TxCategory::DappInteraction);
    }

    #[test]
    fn no_transactions_found_is_empty_not_error() {
        let envelope: EtherscanEnvelope = serde_json::from_str(
            r#"{ "status": "0", "message": "No transactions found", "result": [] }"#,
        )
        .unwrap();
        assert_eq!(envelope.status, "0");
        assert!(envelope.message.to_lowercase().contains("no transactions"));
    }
}
