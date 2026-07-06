//! GET /v1/tx/params?chain=&from=[&token=1] — параметри для збірки
//! EIP-1559 транзакції у розширенні: nonce, оцінка gas limit, три рівні
//! комісій та EIP-155 chain_id.
//!
//! Реальні дані з ноди: `eth_getTransactionCount` (pending) +
//! `eth_feeHistory` через реєстр chain-adapters. Gas limit — консервативний
//! дефолт (21000 нативний переказ / 65000 ERC-20 transfer); точніший
//! `eth_estimateGas` — TODO, коли форма запиту включатиме calldata.

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use chain_adapters::{Address, ChainId, FeeRate};

use crate::handlers::{now_secs, ApiError};
use crate::state::AppState;

const PARAMS_TIMEOUT: Duration = Duration::from_secs(5);

/// Дефолтні ліміти газу без `eth_estimateGas`.
const GAS_LIMIT_NATIVE: u64 = 21_000;
const GAS_LIMIT_ERC20: u64 = 65_000;

// --- DTO (локальні для цього хендлера; dto.rs не чіпаємо) ------------------

#[derive(Debug, Deserialize)]
pub struct TxParamsQuery {
    /// Мережа (`ethereum` | `polygon` | `bsc` | `arbitrum` | `base`).
    pub chain: String,
    /// Адреса відправника (`0x…`).
    pub from: String,
    /// Непорожнє значення (`1`/`true`) — переказ ERC-20: інший дефолт gas.
    #[serde(default)]
    pub token: Option<String>,
}

/// Один рівень комісії EIP-1559. Значення — десяткові рядки у wei
/// (u128 не влазить у JS number без втрат).
#[derive(Debug, Serialize)]
pub struct FeeTierDto {
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
}

#[derive(Debug, Serialize)]
pub struct TxParamsFeesDto {
    pub slow: FeeTierDto,
    pub standard: FeeTierDto,
    pub fast: FeeTierDto,
}

#[derive(Debug, Serialize)]
pub struct TxParamsResponse {
    pub chain: String,
    /// Числовий EIP-155 chain id (1 / 137 / 56 / 42161 / 8453).
    pub chain_id: u64,
    /// Наступний nonce акаунта (pending).
    pub nonce: u64,
    /// Рекомендований gas limit (десятковий рядок).
    pub gas_limit_estimate: String,
    pub fees: TxParamsFeesDto,
    pub updated_at: u64,
}

fn fee_tier(rate: &FeeRate, chain: ChainId) -> Result<FeeTierDto, ApiError> {
    match rate {
        FeeRate::Eip1559 {
            max_fee_per_gas,
            max_priority_fee_per_gas,
        } => Ok(FeeTierDto {
            max_fee_per_gas: max_fee_per_gas.to_string(),
            max_priority_fee_per_gas: max_priority_fee_per_gas.to_string(),
        }),
        other => Err(ApiError::bad_gateway(format!(
            "{chain}: очікував EIP-1559 комісії, отримав {other:?}"
        ))),
    }
}

pub async fn tx_params(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TxParamsQuery>,
) -> Result<Json<TxParamsResponse>, ApiError> {
    let chain: ChainId = q
        .chain
        .parse()
        .map_err(|_| ApiError::bad_request(format!("невідома мережа: {}", q.chain)))?;
    let chain_id = chain
        .evm_chain_id()
        .ok_or_else(|| ApiError::bad_request(format!("{chain}: /tx/params підтримує лише EVM-мережі")))?;
    let from = Address::new(chain, q.from.as_str())?;

    let is_token = q
        .token
        .as_deref()
        .is_some_and(|v| !v.is_empty() && v != "0" && v != "false");

    let adapter = state.adapter(chain);
    // Nonce і комісії — паралельно, зі спільним таймаутом.
    let (nonce, fees) = tokio::time::timeout(PARAMS_TIMEOUT, async {
        tokio::try_join!(adapter.get_transaction_count(&from), adapter.estimate_fees())
    })
    .await
    .map_err(|_| {
        ApiError::bad_gateway(format!(
            "{chain}: таймаут запиту параметрів ({} с)",
            PARAMS_TIMEOUT.as_secs()
        ))
    })??;

    Ok(Json(TxParamsResponse {
        chain: chain.to_string(),
        chain_id,
        nonce,
        gas_limit_estimate: if is_token { GAS_LIMIT_ERC20 } else { GAS_LIMIT_NATIVE }.to_string(),
        fees: TxParamsFeesDto {
            slow: fee_tier(&fees.slow, chain)?,
            standard: fee_tier(&fees.standard, chain)?,
            fast: fee_tier(&fees.fast, chain)?,
        },
        updated_at: now_secs(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_tier_serializes_eip1559_as_decimal_strings() {
        let tier = fee_tier(
            &FeeRate::Eip1559 {
                max_fee_per_gas: 30_000_000_000,
                max_priority_fee_per_gas: 1_500_000_000,
            },
            ChainId::Ethereum,
        )
        .unwrap();
        assert_eq!(tier.max_fee_per_gas, "30000000000");
        assert_eq!(tier.max_priority_fee_per_gas, "1500000000");

        // Bitcoin-тариф у EVM-контексті — помилка формату, не паніка.
        assert!(fee_tier(
            &FeeRate::BitcoinSatPerVb { sat_per_vbyte: 10 },
            ChainId::Ethereum
        )
        .is_err());
    }
}
