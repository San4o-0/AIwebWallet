//! POST /v1/tx/* — decode, simulate, risk, explain, broadcast.
//!
//! РЕАЛЬНА логіка вже зараз: `risk` (rule-based risk-engine) та `explain`
//! (rule-based шаблони). Решта — мок із TODO.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::dto::{
    BalanceChange, BroadcastRequest, BroadcastResponse, DecodeRequest, DecodedParam,
    DecodedTx, ExplainRequest, ExplainResponse, RiskReasonDto, RiskRequest, RiskResponse,
    SimulateRequest, SimulateResponse,
};
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
                value: format!("0x{}", hex::encode_32(&approve.value)),
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

/// Мінімальний hex-encode без зовнішнього крейта.
mod hex {
    pub fn encode_32(bytes: &[u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
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
// POST /v1/tx/explain — РЕАЛЬНА rule-based логіка + AI-заглушка (F4.1)
// ---------------------------------------------------------------------------

pub async fn explain(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ExplainRequest>,
) -> Json<ExplainResponse> {
    // TODO: для нетривіальних транзакцій викликати OpenAI (gpt-4o-mini через
    // async-openai) з таймаутом 10 с; стандартні випадки — завжди шаблоном
    // без API (ТЗ 4.3). Зараз AI-провайдер — заглушка, тому працює fallback.
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

pub async fn broadcast(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<BroadcastRequest>,
) -> Json<BroadcastResponse> {
    // TODO: tx-service — трансляція в мережу: eth_sendRawTransaction (Alloy),
    // sendTransaction (Solana), mempool.space POST /tx (BTC); ретраї,
    // відстеження статусу. Вхід — ТІЛЬКИ підписана транзакція (без ключів).
    Json(BroadcastResponse {
        tx_hash: "0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2".into(),
        chain: req.chain,
        status: "pending".into(),
    })
}
