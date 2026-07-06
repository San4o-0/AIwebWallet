//! POST /v1/tx/* — decode, simulate, risk, explain, broadcast.
//!
//! РЕАЛЬНА логіка вже зараз: `risk` (rule-based risk-engine) та `explain`
//! (rule-based шаблони). Решта — мок із TODO.

use axum::{extract::State, Json};
use base64::Engine as _;
use std::sync::Arc;
use std::time::Duration;

use chain_adapters::ChainId;

use crate::dto::{
    BalanceChange, BroadcastRequest, BroadcastResponse, DecodeRequest, DecodedParam,
    DecodedTx, ExplainRequest, ExplainResponse, RiskReasonDto, RiskRequest, RiskResponse,
    SimulateRequest, SimulateResponse,
};
use crate::handlers::ApiError;
use crate::risk::{parse_approve_calldata, RiskInput, RiskLevel, ERC20_TRANSFER_SELECTOR};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// POST /v1/tx/decode
// ---------------------------------------------------------------------------

pub async fn decode(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<DecodeRequest>,
) -> Json<DecodedTx> {
    // TODO: tx-service — повне декодування: ABI відомих контрактів (Sourcify),
    // сигнатури 4byte, permit/setApprovalForAll, Solana-інструкції відомих
    // програм, розбір raw_tx (RLP/base64) через Alloy / solana-transaction-status.
    //
    // Зараз: спрощена класифікація calldata (approve / ERC-20 transfer /
    // нативний переказ) + мок для решти полів (symbol/amount потребують
    // метаданих токена з індексера).
    let tx = req.tx_request.unwrap_or_default();
    let data = tx.data.clone().unwrap_or_default();
    let hex = data.strip_prefix("0x").unwrap_or(&data);

    let mut decoded = DecodedTx {
        chain: req.chain,
        from: tx.from.clone(),
        to: tx.to.clone(),
        ..Default::default()
    };

    if hex.is_empty() {
        decoded.action = "native_transfer".into();
        decoded.amount = tx.value.clone();
        decoded.symbol = Some("ETH".into()); // TODO: нативний символ мережі.
    } else if let Some(approve) = parse_approve_calldata(&data) {
        decoded.action = "approve".into();
        decoded.selector = Some("0x095ea7b3".into());
        decoded.method = Some("approve(address,uint256)".into());
        decoded.contract_address = tx.to.clone();
        decoded.spender = Some(approve.spender.clone());
        decoded.unlimited = Some(approve.is_effectively_unlimited());
        decoded.symbol = Some("TOKEN".into()); // TODO: метадані токена.
        decoded.params = vec![
            DecodedParam {
                name: "spender".into(),
                kind: "address".into(),
                value: approve.spender,
            },
            DecodedParam {
                name: "value".into(),
                kind: "uint256".into(),
                value: format!("0x{}", hex::encode(approve.value)),
            },
        ];
    } else if hex.len() >= 8 && hex[..8].eq_ignore_ascii_case(ERC20_TRANSFER_SELECTOR) {
        decoded.action = "erc20_transfer".into();
        decoded.selector = Some("0xa9059cbb".into());
        decoded.method = Some("transfer(address,uint256)".into());
        decoded.contract_address = tx.to.clone();
        decoded.symbol = Some("TOKEN".into()); // TODO: метадані токена.
    } else {
        decoded.action = "contract_call".into();
        decoded.selector = hex.get(..8).map(|s| format!("0x{s}"));
        decoded
            .warnings
            .push("Метод не розпізнано — потрібне ABI-декодування".into());
    }

    Json(decoded)
}

// ---------------------------------------------------------------------------
// POST /v1/tx/simulate
// ---------------------------------------------------------------------------

pub async fn simulate(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<SimulateRequest>,
) -> Json<SimulateResponse> {
    // TODO: tx-service — Alchemy simulateAssetChanges / Tenderly (EVM),
    // simulateTransaction (Solana); для BTC — розрахунок UTXO/комісії.
    Json(SimulateResponse {
        success: true,
        balance_changes: vec![
            BalanceChange {
                address: req.signer.clone(),
                symbol: "ETH".into(),
                contract_address: None,
                before: "1.25".into(),
                after: "1.0489".into(),
                delta: "-0.2011".into(),
                usd_delta: -703.85,
            },
            BalanceChange {
                address: req.signer,
                symbol: "USDC".into(),
                contract_address: Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()),
                before: "532.10".into(),
                after: "1230.50".into(),
                delta: "+698.40".into(),
                usd_delta: 698.40,
            },
        ],
        gas_used: Some("142500".into()),
        gas_cost_usd: Some(3.85),
        revert_reason: None,
    })
}

// ---------------------------------------------------------------------------
// POST /v1/tx/risk — РЕАЛЬНА rule-based логіка (F5.1–F5.5)
// ---------------------------------------------------------------------------

pub async fn risk(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RiskRequest>,
) -> Json<RiskResponse> {
    let input = RiskInput {
        to: req.tx_request.to.clone(),
        data: req.tx_request.data.clone(),
        sign_method: req.sign_method.clone(),
        dapp_origin: req.dapp_origin.clone(),
    };

    let assessment = state.risk_engine.assess(&input);

    Json(RiskResponse {
        level: assessment.level.as_str().to_string(),
        reasons: assessment
            .reasons
            .into_iter()
            .map(|r| RiskReasonDto {
                code: r.code.to_string(),
                message: r.message,
            })
            .collect(),
        // Червоний рівень вимагає підтвердження «Розумію ризик» (F5.3).
        requires_confirmation: assessment.level == RiskLevel::High,
    })
}

// ---------------------------------------------------------------------------
// POST /v1/tx/explain — rule-based шаблони + OpenAI для нетривіальних (F4.1)
// ---------------------------------------------------------------------------

pub async fn explain(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ExplainRequest>,
) -> Json<ExplainResponse> {
    // Провайдер сам вирішує (ТЗ 4.3): тривіальні транзакції — шаблоном без
    // API; нетривіальні/high-risk — OpenAI gpt-4o-mini з таймаутом 10 с і
    // внутрішнім fallback на rule-based. Err тут — лише «нема ключа».
    match state.ai_explainer.explain(&req).await {
        Ok(resp) => Json(resp),
        Err(_) => {
            // Fail-safe: rule-based завжди відповідає (ТЗ 1.2).
            Json(state.rule_based_explainer.explain_sync(&req))
        }
    }
}

// ---------------------------------------------------------------------------
// POST /v1/tx/broadcast
// ---------------------------------------------------------------------------

/// Реальна трансляція в мережу через chain-adapters:
/// eth_sendRawTransaction (EVM), sendTransaction (Solana),
/// POST /tx mempool.space (BTC). Вхід — ТІЛЬКИ підписана транзакція
/// (без ключів); підпис відбувається у розширенні.
/// TODO: ретраї та відстеження статусу після трансляції.
pub async fn broadcast(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BroadcastRequest>,
) -> Result<Json<BroadcastResponse>, ApiError> {
    let chain: ChainId = req
        .chain
        .parse()
        .map_err(|_| ApiError::bad_request(format!("невідома мережа: {}", req.chain)))?;

    let signed_tx = decode_signed_tx(chain, &req.signed_tx)?;
    let adapter = state.adapter(chain);

    let tx_hash = tokio::time::timeout(BROADCAST_TIMEOUT, adapter.broadcast(&signed_tx))
        .await
        .map_err(|_| {
            ApiError::bad_gateway(format!(
                "{chain}: таймаут трансляції ({} с)",
                BROADCAST_TIMEOUT.as_secs()
            ))
        })??;

    Ok(Json(BroadcastResponse {
        tx_hash,
        chain: chain.to_string(),
        status: "pending".into(),
    }))
}

const BROADCAST_TIMEOUT: Duration = Duration::from_secs(10);

/// Декодує підписану транзакцію: hex (з/без `0x`) для EVM/Bitcoin,
/// base64 або hex для Solana.
pub(crate) fn decode_signed_tx(chain: ChainId, signed: &str) -> Result<Vec<u8>, ApiError> {
    let trimmed = signed.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("порожня підписана транзакція"));
    }
    if let Some(hex_body) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return hex::decode(hex_body)
            .map_err(|e| ApiError::bad_request(format!("некоректний hex: {e}")));
    }
    match chain {
        // Solana-транзакції традиційно передаються в base64.
        ChainId::Solana => base64::engine::general_purpose::STANDARD
            .decode(trimmed)
            .or_else(|_| hex::decode(trimmed))
            .map_err(|_| ApiError::bad_request("очікується base64 або hex")),
        // EVM/Bitcoin — сирий hex без префікса.
        _ => hex::decode(trimmed)
            .map_err(|e| ApiError::bad_request(format!("некоректний hex: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_signed_tx_evm_hex() {
        assert_eq!(
            decode_signed_tx(ChainId::Ethereum, "0x02f870").unwrap(),
            vec![0x02, 0xf8, 0x70]
        );
        assert_eq!(
            decode_signed_tx(ChainId::Bitcoin, "0200aa").unwrap(),
            vec![0x02, 0x00, 0xaa]
        );
        assert!(decode_signed_tx(ChainId::Ethereum, "0xZZ").is_err());
        assert!(decode_signed_tx(ChainId::Ethereum, "").is_err());
    }

    #[test]
    fn decode_signed_tx_solana_base64_and_hex() {
        // base64("hello") = aGVsbG8=
        assert_eq!(
            decode_signed_tx(ChainId::Solana, "aGVsbG8=").unwrap(),
            b"hello".to_vec()
        );
        // hex теж приймається.
        assert_eq!(
            decode_signed_tx(ChainId::Solana, "0x0102").unwrap(),
            vec![1, 2]
        );
        assert!(decode_signed_tx(ChainId::Solana, "!!!не-base64!!!").is_err());
    }
}
