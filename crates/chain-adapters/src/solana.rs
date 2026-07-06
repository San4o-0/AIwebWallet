//! Solana adapter over plain JSON-RPC HTTP (`reqwest` + hand-rolled request
//! types — deliberately avoids the heavy `solana-client` dependency tree).
//!
//! Methods used: `getBalance`, `getTokenAccountsByOwner` (jsonParsed),
//! `getRecentPrioritizationFees`, `sendTransaction`, `getSignaturesForAddress`.

use async_trait::async_trait;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;

use crate::error::AdapterError;
use crate::jsonrpc::JsonRpcClient;
use crate::types::{
    Address, ChainId, FeeEstimate, FeeRate, TokenBalance, TransactionRecord, TxRequest, TxStatus,
};
use crate::ChainAdapter;

/// SPL Token program id.
pub const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/// Base fee per signature, in lamports (network constant).
pub const BASE_FEE_LAMPORTS: u64 = 5_000;
/// History page size.
const HISTORY_PAGE_LIMIT: usize = 25;

/// Adapter for Solana mainnet/devnet (depends on `rpc_url`).
#[derive(Debug, Clone)]
pub struct SolanaAdapter {
    rpc: JsonRpcClient,
}

impl SolanaAdapter {
    pub fn new(rpc_url: impl Into<String>) -> Self {
        SolanaAdapter {
            rpc: JsonRpcClient::new(rpc_url),
        }
    }

    fn check_chain(address: &Address) -> Result<(), AdapterError> {
        if address.chain() == ChainId::Solana {
            Ok(())
        } else {
            Err(AdapterError::InvalidInput(format!(
                "address belongs to {}, adapter serves solana",
                address.chain()
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// Response shapes (unit-tested against fixtures)
// ---------------------------------------------------------------------------

/// Solana wraps most results in `{ context, value }`.
#[derive(Debug, Deserialize)]
pub(crate) struct RpcEnvelope<T> {
    pub value: T,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TokenAccountEntry {
    pub account: TokenAccount,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TokenAccount {
    pub data: TokenAccountData,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TokenAccountData {
    pub parsed: ParsedTokenData,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ParsedTokenData {
    pub info: ParsedTokenInfo,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ParsedTokenInfo {
    pub mint: String,
    #[serde(rename = "tokenAmount")]
    pub token_amount: ParsedTokenAmount,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ParsedTokenAmount {
    /// Base-unit amount as a decimal string.
    pub amount: String,
    pub decimals: u8,
}

/// Convert parsed token accounts into [`TokenBalance`]s, skipping zero balances.
///
/// Symbol resolution requires off-chain token metadata (token list / Helius),
/// so adapters report the placeholder symbol `"SPL"` with the mint in
/// `token_address`; the balance-service enriches symbols later.
pub(crate) fn token_accounts_to_balances(
    entries: &[TokenAccountEntry],
) -> Result<Vec<TokenBalance>, AdapterError> {
    let mut out = Vec::new();
    for entry in entries {
        let info = &entry.account.data.parsed.info;
        let amount: u128 = info
            .token_amount
            .amount
            .parse()
            .map_err(|e| AdapterError::parse(format!("bad token amount: {e}")))?;
        if amount == 0 {
            continue;
        }
        out.push(TokenBalance {
            symbol: "SPL".to_string(),
            decimals: info.token_amount.decimals,
            amount,
            token_address: Some(info.mint.clone()),
            usd_value: None,
        });
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub(crate) struct PrioritizationFee {
    #[serde(rename = "prioritizationFee")]
    pub prioritization_fee: u64,
}

/// Build slow/standard/fast tiers from recent prioritization fees
/// (25th / 50th / 90th percentile of observed compute-unit prices).
pub(crate) fn fee_estimate_from_prioritization(fees: &[PrioritizationFee]) -> FeeEstimate {
    let mut values: Vec<u64> = fees.iter().map(|f| f.prioritization_fee).collect();
    values.sort_unstable();

    let percentile = |p: f64| -> u64 {
        if values.is_empty() {
            return 0;
        }
        let idx = ((values.len() - 1) as f64 * p).round() as usize;
        values[idx]
    };

    // Defaults when the RPC reports no data (quiet network): a small non-zero
    // priority fee for standard/fast so transactions still land promptly.
    let (slow, standard, fast) = if values.iter().all(|v| *v == 0) {
        (0, 1_000, 10_000)
    } else {
        (percentile(0.25), percentile(0.50), percentile(0.90))
    };

    let make = |priority: u64| FeeRate::SolanaPriority {
        base_fee_lamports: BASE_FEE_LAMPORTS,
        priority_fee_micro_lamports: priority,
    };
    FeeEstimate {
        slow: make(slow),
        standard: make(standard),
        fast: make(fast),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct SignatureInfo {
    pub signature: String,
    pub slot: u64,
    /// Non-null when the transaction failed.
    pub err: Option<serde_json::Value>,
    #[serde(rename = "blockTime")]
    pub block_time: Option<i64>,
    #[serde(rename = "confirmationStatus")]
    pub confirmation_status: Option<String>,
}

pub(crate) fn signature_to_record(address: &str, info: &SignatureInfo) -> TransactionRecord {
    let status = if info.err.is_some() {
        TxStatus::Failed
    } else {
        match info.confirmation_status.as_deref() {
            Some("finalized") | Some("confirmed") => TxStatus::Confirmed,
            Some("processed") => TxStatus::Pending,
            _ => TxStatus::Unknown,
        }
    };
    TransactionRecord {
        chain: ChainId::Solana,
        hash: info.signature.clone(),
        // getSignaturesForAddress does not expose counterparties or amounts;
        // full decoding needs getTransaction / an indexer (Helius) upstream.
        from: Some(address.to_string()),
        to: None,
        amount: None,
        token_address: None,
        fee: None,
        status,
        block_height: Some(info.slot),
        timestamp: info.block_time.and_then(|t| u64::try_from(t).ok()),
    }
}

// ---------------------------------------------------------------------------
// ChainAdapter implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl ChainAdapter for SolanaAdapter {
    fn chain(&self) -> ChainId {
        ChainId::Solana
    }

    async fn get_native_balance(&self, address: &Address) -> Result<TokenBalance, AdapterError> {
        Self::check_chain(address)?;
        let lamports: RpcEnvelope<u64> = self
            .rpc
            .call("getBalance", json!([address.as_str()]))
            .await?;
        Ok(TokenBalance {
            symbol: "SOL".to_string(),
            decimals: ChainId::Solana.native_decimals(),
            amount: lamports.value as u128,
            token_address: None,
            usd_value: None,
        })
    }

    async fn get_token_balances(&self, address: &Address) -> Result<Vec<TokenBalance>, AdapterError> {
        Self::check_chain(address)?;
        let accounts: RpcEnvelope<Vec<TokenAccountEntry>> = self
            .rpc
            .call(
                "getTokenAccountsByOwner",
                json!([
                    address.as_str(),
                    { "programId": SPL_TOKEN_PROGRAM_ID },
                    { "encoding": "jsonParsed" }
                ]),
            )
            .await?;
        token_accounts_to_balances(&accounts.value)
    }

    async fn estimate_fees(&self) -> Result<FeeEstimate, AdapterError> {
        let fees: Vec<PrioritizationFee> = self
            .rpc
            .call("getRecentPrioritizationFees", json!([]))
            .await?;
        Ok(fee_estimate_from_prioritization(&fees))
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
        if let Some(mint) = token {
            Self::check_chain(mint)?;
        }
        // Message compilation (recent blockhash, SystemProgram / SPL Token
        // instructions) and signing are done by wallet-core; this is the
        // chain-agnostic transfer intent.
        Ok(TxRequest {
            chain: ChainId::Solana,
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
        let encoded = base64::engine::general_purpose::STANDARD.encode(signed_tx);
        let signature: String = self
            .rpc
            .call("sendTransaction", json!([encoded, { "encoding": "base64" }]))
            .await?;
        Ok(signature)
    }

    async fn get_transaction_history(
        &self,
        address: &Address,
        cursor: Option<String>,
    ) -> Result<(Vec<TransactionRecord>, Option<String>), AdapterError> {
        Self::check_chain(address)?;
        let mut options = json!({ "limit": HISTORY_PAGE_LIMIT });
        if let Some(before) = &cursor {
            options["before"] = json!(before);
        }
        let signatures: Vec<SignatureInfo> = self
            .rpc
            .call("getSignaturesForAddress", json!([address.as_str(), options]))
            .await?;

        let records: Vec<TransactionRecord> = signatures
            .iter()
            .map(|s| signature_to_record(address.as_str(), s))
            .collect();
        let next_cursor = if signatures.len() == HISTORY_PAGE_LIMIT {
            signatures.last().map(|s| s.signature.clone())
        } else {
            None
        };
        Ok((records, next_cursor))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_get_balance_envelope() {
        let fixture = r#"{ "context": { "slot": 312041331 }, "value": 158639624 }"#;
        let parsed: RpcEnvelope<u64> = serde_json::from_str(fixture).unwrap();
        assert_eq!(parsed.value, 158_639_624);
    }

    #[test]
    fn parse_token_accounts_fixture() {
        let fixture = r#"{
          "context": { "slot": 312041331 },
          "value": [
            {
              "pubkey": "C2gJg6tKpQs41PRS1nC8aw3ZKNZK3HQQZGVrDFDup5nx",
              "account": {
                "lamports": 2039280,
                "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "data": {
                  "program": "spl-token",
                  "parsed": {
                    "type": "account",
                    "info": {
                      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                      "owner": "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
                      "tokenAmount": {
                        "amount": "42750000",
                        "decimals": 6,
                        "uiAmount": 42.75,
                        "uiAmountString": "42.75"
                      }
                    }
                  }
                }
              }
            },
            {
              "pubkey": "9zGHzGDdSKn41ZQg2VBw2sCJGjLqyPQzSZYNM2mGV6cT",
              "account": {
                "lamports": 2039280,
                "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "data": {
                  "program": "spl-token",
                  "parsed": {
                    "type": "account",
                    "info": {
                      "mint": "So11111111111111111111111111111111111111112",
                      "owner": "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
                      "tokenAmount": {
                        "amount": "0",
                        "decimals": 9,
                        "uiAmount": 0.0,
                        "uiAmountString": "0"
                      }
                    }
                  }
                }
              }
            }
          ]
        }"#;
        let parsed: RpcEnvelope<Vec<TokenAccountEntry>> = serde_json::from_str(fixture).unwrap();
        let balances = token_accounts_to_balances(&parsed.value).unwrap();
        // Zero balance is filtered out.
        assert_eq!(balances.len(), 1);
        assert_eq!(balances[0].amount, 42_750_000);
        assert_eq!(balances[0].decimals, 6);
        assert_eq!(
            balances[0].token_address.as_deref(),
            Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        );
        assert_eq!(balances[0].symbol, "SPL");
    }

    #[test]
    fn prioritization_fee_percentiles() {
        let fixture = r#"[
            { "slot": 348125, "prioritizationFee": 0 },
            { "slot": 348126, "prioritizationFee": 1000 },
            { "slot": 348127, "prioritizationFee": 2000 },
            { "slot": 348128, "prioritizationFee": 10000 },
            { "slot": 348129, "prioritizationFee": 100000 }
        ]"#;
        let fees: Vec<PrioritizationFee> = serde_json::from_str(fixture).unwrap();
        let est = fee_estimate_from_prioritization(&fees);
        match (est.slow, est.standard, est.fast) {
            (
                FeeRate::SolanaPriority {
                    priority_fee_micro_lamports: slow,
                    base_fee_lamports,
                },
                FeeRate::SolanaPriority {
                    priority_fee_micro_lamports: standard,
                    ..
                },
                FeeRate::SolanaPriority {
                    priority_fee_micro_lamports: fast,
                    ..
                },
            ) => {
                assert_eq!(base_fee_lamports, BASE_FEE_LAMPORTS);
                assert_eq!(slow, 1000); // p25
                assert_eq!(standard, 2000); // p50
                assert_eq!(fast, 100000); // p90 -> last element
                assert!(slow <= standard && standard <= fast);
            }
            other => panic!("expected Solana tiers, got {other:?}"),
        }
    }

    #[test]
    fn prioritization_fee_defaults_when_all_zero() {
        let est = fee_estimate_from_prioritization(&[]);
        match est.fast {
            FeeRate::SolanaPriority {
                priority_fee_micro_lamports,
                ..
            } => assert_eq!(priority_fee_micro_lamports, 10_000),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parse_signatures_and_map_records() {
        let fixture = r#"[
            {
                "signature": "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
                "slot": 114,
                "err": null,
                "memo": null,
                "blockTime": 1720526751,
                "confirmationStatus": "finalized"
            },
            {
                "signature": "4bxsSXhPjidGyXipze5WYCFbLLcZs2mObjTKG9UlegtitFxOoAY7yWXW14PGYbXAWP2RfkzKkeCyW38q7WvyY8vR",
                "slot": 112,
                "err": { "InstructionError": [0, "Custom"] },
                "memo": null,
                "blockTime": null,
                "confirmationStatus": "confirmed"
            }
        ]"#;
        let infos: Vec<SignatureInfo> = serde_json::from_str(fixture).unwrap();
        let owner = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
        let records: Vec<TransactionRecord> =
            infos.iter().map(|i| signature_to_record(owner, i)).collect();

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].status, TxStatus::Confirmed);
        assert_eq!(records[0].block_height, Some(114));
        assert_eq!(records[0].timestamp, Some(1720526751));
        assert_eq!(records[1].status, TxStatus::Failed);
        assert_eq!(records[1].timestamp, None);
        assert_eq!(records[0].chain, ChainId::Solana);
    }

    #[tokio::test]
    async fn build_transfer_validates_input() {
        let adapter = SolanaAdapter::new("http://localhost:8899");
        let from = Address::solana("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T").unwrap();
        let to = Address::solana("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();

        let tx = adapter.build_transfer(&from, &to, 1_000, None).await.unwrap();
        assert_eq!(tx.chain, ChainId::Solana);
        assert!(tx.token.is_none());

        assert!(adapter.build_transfer(&from, &to, 0, None).await.is_err());

        let btc = Address::bitcoin("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").unwrap();
        assert!(adapter.build_transfer(&btc, &to, 1, None).await.is_err());
    }
}
