//! Bitcoin adapter over the mempool.space REST API.
//!
//! Endpoints used:
//! - `GET  /api/address/:addr`            — funded/spent sums (balance)
//! - `GET  /api/v1/fees/recommended`      — sat/vB tiers
//! - `POST /api/tx`                       — broadcast raw tx (hex body)
//! - `GET  /api/address/:addr/txs[...]`   — history (25 per page)

use async_trait::async_trait;
use serde::Deserialize;

use crate::error::AdapterError;
use crate::types::{
    Address, ChainId, FeeEstimate, FeeRate, TokenBalance, TransactionRecord, TxRequest, TxStatus,
};
use crate::ChainAdapter;

/// Default mempool.space mainnet API root.
pub const DEFAULT_MEMPOOL_API: &str = "https://mempool.space/api";

/// Adapter for Bitcoin via a mempool.space-compatible REST API.
#[derive(Debug, Clone)]
pub struct BitcoinAdapter {
    http: reqwest::Client,
    base_url: String,
}

impl Default for BitcoinAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl BitcoinAdapter {
    /// Adapter against the public mempool.space mainnet API.
    pub fn new() -> Self {
        Self::with_base_url(DEFAULT_MEMPOOL_API)
    }

    /// Adapter against a custom API root (self-hosted mempool, testnet:
    /// `https://mempool.space/testnet/api`, ...). Trailing slash is trimmed.
    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        BitcoinAdapter {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    fn check_chain(address: &Address) -> Result<(), AdapterError> {
        if address.chain() == ChainId::Bitcoin {
            Ok(())
        } else {
            Err(AdapterError::InvalidInput(format!(
                "address belongs to {}, adapter serves bitcoin",
                address.chain()
            )))
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, AdapterError> {
        let url = format!("{}{path}", self.base_url);
        let response = self.http.get(&url).send().await?;
        if !response.status().is_success() {
            let code = response.status().as_u16() as i64;
            let message = response.text().await.unwrap_or_default();
            return Err(AdapterError::Rpc { code, message });
        }
        Ok(response.json().await?)
    }
}

// ---------------------------------------------------------------------------
// Response shapes (unit-tested against fixtures)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct AddressInfo {
    pub chain_stats: AddressStats,
    pub mempool_stats: AddressStats,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AddressStats {
    pub funded_txo_sum: u64,
    pub spent_txo_sum: u64,
}

/// Confirmed + unconfirmed balance in satoshis.
pub(crate) fn balance_from_address_info(info: &AddressInfo) -> u128 {
    let confirmed =
        info.chain_stats.funded_txo_sum as i128 - info.chain_stats.spent_txo_sum as i128;
    let mempool =
        info.mempool_stats.funded_txo_sum as i128 - info.mempool_stats.spent_txo_sum as i128;
    (confirmed + mempool).max(0) as u128
}

#[derive(Debug, Deserialize)]
pub(crate) struct RecommendedFees {
    #[serde(rename = "fastestFee")]
    pub fastest_fee: u64,
    #[serde(rename = "halfHourFee")]
    pub half_hour_fee: u64,
    #[serde(rename = "hourFee")]
    pub hour_fee: u64,
}

pub(crate) fn fee_estimate_from_recommended(fees: &RecommendedFees) -> FeeEstimate {
    let make = |sat_per_vbyte: u64| FeeRate::BitcoinSatPerVb { sat_per_vbyte };
    FeeEstimate {
        slow: make(fees.hour_fee),
        standard: make(fees.half_hour_fee),
        fast: make(fees.fastest_fee),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct MempoolTx {
    pub txid: String,
    pub fee: u64,
    pub status: MempoolTxStatus,
    #[serde(default)]
    pub vin: Vec<MempoolVin>,
    #[serde(default)]
    pub vout: Vec<MempoolVout>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MempoolTxStatus {
    pub confirmed: bool,
    pub block_height: Option<u64>,
    pub block_time: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MempoolVin {
    pub prevout: Option<MempoolVout>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MempoolVout {
    pub scriptpubkey_address: Option<String>,
    pub value: u64,
}

/// Map a mempool.space transaction to a [`TransactionRecord`] relative to
/// `address`: `amount` is the net satoshi flow for that address (incoming
/// minus outgoing, absolute value; direction is expressed via `from`/`to`).
pub(crate) fn tx_to_record(address: &str, tx: &MempoolTx) -> TransactionRecord {
    let sent: i128 = tx
        .vin
        .iter()
        .filter_map(|vin| vin.prevout.as_ref())
        .filter(|prev| prev.scriptpubkey_address.as_deref() == Some(address))
        .map(|prev| prev.value as i128)
        .sum();
    let received: i128 = tx
        .vout
        .iter()
        .filter(|out| out.scriptpubkey_address.as_deref() == Some(address))
        .map(|out| out.value as i128)
        .sum();
    let net = received - sent;

    // Counterparty: first foreign output for sends, first foreign input for receives.
    let foreign_output = tx
        .vout
        .iter()
        .find(|o| o.scriptpubkey_address.as_deref() != Some(address))
        .and_then(|o| o.scriptpubkey_address.clone());
    let foreign_input = tx
        .vin
        .iter()
        .filter_map(|vin| vin.prevout.as_ref())
        .find(|p| p.scriptpubkey_address.as_deref() != Some(address))
        .and_then(|p| p.scriptpubkey_address.clone());

    let (from, to) = if net < 0 {
        (Some(address.to_string()), foreign_output)
    } else {
        (foreign_input, Some(address.to_string()))
    };

    TransactionRecord {
        chain: ChainId::Bitcoin,
        hash: tx.txid.clone(),
        from,
        to,
        amount: Some(net.unsigned_abs()),
        token_address: None,
        fee: Some(tx.fee as u128),
        status: if tx.status.confirmed {
            TxStatus::Confirmed
        } else {
            TxStatus::Pending
        },
        block_height: tx.status.block_height,
        timestamp: tx.status.block_time,
    }
}

// ---------------------------------------------------------------------------
// ChainAdapter implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl ChainAdapter for BitcoinAdapter {
    fn chain(&self) -> ChainId {
        ChainId::Bitcoin
    }

    async fn get_native_balance(&self, address: &Address) -> Result<TokenBalance, AdapterError> {
        Self::check_chain(address)?;
        let info: AddressInfo = self.get_json(&format!("/address/{}", address.as_str())).await?;
        Ok(TokenBalance {
            symbol: "BTC".to_string(),
            decimals: ChainId::Bitcoin.native_decimals(),
            amount: balance_from_address_info(&info),
            token_address: None,
            usd_value: None,
        })
    }

    async fn get_token_balances(&self, address: &Address) -> Result<Vec<TokenBalance>, AdapterError> {
        Self::check_chain(address)?;
        // Bitcoin has no fungible-token layer in scope (TZ §F2.3: native/ERC-20/SPL).
        Ok(Vec::new())
    }

    async fn estimate_fees(&self) -> Result<FeeEstimate, AdapterError> {
        let fees: RecommendedFees = self.get_json("/v1/fees/recommended").await?;
        Ok(fee_estimate_from_recommended(&fees))
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
        if token.is_some() {
            return Err(AdapterError::Unsupported(
                "bitcoin has no token transfers".into(),
            ));
        }
        // UTXO selection, PSBT construction and signing (incl. RBF flag,
        // TZ §F3.3) are performed by wallet-core; this is the transfer intent.
        Ok(TxRequest {
            chain: ChainId::Bitcoin,
            from: from.clone(),
            to: to.clone(),
            amount,
            token: None,
            data: None,
            fee: None,
            nonce: None,
        })
    }

    async fn broadcast(&self, signed_tx: &[u8]) -> Result<String, AdapterError> {
        if signed_tx.is_empty() {
            return Err(AdapterError::InvalidInput("empty signed transaction".into()));
        }
        let url = format!("{}/tx", self.base_url);
        let response = self.http.post(&url).body(hex::encode(signed_tx)).send().await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(AdapterError::Rpc {
                code: status.as_u16() as i64,
                message: body,
            });
        }
        Ok(body.trim().to_string())
    }

    async fn get_transaction_history(
        &self,
        address: &Address,
        cursor: Option<String>,
    ) -> Result<(Vec<TransactionRecord>, Option<String>), AdapterError> {
        Self::check_chain(address)?;
        // First page mixes mempool + confirmed; older pages are keyed by the
        // last seen confirmed txid.
        let path = match &cursor {
            Some(last_txid) => format!("/address/{}/txs/chain/{last_txid}", address.as_str()),
            None => format!("/address/{}/txs", address.as_str()),
        };
        let txs: Vec<MempoolTx> = self.get_json(&path).await?;
        let records: Vec<TransactionRecord> = txs
            .iter()
            .map(|tx| tx_to_record(address.as_str(), tx))
            .collect();
        // mempool.space pages contain up to 25 confirmed txs.
        let next_cursor = if txs.len() >= 25 {
            txs.iter()
                .rev()
                .find(|tx| tx.status.confirmed)
                .map(|tx| tx.txid.clone())
        } else {
            None
        };
        Ok((records, next_cursor))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

    #[test]
    fn parse_address_info_and_balance() {
        let fixture = r#"{
            "address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            "chain_stats": {
                "funded_txo_count": 5,
                "funded_txo_sum": 15007599040,
                "spent_txo_count": 5,
                "spent_txo_sum": 15007599040,
                "tx_count": 7
            },
            "mempool_stats": {
                "funded_txo_count": 1,
                "funded_txo_sum": 250000,
                "spent_txo_count": 0,
                "spent_txo_sum": 0,
                "tx_count": 1
            }
        }"#;
        let info: AddressInfo = serde_json::from_str(fixture).unwrap();
        // confirmed 0 + unconfirmed 250000
        assert_eq!(balance_from_address_info(&info), 250_000);
    }

    #[test]
    fn parse_recommended_fees() {
        let fixture = r#"{
            "fastestFee": 24,
            "halfHourFee": 18,
            "hourFee": 12,
            "economyFee": 6,
            "minimumFee": 3
        }"#;
        let fees: RecommendedFees = serde_json::from_str(fixture).unwrap();
        let est = fee_estimate_from_recommended(&fees);
        assert_eq!(est.fast, FeeRate::BitcoinSatPerVb { sat_per_vbyte: 24 });
        assert_eq!(est.standard, FeeRate::BitcoinSatPerVb { sat_per_vbyte: 18 });
        assert_eq!(est.slow, FeeRate::BitcoinSatPerVb { sat_per_vbyte: 12 });
    }

    #[test]
    fn history_fixture_maps_incoming_and_outgoing() {
        let fixture = r#"[
          {
            "txid": "aaa111",
            "version": 2,
            "locktime": 0,
            "fee": 141,
            "status": { "confirmed": true, "block_height": 850000, "block_hash": "00000...", "block_time": 1720000000 },
            "vin": [
              { "prevout": { "scriptpubkey_address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "value": 100000 } }
            ],
            "vout": [
              { "scriptpubkey_address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "value": 60000 },
              { "scriptpubkey_address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "value": 39859 }
            ]
          },
          {
            "txid": "bbb222",
            "version": 2,
            "locktime": 0,
            "fee": 200,
            "status": { "confirmed": false, "block_height": null, "block_hash": null, "block_time": null },
            "vin": [
              { "prevout": { "scriptpubkey_address": "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "value": 500000 } }
            ],
            "vout": [
              { "scriptpubkey_address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "value": 499800 }
            ]
          }
        ]"#;
        let txs: Vec<MempoolTx> = serde_json::from_str(fixture).unwrap();
        assert_eq!(txs.len(), 2);

        // Outgoing: spent 100000, got 39859 change back -> net -60141.
        let outgoing = tx_to_record(ADDR, &txs[0]);
        assert_eq!(outgoing.amount, Some(60_141));
        assert_eq!(outgoing.from.as_deref(), Some(ADDR));
        assert_eq!(
            outgoing.to.as_deref(),
            Some("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
        );
        assert_eq!(outgoing.status, TxStatus::Confirmed);
        assert_eq!(outgoing.block_height, Some(850_000));
        assert_eq!(outgoing.fee, Some(141));

        // Incoming, unconfirmed.
        let incoming = tx_to_record(ADDR, &txs[1]);
        assert_eq!(incoming.amount, Some(499_800));
        assert_eq!(incoming.to.as_deref(), Some(ADDR));
        assert_eq!(
            incoming.from.as_deref(),
            Some("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")
        );
        assert_eq!(incoming.status, TxStatus::Pending);
        assert_eq!(incoming.timestamp, None);
    }

    #[tokio::test]
    async fn build_transfer_rejects_tokens_and_zero() {
        let adapter = BitcoinAdapter::new();
        let from = Address::bitcoin(ADDR).unwrap();
        let to = Address::bitcoin("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").unwrap();

        let tx = adapter.build_transfer(&from, &to, 10_000, None).await.unwrap();
        assert_eq!(tx.chain, ChainId::Bitcoin);
        assert_eq!(tx.amount, 10_000);

        assert!(adapter.build_transfer(&from, &to, 0, None).await.is_err());
        let fake_token = Address::bitcoin("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").unwrap();
        assert!(matches!(
            adapter
                .build_transfer(&from, &to, 1, Some(&fake_token))
                .await
                .unwrap_err(),
            AdapterError::Unsupported(_)
        ));
    }

    #[test]
    fn base_url_trailing_slash_is_trimmed() {
        let adapter = BitcoinAdapter::with_base_url("https://mempool.space/api/");
        assert_eq!(adapter.base_url, "https://mempool.space/api");
    }
}
