//! TRON adapter over the TronGrid HTTP API (api.trongrid.io).
//!
//! Endpoints used (усі приймають/повертають base58-адреси з `visible=true`):
//! - `GET  /v1/accounts/:addr`               — баланс TRX (sun) + TRC-20 мапа
//! - `POST /wallet/getchainparameters`       — ціни bandwidth/energy (sun)
//! - `GET  /v1/accounts/:addr/transactions`  — історія (fingerprint-пагінація)
//! - `POST /wallet/broadcasthex`             — broadcast підписаної транзакції
//!
//! TRC-20 без індексера: TronGrid сам повертає мапу «контракт → баланс»,
//! символи/decimals відомих токенів задаються конфігом ([`TronTokenConfig`]),
//! невідомі контракти показуються як "TRC20".

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::error::AdapterError;
use crate::types::{
    Address, ChainId, FeeEstimate, FeeRate, TokenBalance, TransactionRecord, TxRequest, TxStatus,
};
use crate::ChainAdapter;

/// Публічний TronGrid mainnet.
pub const DEFAULT_TRONGRID_API: &str = "https://api.trongrid.io";

/// USDT TRC-20 mainnet (найуживаніший токен мережі).
pub const USDT_TRC20: &str = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/// Відомий TRC-20 токен (без індексера — конфігом, як TokenConfig в EVM).
#[derive(Debug, Clone)]
pub struct TronTokenConfig {
    /// Base58-адреса контракту (`T…`).
    pub address: String,
    pub symbol: String,
    pub decimals: u8,
}

/// Дефолтний список відомих TRC-20 (MVP: USDT).
pub fn default_tron_tokens() -> Vec<TronTokenConfig> {
    vec![TronTokenConfig {
        address: USDT_TRC20.to_string(),
        symbol: "USDT".to_string(),
        decimals: 6,
    }]
}

/// TTL короткого кеша акаунтів: get_native_balance і get_token_balances
/// читають той самий /v1/accounts — без кеша це два запити поспіль,
/// що боляче б'є в rate-limit публічного TronGrid.
const ACCOUNT_CACHE_TTL: Duration = Duration::from_secs(10);

type AccountCache = Arc<Mutex<HashMap<String, (Instant, Option<TronAccount>)>>>;

/// Adapter для TRON через TronGrid-сумісний REST API.
#[derive(Debug, Clone)]
pub struct TronAdapter {
    http: reqwest::Client,
    base_url: String,
    tokens: Vec<TronTokenConfig>,
    /// TronGrid API-ключ (заголовок TRON-PRO-API-KEY): без нього публічні
    /// ліміти жорсткі, з ним — значно вищі. Опційний.
    api_key: Option<String>,
    /// Кеш відповідей /v1/accounts (TTL 10 с), спільний між клонами.
    account_cache: AccountCache,
}

impl Default for TronAdapter {
    fn default() -> Self {
        Self::new(DEFAULT_TRONGRID_API)
    }
}

impl TronAdapter {
    /// Adapter із дефолтним списком відомих TRC-20 (USDT).
    pub fn new(base_url: impl Into<String>) -> Self {
        Self::with_tokens(base_url, default_tron_tokens())
    }

    pub fn with_tokens(base_url: impl Into<String>, tokens: Vec<TronTokenConfig>) -> Self {
        TronAdapter {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            tokens,
            api_key: None,
            account_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Задає TronGrid API-ключ (порожній рядок — як відсутній).
    pub fn with_api_key(mut self, api_key: Option<String>) -> Self {
        self.api_key = api_key.filter(|k| !k.trim().is_empty());
        self
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => req.header("TRON-PRO-API-KEY", key),
            None => req,
        }
    }

    fn check_chain(address: &Address) -> Result<(), AdapterError> {
        if address.chain() == ChainId::Tron {
            Ok(())
        } else {
            Err(AdapterError::InvalidInput(format!(
                "address belongs to {}, adapter serves tron",
                address.chain()
            )))
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, AdapterError> {
        let url = format!("{}{path}", self.base_url);
        let response = self.with_auth(self.http.get(&url)).send().await?;
        if !response.status().is_success() {
            let code = response.status().as_u16() as i64;
            let message = response.text().await.unwrap_or_default();
            return Err(AdapterError::Rpc { code, message });
        }
        Ok(response.json().await?)
    }

    async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, AdapterError> {
        let url = format!("{}{path}", self.base_url);
        let response = self.with_auth(self.http.post(&url).json(&body)).send().await?;
        if !response.status().is_success() {
            let code = response.status().as_u16() as i64;
            let message = response.text().await.unwrap_or_default();
            return Err(AdapterError::Rpc { code, message });
        }
        Ok(response.json().await?)
    }

    /// Акаунт із /v1/accounts (None — акаунт ще не активований у мережі:
    /// на TRON це нормально до першого вхідного переказу).
    ///
    /// Кеш TTL 10 с; лок тримається на час запиту, тому конкурентні виклики
    /// (native + tokens ідуть паралельно) не дублюють HTTP-запит.
    async fn fetch_account(&self, address: &Address) -> Result<Option<TronAccount>, AdapterError> {
        let mut cache = self.account_cache.lock().await;
        if let Some((fetched_at, account)) = cache.get(address.as_str()) {
            if fetched_at.elapsed() < ACCOUNT_CACHE_TTL {
                return Ok(account.clone());
            }
        }
        let resp: AccountsResponse = self
            .get_json(&format!("/v1/accounts/{}", address.as_str()))
            .await?;
        let account = resp.data.into_iter().next();
        cache.insert(address.as_str().to_string(), (Instant::now(), account.clone()));
        Ok(account)
    }
}

// ---------------------------------------------------------------------------
// Response shapes (unit-tested against fixtures)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct AccountsResponse {
    #[serde(default)]
    pub data: Vec<TronAccount>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TronAccount {
    /// Баланс TRX у sun (відсутній у свіжих акаунтів).
    #[serde(default)]
    pub balance: u64,
    /// TRC-20 баланси: список мап «контракт (base58) → кількість (рядок)».
    #[serde(default)]
    pub trc20: Vec<HashMap<String, String>>,
}

/// TRC-20 баланси акаунта — ЛИШЕ відомі токени з конфіга (як known_tokens
/// в EVM): TronGrid повертає всі контракти, включно зі скам-/dust-токенами,
/// які не можна показувати користувачу як активи.
pub(crate) fn trc20_balances(
    account: &TronAccount,
    tokens: &[TronTokenConfig],
) -> Vec<TokenBalance> {
    let mut merged: HashMap<&str, u128> = HashMap::new();
    for entry in &account.trc20 {
        for (contract, amount) in entry {
            if let Ok(value) = amount.parse::<u128>() {
                *merged.entry(contract.as_str()).or_default() += value;
            }
        }
    }
    tokens
        .iter()
        .filter_map(|token| {
            let amount = *merged.get(token.address.as_str())?;
            Some(TokenBalance {
                symbol: token.symbol.clone(),
                decimals: token.decimals,
                amount,
                token_address: Some(token.address.clone()),
                usd_value: None,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChainParametersResponse {
    #[serde(default, rename = "chainParameter")]
    pub chain_parameter: Vec<ChainParameter>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChainParameter {
    pub key: String,
    #[serde(default)]
    pub value: i64,
}

/// Ціни ресурсів із chain parameters. TRON не має fee-ринку, тому всі три
/// тири однакові. Fallback-ціни — довгострокові mainnet-значення.
pub(crate) fn fee_estimate_from_parameters(params: &[ChainParameter]) -> FeeEstimate {
    let find = |key: &str, default: u64| {
        params
            .iter()
            .find(|p| p.key == key)
            .map(|p| p.value.max(0) as u64)
            .unwrap_or(default)
    };
    // getTransactionFee — ціна bandwidth (sun/байт), getEnergyFee — sun/energy.
    let rate = FeeRate::TronResource {
        bandwidth_price_sun: find("getTransactionFee", 1000),
        energy_price_sun: find("getEnergyFee", 210),
    };
    FeeEstimate {
        slow: rate,
        standard: rate,
        fast: rate,
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct TransactionsResponse {
    #[serde(default)]
    pub data: Vec<TronTx>,
    #[serde(default)]
    pub meta: TxMeta,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct TxMeta {
    #[serde(default)]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TronTx {
    #[serde(rename = "txID")]
    pub tx_id: String,
    #[serde(default)]
    pub block_number: Option<u64>,
    /// Мілісекунди Unix.
    #[serde(default)]
    pub block_timestamp: Option<u64>,
    #[serde(default)]
    pub ret: Vec<TronTxRet>,
    #[serde(default)]
    pub raw_data: Option<TronRawData>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TronTxRet {
    #[serde(default)]
    pub fee: Option<u64>,
    #[serde(rename = "contractRet", default)]
    pub contract_ret: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TronRawData {
    #[serde(default)]
    pub contract: Vec<TronContract>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TronContract {
    #[serde(rename = "type", default)]
    pub contract_type: Option<String>,
    #[serde(default)]
    pub parameter: Option<TronContractParameter>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TronContractParameter {
    #[serde(default)]
    pub value: Option<TronContractValue>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TronContractValue {
    /// Сума в sun (лише TransferContract).
    #[serde(default)]
    pub amount: Option<u64>,
    #[serde(default)]
    pub owner_address: Option<String>,
    #[serde(default)]
    pub to_address: Option<String>,
    /// Адреса смарт-контракту (TriggerSmartContract, зокрема TRC-20).
    #[serde(default)]
    pub contract_address: Option<String>,
}

/// Мапить TronGrid-транзакцію в [`TransactionRecord`].
///
/// Покривається нативний TransferContract (сума в sun); TRC-20 перекази
/// (TriggerSmartContract) відображаються з контрактом, але без розбору
/// calldata — суму дасть окремий trc20-ендпоінт (TODO).
pub(crate) fn tx_to_record(tx: &TronTx) -> TransactionRecord {
    let contract = tx
        .raw_data
        .as_ref()
        .and_then(|raw| raw.contract.first());
    let value = contract
        .and_then(|c| c.parameter.as_ref())
        .and_then(|p| p.value.as_ref());
    let is_native_transfer = contract
        .and_then(|c| c.contract_type.as_deref())
        .is_some_and(|t| t == "TransferContract");

    let ret = tx.ret.first();
    let status = match ret.and_then(|r| r.contract_ret.as_deref()) {
        Some("SUCCESS") => TxStatus::Confirmed,
        Some(_) => TxStatus::Failed,
        None => {
            if tx.block_number.is_some() {
                TxStatus::Confirmed
            } else {
                TxStatus::Pending
            }
        }
    };

    TransactionRecord {
        chain: ChainId::Tron,
        hash: tx.tx_id.clone(),
        from: value.and_then(|v| v.owner_address.clone()),
        to: value.and_then(|v| v.to_address.clone().or_else(|| v.contract_address.clone())),
        amount: if is_native_transfer {
            value.and_then(|v| v.amount).map(|a| a as u128)
        } else {
            None
        },
        token_address: value.and_then(|v| v.contract_address.clone()),
        fee: ret.and_then(|r| r.fee).map(|f| f as u128),
        status,
        block_height: tx.block_number,
        timestamp: tx.block_timestamp.map(|ms| ms / 1000),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct BroadcastResponse {
    #[serde(default)]
    pub result: bool,
    #[serde(default)]
    pub txid: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// ChainAdapter implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl ChainAdapter for TronAdapter {
    fn chain(&self) -> ChainId {
        ChainId::Tron
    }

    async fn get_native_balance(&self, address: &Address) -> Result<TokenBalance, AdapterError> {
        Self::check_chain(address)?;
        let account = self.fetch_account(address).await?;
        Ok(TokenBalance {
            symbol: "TRX".to_string(),
            decimals: ChainId::Tron.native_decimals(),
            // Неактивований акаунт (немає в мережі) — просто нульовий баланс.
            amount: account.map(|a| a.balance as u128).unwrap_or(0),
            token_address: None,
            usd_value: None,
        })
    }

    async fn get_token_balances(&self, address: &Address) -> Result<Vec<TokenBalance>, AdapterError> {
        Self::check_chain(address)?;
        let account = self.fetch_account(address).await?;
        Ok(account
            .map(|a| trc20_balances(&a, &self.tokens))
            .unwrap_or_default())
    }

    async fn estimate_fees(&self) -> Result<FeeEstimate, AdapterError> {
        let resp: ChainParametersResponse =
            self.post_json("/wallet/getchainparameters", json!({})).await?;
        Ok(fee_estimate_from_parameters(&resp.chain_parameter))
    }

    async fn build_transfer(
        &self,
        from: &Address,
        to: &Address,
        amount: u128,
        token: Option<&Address>,
    ) -> Result<TxRequest, AdapterError> {
        Self::check_chain(from)?;
        Self::check_chain(to)?;
        if amount == 0 {
            return Err(AdapterError::InvalidInput("amount must be > 0".into()));
        }
        // Інтент як у Bitcoin/Solana: серіалізація/підпис TRON-транзакції —
        // майбутня робота wallet-core (protobuf raw_data + sha256 + secp256k1).
        Ok(TxRequest {
            chain: ChainId::Tron,
            from: from.clone(),
            to: to.clone(),
            amount,
            token: token.cloned(),
            data: None,
            fee: None,
            nonce: None,
        })
    }

    async fn broadcast(&self, signed_tx: &[u8]) -> Result<String, AdapterError> {
        if signed_tx.is_empty() {
            return Err(AdapterError::InvalidInput("empty signed transaction".into()));
        }
        let resp: BroadcastResponse = self
            .post_json(
                "/wallet/broadcasthex",
                json!({ "transaction": hex::encode(signed_tx) }),
            )
            .await?;
        if resp.result {
            resp.txid
                .ok_or_else(|| AdapterError::Rpc {
                    code: 0,
                    message: "broadcast ok, але без txid".into(),
                })
        } else {
            Err(AdapterError::Rpc {
                code: 0,
                message: format!(
                    "{}: {}",
                    resp.code.unwrap_or_else(|| "BROADCAST_ERROR".into()),
                    resp.message.unwrap_or_default()
                ),
            })
        }
    }

    async fn get_transaction_history(
        &self,
        address: &Address,
        cursor: Option<String>,
    ) -> Result<(Vec<TransactionRecord>, Option<String>), AdapterError> {
        Self::check_chain(address)?;
        let mut path = format!(
            "/v1/accounts/{}/transactions?limit=25",
            address.as_str()
        );
        if let Some(fingerprint) = &cursor {
            path.push_str(&format!("&fingerprint={fingerprint}"));
        }
        let resp: TransactionsResponse = self.get_json(&path).await?;
        let records = resp.data.iter().map(tx_to_record).collect();
        Ok((records, resp.meta.fingerprint))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_account_and_balances() {
        let fixture = r#"{
            "data": [{
                "balance": 12500000,
                "trc20": [
                    {"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t": "25000000"},
                    {"TUnknownContractXXXXXXXXXXXXXXXXXX": "7"}
                ]
            }],
            "success": true
        }"#;
        let resp: AccountsResponse = serde_json::from_str(fixture).unwrap();
        let account = &resp.data[0];
        assert_eq!(account.balance, 12_500_000);

        let balances = trc20_balances(account, &default_tron_tokens());
        // Лише відомі токени: скам-/dust-контракти відфільтровано.
        assert_eq!(balances.len(), 1);
        let usdt = &balances[0];
        assert_eq!(usdt.symbol, "USDT");
        assert_eq!(usdt.amount, 25_000_000);
        assert_eq!(usdt.decimals, 6);
        assert_eq!(usdt.token_address.as_deref(), Some(USDT_TRC20));
    }

    #[test]
    fn empty_account_is_zero_not_error() {
        // Неактивована адреса: data порожня.
        let resp: AccountsResponse = serde_json::from_str(r#"{"data": [], "success": true}"#).unwrap();
        assert!(resp.data.is_empty());
    }

    #[test]
    fn parse_chain_parameters_into_fees() {
        let fixture = r#"{
            "chainParameter": [
                {"key": "getMaintenanceTimeInterval", "value": 21600000},
                {"key": "getTransactionFee", "value": 1000},
                {"key": "getEnergyFee", "value": 210}
            ]
        }"#;
        let resp: ChainParametersResponse = serde_json::from_str(fixture).unwrap();
        let est = fee_estimate_from_parameters(&resp.chain_parameter);
        let expected = FeeRate::TronResource {
            bandwidth_price_sun: 1000,
            energy_price_sun: 210,
        };
        assert_eq!(est.slow, expected);
        assert_eq!(est.standard, expected);
        assert_eq!(est.fast, expected);
    }

    #[test]
    fn missing_parameters_fall_back_to_defaults() {
        let est = fee_estimate_from_parameters(&[]);
        assert_eq!(
            est.standard,
            FeeRate::TronResource {
                bandwidth_price_sun: 1000,
                energy_price_sun: 210,
            }
        );
    }

    #[test]
    fn history_fixture_maps_native_and_trc20() {
        let fixture = r#"{
            "data": [
                {
                    "txID": "aaa111",
                    "block_number": 60000000,
                    "block_timestamp": 1720000000000,
                    "ret": [{"contractRet": "SUCCESS", "fee": 1100000}],
                    "raw_data": {
                        "contract": [{
                            "type": "TransferContract",
                            "parameter": {"value": {
                                "amount": 5000000,
                                "owner_address": "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
                                "to_address": "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"
                            }}
                        }]
                    }
                },
                {
                    "txID": "bbb222",
                    "block_number": 60000001,
                    "block_timestamp": 1720000010000,
                    "ret": [{"contractRet": "REVERT", "fee": 345000}],
                    "raw_data": {
                        "contract": [{
                            "type": "TriggerSmartContract",
                            "parameter": {"value": {
                                "owner_address": "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
                                "contract_address": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
                            }}
                        }]
                    }
                }
            ],
            "meta": {"fingerprint": "next-page-token"}
        }"#;
        let resp: TransactionsResponse = serde_json::from_str(fixture).unwrap();

        let native = tx_to_record(&resp.data[0]);
        assert_eq!(native.chain, ChainId::Tron);
        assert_eq!(native.amount, Some(5_000_000));
        assert_eq!(native.from.as_deref(), Some("TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6"));
        assert_eq!(native.to.as_deref(), Some("TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"));
        assert_eq!(native.status, TxStatus::Confirmed);
        assert_eq!(native.fee, Some(1_100_000));
        assert_eq!(native.timestamp, Some(1_720_000_000));

        // TRC-20 виклик: без суми (calldata не розбираємо), але з контрактом
        // і статусом REVERT → Failed.
        let trc20 = tx_to_record(&resp.data[1]);
        assert_eq!(trc20.amount, None);
        assert_eq!(trc20.token_address.as_deref(), Some(USDT_TRC20));
        assert_eq!(trc20.status, TxStatus::Failed);

        assert_eq!(resp.meta.fingerprint.as_deref(), Some("next-page-token"));
    }

    #[tokio::test]
    async fn build_transfer_validates_input() {
        let adapter = TronAdapter::default();
        let from = Address::tron("TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6").unwrap();
        let to = Address::tron("TJRabPrwbZy45sbavfcjinPJC18kjpRTv8").unwrap();

        let tx = adapter.build_transfer(&from, &to, 1_000_000, None).await.unwrap();
        assert_eq!(tx.chain, ChainId::Tron);
        assert_eq!(tx.amount, 1_000_000);

        assert!(adapter.build_transfer(&from, &to, 0, None).await.is_err());
    }

    #[test]
    fn tron_address_validation() {
        assert!(Address::tron("TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6").is_ok());
        assert!(Address::tron("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").is_ok());
        // Не 'T', закороткa, недопустимі символи base58.
        assert!(Address::tron("AWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6").is_err());
        assert!(Address::tron("Tshort").is_err());
        assert!(Address::tron("TWer2Ygk5TEheHp3TPuY0qxmB6SsGZmaL6").is_err());
        // EVM-адреса не проходить як TRON.
        assert!(Address::tron("0xd8da6bf26964af9d7eed9e03e53415d37aa96045").is_err());
    }
}
