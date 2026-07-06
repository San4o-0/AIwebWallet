//! DTO (request/response) для всіх ендпоінтів `/v1` за розділом 5 ТЗ.
//!
//! Типи переважно локальні; спільні типи chain-adapters використовуються
//! точково (FeeEstimate). Маппінг adapter → DTO живе у хендлерах.
//!
//! ПРАВИЛО БЕЗПЕКИ: жодне поле не приймає приватні ключі / seed / мнемоніку
//! (див. lib.rs і tests/security.rs).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Спільні типи
// ---------------------------------------------------------------------------

/// Мережа. Рядок, а не enum, поки не інтегровано chain-adapters.
/// Очікувані значення: "ethereum" | "polygon" | "bsc" | "arbitrum" | "base"
/// | "solana" | "bitcoin".
pub type Chain = String;

/// Запит транзакції (unsigned) — публічні дані, які надсилає розширення.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TxRequest {
    pub from: Option<String>,
    pub to: Option<String>,
    /// Значення у wei/lamports/sats, hex або десятковий рядок.
    pub value: Option<String>,
    /// Calldata (EVM) або серіалізоване повідомлення, hex з префіксом 0x.
    pub data: Option<String>,
    pub gas: Option<String>,
    pub max_fee_per_gas: Option<String>,
    pub max_priority_fee_per_gas: Option<String>,
    pub nonce: Option<String>,
    pub chain_id: Option<u64>,
}

// ---------------------------------------------------------------------------
// POST /v1/balances
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AddressBook {
    #[serde(default)]
    pub evm: Vec<String>,
    #[serde(default)]
    pub solana: Vec<String>,
    #[serde(default)]
    pub bitcoin: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalancesRequest {
    pub addresses: AddressBook,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBalance {
    pub symbol: String,
    pub name: String,
    /// None для нативної монети.
    pub contract_address: Option<String>,
    /// Кількість у мінімальних одиницях як рядок (щоб не втрачати точність).
    pub amount: String,
    pub decimals: u8,
    pub usd_value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainBalance {
    pub chain: Chain,
    pub address: String,
    pub native: TokenBalance,
    pub tokens: Vec<TokenBalance>,
    pub usd_value: f64,
    /// Помилка мережі (RPC недоступний/таймаут). Часткові фейли не валять
    /// відповідь (fail-safe, ТЗ §1.2): баланс нульовий, а причина — тут.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalancesResponse {
    /// Агрегований портфель у USD (F2.1).
    pub total_usd: f64,
    pub chains: Vec<ChainBalance>,
    /// Час оновлення цін (unix seconds) — ціни кешуються на бекенді (F2.5).
    pub prices_updated_at: u64,
}

// ---------------------------------------------------------------------------
// GET /v1/history?address=&chain=&cursor=
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryQuery {
    pub address: String,
    pub chain: Option<Chain>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

/// Категорія транзакції (F6.2).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TxCategory {
    Transfer,
    Swap,
    Approve,
    Mint,
    DappInteraction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub tx_hash: String,
    pub chain: Chain,
    /// Unix seconds.
    pub timestamp: u64,
    pub category: TxCategory,
    /// Людський опис транзакції (F3.6, F4.4).
    pub description: String,
    pub direction: String, // "in" | "out" | "self"
    pub amount: String,
    pub symbol: String,
    pub counterparty: Option<String>,
    pub fee_usd: f64,
    pub status: String, // "confirmed" | "pending" | "failed"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryResponse {
    pub items: Vec<HistoryItem>,
    pub next_cursor: Option<String>,
    /// Службова примітка (напр., «історія EVM потребує ETHERSCAN_API_KEY»).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// POST /v1/tx/decode
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct DecodeRequest {
    pub chain: Chain,
    /// Сира підписана/непідписана транзакція (hex) — АБО tx_request.
    pub raw_tx: Option<String>,
    pub tx_request: Option<TxRequest>,
}

/// Структурований розбір транзакції. Використовується і як відповідь
/// /tx/decode, і як вхід /tx/explain.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DecodedTx {
    pub chain: Chain,
    /// Тип дії: "native_transfer" | "erc20_transfer" | "approve"
    /// | "contract_call" | ...
    pub action: String,
    /// 4-байтовий селектор функції (EVM), напр. "0x095ea7b3".
    pub selector: Option<String>,
    /// Ім'я методу, якщо відоме (4byte/Sourcify).
    pub method: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    /// Адреса контракту токена (для токен-операцій).
    pub contract_address: Option<String>,
    /// Людсько-читана сума (вже з урахуванням decimals), напр. "150.5".
    pub amount: Option<String>,
    pub symbol: Option<String>,
    /// Для approve: кому надається дозвіл.
    pub spender: Option<String>,
    /// Для approve: чи є дозвіл необмеженим (unlimited).
    pub unlimited: Option<bool>,
    /// Розібрані параметри виклику.
    #[serde(default)]
    pub params: Vec<DecodedParam>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodedParam {
    pub name: String,
    pub kind: String,
    pub value: String,
}

// ---------------------------------------------------------------------------
// POST /v1/tx/simulate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct SimulateRequest {
    pub chain: Chain,
    pub tx_request: TxRequest,
    /// Публічна адреса підписанта.
    pub signer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceChange {
    pub address: String,
    /// Людська назва активу ("Ether", "USD Coin", ...).
    #[serde(default)]
    pub asset: String,
    pub symbol: String,
    pub contract_address: Option<String>,
    pub before: String,
    pub after: String,
    /// Дельта зі знаком, людсько-читана, напр. "-150.5".
    pub delta: String,
    pub usd_delta: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SimulateResponse {
    pub success: bool,
    /// `true` — зміни балансів пораховані реально (детермінована симуляція
    /// або Alchemy). `false` — метод не розпізнано, у `warnings` пояснення.
    pub simulated: bool,
    /// `true`, якщо eth_call / simulateTransaction показав revert (F4.3).
    pub will_revert: bool,
    /// Очікувані зміни балансів «до/після» (F4.3).
    pub balance_changes: Vec<BalanceChange>,
    #[serde(default)]
    pub warnings: Vec<String>,
    pub gas_used: Option<String>,
    pub gas_cost_usd: Option<f64>,
    /// Причина revert, якщо симуляція провалилась.
    pub revert_reason: Option<String>,
}

// ---------------------------------------------------------------------------
// POST /v1/tx/risk
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct RiskRequest {
    pub chain: Chain,
    pub tx_request: TxRequest,
    /// Origin dApp, що ініціював запит (для перевірки фішингових доменів).
    pub dapp_origin: Option<String>,
    /// Метод підпису: "eth_sendTransaction" | "eth_sign"
    /// | "eth_signTypedData_v4" | "personal_sign" | ...
    pub sign_method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskReasonDto {
    /// Машинний код причини, напр. "unlimited_approve".
    pub code: String,
    /// Пояснення українською.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskResponse {
    /// "low" | "medium" | "high" (F5.1).
    pub level: String,
    pub reasons: Vec<RiskReasonDto>,
    /// Червоний рівень вимагає підтвердження «Розумію ризик» (F5.3).
    pub requires_confirmation: bool,
}

// ---------------------------------------------------------------------------
// POST /v1/tx/explain
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ExplainRequest {
    pub decoded: DecodedTx,
    pub simulation: Option<SimulateResponse>,
    pub risk: Option<RiskResponse>,
    /// "uk" (default) | "en" (F4.5).
    pub lang: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainResponse {
    /// 1–3 речення простою мовою (F4.1).
    pub explanation: String,
    /// Джерело: "rule_based" | "ai".
    pub source: String,
    pub lang: String,
}

// ---------------------------------------------------------------------------
// POST /v1/tx/broadcast
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct BroadcastRequest {
    pub chain: Chain,
    /// Уже ПІДПИСАНА транзакція (hex/base64). Підпис відбувається виключно
    /// в розширенні (Rust/WASM) — бекенд ключів не бачить.
    pub signed_tx: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BroadcastResponse {
    pub tx_hash: String,
    pub chain: Chain,
    pub status: String, // "pending"
}

// ---------------------------------------------------------------------------
// POST /v1/chat (SSE)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    /// Публічні адреси користувача — контекст для function calling (F7.2).
    #[serde(default)]
    pub addresses: Vec<String>,
}

// ---------------------------------------------------------------------------
// GET /v1/analytics/fees, GET /v1/analytics/summary
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct AnalyticsQuery {
    pub address: String,
    /// "7d" | "30d" | "90d" | "1y" (F6.1).
    pub period: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainFees {
    pub chain: Chain,
    pub fees_usd: f64,
    pub tx_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeePoint {
    /// Unix seconds (початок дня).
    pub date: u64,
    pub fees_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeesResponse {
    pub address: String,
    pub period: String,
    pub total_fees_usd: f64,
    pub by_chain: Vec<ChainFees>,
    pub timeline: Vec<FeePoint>,
    /// Службова примітка (напр., EVM-мережі пропущено без ETHERSCAN_API_KEY).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategorySummary {
    pub category: TxCategory,
    pub tx_count: u32,
    pub volume_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryResponse {
    pub address: String,
    pub period: String,
    pub total_in_usd: f64,
    pub total_out_usd: f64,
    pub total_fees_usd: f64,
    pub tx_count: u32,
    pub by_category: Vec<CategorySummary>,
    pub by_chain: Vec<ChainFees>,
    /// Службова примітка (напр., EVM-мережі пропущено без ETHERSCAN_API_KEY).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// GET /v1/prices?ids=
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct PricesQuery {
    /// CoinGecko ids через кому: "ethereum,solana,bitcoin".
    pub ids: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceInfo {
    pub usd: f64,
    pub usd_24h_change: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PricesResponse {
    pub prices: HashMap<String, PriceInfo>,
    pub updated_at: u64,
}

// ---------------------------------------------------------------------------
// GET /v1/fees?chain=
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct FeeEstimateQuery {
    /// "ethereum" | "polygon" | ... | "solana" | "bitcoin".
    pub chain: Chain,
}

/// Три рівні комісії (slow/standard/fast, F3.2–F3.4) у нативних одиницях
/// мережі — формат `chain_adapters::FeeEstimate` (eip1559 / sat_per_vbyte /
/// solana priority).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeEstimateResponse {
    pub chain: Chain,
    pub estimate: chain_adapters::FeeEstimate,
    /// Unix seconds.
    pub updated_at: u64,
}

// ---------------------------------------------------------------------------
// GET /v1/health
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}
