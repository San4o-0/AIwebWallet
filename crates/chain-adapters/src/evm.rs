//! EVM adapter (Ethereum, Polygon, BSC, Arbitrum, Base).
//!
//! Implemented over plain JSON-RPC via `reqwest` (the TZ-sanctioned fallback
//! to keep the dependency tree small and compilation fast; swapping the
//! transport for `alloy` later does not change the public [`ChainAdapter`]
//! surface). Uses `eth_getBalance`, `eth_feeHistory` (EIP-1559 tiers),
//! `eth_call` (ERC-20 `balanceOf`) and `eth_sendRawTransaction`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use crate::error::AdapterError;
use crate::jsonrpc::JsonRpcClient;
use crate::reliability::RetryPolicy;
use crate::types::{
    Address, ChainId, FeeEstimate, FeeRate, TokenBalance, TransactionRecord, TxRequest,
};
use crate::ChainAdapter;

/// ERC-20 `balanceOf(address)` selector.
const SELECTOR_BALANCE_OF: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];
/// ERC-20 `transfer(address,uint256)` selector.
const SELECTOR_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// ERC-20 `decimals()` selector.
const SELECTOR_DECIMALS: [u8; 4] = [0x31, 0x3c, 0xe5, 0x67];
/// ERC-20 `symbol()` selector.
const SELECTOR_SYMBOL: [u8; 4] = [0x95, 0xd8, 0x9b, 0x41];

/// A token the adapter should track. Without an indexer the adapter cannot
/// *discover* tokens (TZ §F2.3 relies on an indexer for that), so the token
/// list is supplied by configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenConfig {
    /// ERC-20 contract address (`0x...`).
    pub address: String,
    pub symbol: String,
    pub decimals: u8,
}

/// Adapter for a single EVM network.
#[derive(Debug, Clone)]
pub struct EvmAdapter {
    chain: ChainId,
    rpc: JsonRpcClient,
    tokens: Vec<TokenConfig>,
}

impl EvmAdapter {
    /// Create an adapter for an EVM chain pointed at `rpc_url`.
    pub fn new(chain: ChainId, rpc_url: impl Into<String>) -> Result<Self, AdapterError> {
        if !chain.is_evm() {
            return Err(AdapterError::InvalidInput(format!(
                "{chain} is not an EVM chain"
            )));
        }
        Ok(EvmAdapter {
            chain,
            // Opt in to retry + per-provider rate limiting (Solana keeps the
            // plain `JsonRpcClient::new`; only EVM uses the reliable client).
            rpc: JsonRpcClient::with_reliability(rpc_url, RetryPolicy::default()),
            tokens: Vec::new(),
        })
    }

    /// Same, with a list of ERC-20 tokens to query in `get_token_balances`.
    pub fn with_tokens(
        chain: ChainId,
        rpc_url: impl Into<String>,
        tokens: Vec<TokenConfig>,
    ) -> Result<Self, AdapterError> {
        let mut adapter = Self::new(chain, rpc_url)?;
        adapter.tokens = tokens;
        Ok(adapter)
    }

    /// Numeric EIP-155 chain id.
    pub fn evm_chain_id(&self) -> u64 {
        self.chain.evm_chain_id().expect("constructor enforces EVM chain")
    }

    fn check_chain(&self, address: &Address) -> Result<(), AdapterError> {
        if address.chain() == self.chain {
            Ok(())
        } else {
            Err(AdapterError::InvalidInput(format!(
                "address belongs to {}, adapter serves {}",
                address.chain(),
                self.chain
            )))
        }
    }

    /// Generic `eth_call` against the latest block.
    ///
    /// Used by the api-server transaction simulator (F4.3) to verify that a
    /// call does not revert. Returns the raw hex result (`"0x..."`); a revert
    /// surfaces as [`AdapterError::Rpc`] whose message usually contains the
    /// revert reason.
    pub async fn eth_call(
        &self,
        from: Option<&str>,
        to: &str,
        value: Option<u128>,
        data: Option<&str>,
    ) -> Result<String, AdapterError> {
        let mut call = serde_json::Map::new();
        if let Some(from) = from {
            call.insert("from".into(), json!(from));
        }
        call.insert("to".into(), json!(to));
        if let Some(value) = value {
            call.insert("value".into(), json!(format!("0x{value:x}")));
        }
        if let Some(data) = data {
            call.insert("data".into(), json!(data));
        }
        self.rpc.call("eth_call", json!([call, "latest"])).await
    }

    /// `eth_estimateGas` for a prospective transaction. A revert surfaces as
    /// [`AdapterError::Rpc`].
    pub async fn estimate_gas(
        &self,
        from: Option<&str>,
        to: &str,
        value: Option<u128>,
        data: Option<&str>,
    ) -> Result<u128, AdapterError> {
        let mut call = serde_json::Map::new();
        if let Some(from) = from {
            call.insert("from".into(), json!(from));
        }
        call.insert("to".into(), json!(to));
        if let Some(value) = value {
            call.insert("value".into(), json!(format!("0x{value:x}")));
        }
        if let Some(data) = data {
            call.insert("data".into(), json!(data));
        }
        let gas: String = self.rpc.call("eth_estimateGas", json!([call])).await?;
        parse_hex_quantity(&gas)
    }

    /// ERC-20 `balanceOf(owner)` for an arbitrary token contract.
    pub async fn erc20_balance(&self, token: &str, owner: &str) -> Result<u128, AdapterError> {
        let calldata = erc20_balance_of_calldata(owner)?;
        let result = self.eth_call(None, token, None, Some(&calldata)).await?;
        if result == "0x" {
            Ok(0)
        } else {
            parse_hex_quantity(&result)
        }
    }

    /// ERC-20 `decimals()`. Errors if the contract does not implement it.
    pub async fn erc20_decimals(&self, token: &str) -> Result<u8, AdapterError> {
        let calldata = format!("0x{}", hex::encode(SELECTOR_DECIMALS));
        let result = self.eth_call(None, token, None, Some(&calldata)).await?;
        let value = parse_hex_quantity(&result)?;
        u8::try_from(value)
            .map_err(|_| AdapterError::parse(format!("decimals out of range: {value}")))
    }

    /// ERC-20 `symbol()`. `None` when the contract returns nothing decodable.
    pub async fn erc20_symbol(&self, token: &str) -> Result<Option<String>, AdapterError> {
        let calldata = format!("0x{}", hex::encode(SELECTOR_SYMBOL));
        let result = self.eth_call(None, token, None, Some(&calldata)).await?;
        Ok(decode_abi_string(&result))
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without network access)
// ---------------------------------------------------------------------------

/// Parse an Ethereum hex quantity (`"0x1b4"`) into `u128`.
///
/// Accepts zero-padded values too: `eth_call` returns full 32-byte ABI words
/// (64 hex digits), so leading zeros are trimmed before the overflow check.
pub(crate) fn parse_hex_quantity(s: &str) -> Result<u128, AdapterError> {
    let digits = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .ok_or_else(|| AdapterError::parse(format!("quantity without 0x prefix: {s}")))?;
    if digits.is_empty() {
        return Err(AdapterError::parse(format!("empty hex quantity: {s}")));
    }
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Ok(0); // all zeros
    }
    if significant.len() > 32 {
        // Would overflow u128 (realistic balances/fees fit comfortably).
        return Err(AdapterError::parse(format!("hex quantity too large: {s}")));
    }
    u128::from_str_radix(significant, 16)
        .map_err(|e| AdapterError::parse(format!("bad hex quantity {s}: {e}")))
}

/// Decode a `0x...` hex string into raw bytes.
fn decode_hex_addr(addr: &str) -> Result<[u8; 20], AdapterError> {
    let digits = addr
        .strip_prefix("0x")
        .ok_or_else(|| AdapterError::parse(format!("address without 0x prefix: {addr}")))?;
    let bytes = hex::decode(digits).map_err(|e| AdapterError::parse(format!("bad address hex: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| AdapterError::parse(format!("address is not 20 bytes: {addr}")))
}

/// ABI-encode `balanceOf(owner)` calldata.
pub(crate) fn erc20_balance_of_calldata(owner: &str) -> Result<String, AdapterError> {
    let owner = decode_hex_addr(owner)?;
    let mut data = Vec::with_capacity(4 + 32);
    data.extend_from_slice(&SELECTOR_BALANCE_OF);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&owner);
    Ok(format!("0x{}", hex::encode(data)))
}

/// ABI-encode `transfer(to, amount)` calldata.
pub(crate) fn erc20_transfer_calldata(to: &str, amount: u128) -> Result<Vec<u8>, AdapterError> {
    let to = decode_hex_addr(to)?;
    let mut data = Vec::with_capacity(4 + 64);
    data.extend_from_slice(&SELECTOR_TRANSFER);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&to);
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&amount.to_be_bytes());
    Ok(data)
}

/// Decode an ABI-encoded return value into a UTF-8 string.
///
/// Handles both the standard dynamic `string` encoding
/// (offset + length + bytes) and the legacy `bytes32` symbols some old
/// tokens (MKR-style) return. `None` when nothing decodable.
pub(crate) fn decode_abi_string(result: &str) -> Option<String> {
    let hex_body = result.strip_prefix("0x").unwrap_or(result);
    let bytes = hex::decode(hex_body).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let text = if bytes.len() >= 64 && bytes[..31].iter().all(|b| *b == 0) && bytes[31] == 0x20 {
        // Dynamic string: word 0 = offset (0x20), word 1 = length, then data.
        let len = u64::from_be_bytes(bytes[56..64].try_into().ok()?) as usize;
        if bytes[32..56].iter().any(|b| *b != 0) || bytes.len() < 64 + len {
            return None;
        }
        String::from_utf8(bytes[64..64 + len].to_vec()).ok()?
    } else if bytes.len() == 32 {
        // bytes32: NUL-padded ASCII.
        let end = bytes.iter().position(|b| *b == 0).unwrap_or(32);
        String::from_utf8(bytes[..end].to_vec()).ok()?
    } else {
        return None;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Shape of an `eth_feeHistory` response.
#[derive(Debug, Deserialize)]
pub(crate) struct FeeHistory {
    #[serde(rename = "baseFeePerGas")]
    pub base_fee_per_gas: Vec<String>,
    /// One inner vec per block, one entry per requested percentile.
    #[serde(default)]
    pub reward: Vec<Vec<String>>,
}

/// Build a three-tier EIP-1559 estimate from `eth_feeHistory` data.
///
/// Percentiles requested are 10 / 50 / 90; the priority fee of each tier is
/// the average of that percentile across sampled blocks, and
/// `max_fee = 2 * next_base_fee + priority` (standard headroom heuristic).
pub(crate) fn fee_estimate_from_history(history: &FeeHistory) -> Result<FeeEstimate, AdapterError> {
    let next_base_fee = history
        .base_fee_per_gas
        .last()
        .map(|s| parse_hex_quantity(s))
        .transpose()?
        .ok_or_else(|| AdapterError::parse("feeHistory: empty baseFeePerGas"))?;

    // Average each percentile column across blocks.
    let mut sums = [0u128; 3];
    let mut count = 0u128;
    for block in &history.reward {
        if block.len() < 3 {
            continue;
        }
        for (i, sum) in sums.iter_mut().enumerate() {
            *sum += parse_hex_quantity(&block[i])?;
        }
        count += 1;
    }
    // Fallback priority fee of 1 gwei when the node returns no reward data.
    const DEFAULT_PRIORITY: u128 = 1_000_000_000;
    let tiers: Vec<u128> = if count == 0 {
        vec![DEFAULT_PRIORITY / 2, DEFAULT_PRIORITY, DEFAULT_PRIORITY * 2]
    } else {
        sums.iter().map(|s| (s / count).max(1)).collect()
    };

    let make = |priority: u128| FeeRate::Eip1559 {
        max_fee_per_gas: next_base_fee.saturating_mul(2).saturating_add(priority),
        max_priority_fee_per_gas: priority,
    };
    Ok(FeeEstimate {
        slow: make(tiers[0]),
        standard: make(tiers[1]),
        fast: make(tiers[2]),
    })
}

// ---------------------------------------------------------------------------
// ChainAdapter implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl ChainAdapter for EvmAdapter {
    fn chain(&self) -> ChainId {
        self.chain
    }

    async fn get_native_balance(&self, address: &Address) -> Result<TokenBalance, AdapterError> {
        self.check_chain(address)?;
        let hex_balance: String = self
            .rpc
            .call("eth_getBalance", json!([address.as_str(), "latest"]))
            .await?;
        Ok(TokenBalance {
            symbol: self.chain.native_symbol().to_string(),
            decimals: self.chain.native_decimals(),
            amount: parse_hex_quantity(&hex_balance)?,
            token_address: None,
            usd_value: None,
        })
    }

    async fn get_token_balances(&self, address: &Address) -> Result<Vec<TokenBalance>, AdapterError> {
        self.check_chain(address)?;
        let mut balances = Vec::with_capacity(self.tokens.len());
        for token in &self.tokens {
            let calldata = erc20_balance_of_calldata(address.as_str())?;
            let result: String = self
                .rpc
                .call(
                    "eth_call",
                    json!([{ "to": token.address, "data": calldata }, "latest"]),
                )
                .await?;
            let amount = if result == "0x" {
                0 // non-contract / empty return
            } else {
                parse_hex_quantity(&result)?
            };
            if amount > 0 {
                balances.push(TokenBalance {
                    symbol: token.symbol.clone(),
                    decimals: token.decimals,
                    amount,
                    token_address: Some(token.address.clone()),
                    usd_value: None,
                });
            }
        }
        Ok(balances)
    }

    async fn estimate_fees(&self) -> Result<FeeEstimate, AdapterError> {
        // 5 recent blocks, priority-fee percentiles 10/50/90.
        let history: FeeHistory = self
            .rpc
            .call("eth_feeHistory", json!(["0x5", "latest", [10, 50, 90]]))
            .await?;
        fee_estimate_from_history(&history)
    }

    async fn build_transfer(
        &self,
        from: &Address,
        to: &Address,
        amount: u128,
        token: Option<&Address>,
    ) -> Result<TxRequest, AdapterError> {
        self.check_chain(from)?;
        self.check_chain(to)?;
        if amount == 0 {
            return Err(AdapterError::InvalidInput("amount must be > 0".into()));
        }
        let data = match token {
            Some(token_addr) => {
                self.check_chain(token_addr)?;
                Some(erc20_transfer_calldata(to.as_str(), amount)?)
            }
            None => None,
        };
        Ok(TxRequest {
            chain: self.chain,
            from: from.clone(),
            to: to.clone(),
            amount,
            token: token.cloned(),
            data,
            fee: None,
            nonce: None,
        })
    }

    async fn get_transaction_count(&self, address: &Address) -> Result<u64, AdapterError> {
        self.check_chain(address)?;
        // "pending" — щоб послідовні надсилання не конфліктували за nonce.
        let hex_count: String = self
            .rpc
            .call("eth_getTransactionCount", json!([address.as_str(), "pending"]))
            .await?;
        let count = parse_hex_quantity(&hex_count)?;
        u64::try_from(count)
            .map_err(|_| AdapterError::parse(format!("nonce завеликий: {hex_count}")))
    }

    async fn broadcast(&self, signed_tx: &[u8]) -> Result<String, AdapterError> {
        if signed_tx.is_empty() {
            return Err(AdapterError::InvalidInput("empty signed transaction".into()));
        }
        let raw = format!("0x{}", hex::encode(signed_tx));
        let tx_hash: String = self.rpc.call("eth_sendRawTransaction", json!([raw])).await?;
        Ok(tx_hash)
    }

    async fn get_transaction_history(
        &self,
        _address: &Address,
        _cursor: Option<String>,
    ) -> Result<(Vec<TransactionRecord>, Option<String>), AdapterError> {
        // TODO(indexer): plain JSON-RPC nodes cannot enumerate transactions by
        // address. Requires an indexer backend (Alchemy `alchemy_getAssetTransfers`,
        // Etherscan API, or the in-house `indexer` crate from TZ §3) — to be
        // wired up during api-server integration.
        Err(AdapterError::Unsupported(
            "EVM transaction history requires an indexer (TODO: Alchemy/Etherscan/indexer crate)"
                .into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VITALIK: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

    #[test]
    fn hex_quantity_parsing() {
        assert_eq!(parse_hex_quantity("0x0").unwrap(), 0);
        assert_eq!(parse_hex_quantity("0x1b4").unwrap(), 436);
        assert_eq!(
            parse_hex_quantity("0xde0b6b3a7640000").unwrap(),
            1_000_000_000_000_000_000 // 1 ETH in wei
        );
        assert!(parse_hex_quantity("1b4").is_err());
        assert!(parse_hex_quantity("0x").is_err());
        assert!(parse_hex_quantity("0xgg").is_err());
        // 33 hex digits > u128
        assert!(parse_hex_quantity("0x100000000000000000000000000000000").is_err());
    }

    #[test]
    fn hex_quantity_accepts_zero_padded_abi_words() {
        // eth_call returns full 32-byte words: leading zeros must not
        // trigger the u128 overflow guard.
        assert_eq!(
            parse_hex_quantity(
                "0x0000000000000000000000000000000000000000000000000000000002311112"
            )
            .unwrap(),
            0x2311112
        );
        // All-zero word is a valid zero balance.
        assert_eq!(
            parse_hex_quantity(
                "0x0000000000000000000000000000000000000000000000000000000000000000"
            )
            .unwrap(),
            0
        );
        // A padded word whose significant part still overflows u128 is rejected.
        assert!(parse_hex_quantity(
            "0x0000000000000000000000000000000100000000000000000000000000000000"
        )
        .is_err());
    }

    #[test]
    fn balance_of_calldata_encoding() {
        let data = erc20_balance_of_calldata(VITALIK).unwrap();
        assert_eq!(
            data,
            "0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"
        );
    }

    #[test]
    fn transfer_calldata_encoding() {
        let data = erc20_transfer_calldata(VITALIK, 1_000_000).unwrap();
        assert_eq!(data.len(), 4 + 32 + 32);
        assert_eq!(&data[..4], &SELECTOR_TRANSFER);
        assert_eq!(
            hex::encode(&data),
            "a9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045\
             00000000000000000000000000000000000000000000000000000000000f4240"
        );
    }

    #[test]
    fn abi_string_decoding() {
        // Dynamic string "USDC" (real USDC symbol() return shape).
        let dynamic = concat!(
            "0x",
            "0000000000000000000000000000000000000000000000000000000000000020",
            "0000000000000000000000000000000000000000000000000000000000000004",
            "5553444300000000000000000000000000000000000000000000000000000000"
        );
        assert_eq!(decode_abi_string(dynamic).as_deref(), Some("USDC"));

        // Legacy bytes32 "MKR".
        let bytes32 = "0x4d4b520000000000000000000000000000000000000000000000000000000000";
        assert_eq!(decode_abi_string(bytes32).as_deref(), Some("MKR"));

        assert_eq!(decode_abi_string("0x"), None);
        assert_eq!(decode_abi_string("0xzz"), None);
        // All-zero word decodes to nothing.
        assert_eq!(
            decode_abi_string(
                "0x0000000000000000000000000000000000000000000000000000000000000000"
            ),
            None
        );
    }

    #[test]
    fn fee_history_fixture_produces_three_tiers() {
        // Trimmed real-shaped eth_feeHistory result.
        let fixture = r#"{
            "oldestBlock": "0x1487a3d",
            "baseFeePerGas": ["0x2540be400", "0x2540be400", "0x2e90edd00"],
            "gasUsedRatio": [0.45, 0.61],
            "reward": [
                ["0x3b9aca00", "0x77359400", "0xb2d05e00"],
                ["0x3b9aca00", "0x77359400", "0xee6b2800"]
            ]
        }"#;
        let history: FeeHistory = serde_json::from_str(fixture).unwrap();
        let est = fee_estimate_from_history(&history).unwrap();

        let next_base = 0x2e90edd00u128; // 12.5 gwei
        match (est.slow, est.standard, est.fast) {
            (
                FeeRate::Eip1559 {
                    max_priority_fee_per_gas: slow_p,
                    max_fee_per_gas: slow_max,
                },
                FeeRate::Eip1559 {
                    max_priority_fee_per_gas: std_p, ..
                },
                FeeRate::Eip1559 {
                    max_priority_fee_per_gas: fast_p, ..
                },
            ) => {
                assert_eq!(slow_p, 1_000_000_000); // avg of two 1-gwei samples
                assert_eq!(std_p, 2_000_000_000);
                assert_eq!(fast_p, (0xb2d05e00u128 + 0xee6b2800u128) / 2);
                assert!(slow_p < std_p && std_p < fast_p);
                assert_eq!(slow_max, next_base * 2 + slow_p);
            }
            other => panic!("expected EIP-1559 tiers, got {other:?}"),
        }
    }

    #[test]
    fn fee_history_without_rewards_uses_defaults() {
        let fixture = r#"{ "baseFeePerGas": ["0x3b9aca00"], "reward": [] }"#;
        let history: FeeHistory = serde_json::from_str(fixture).unwrap();
        let est = fee_estimate_from_history(&history).unwrap();
        match est.standard {
            FeeRate::Eip1559 {
                max_priority_fee_per_gas,
                ..
            } => assert_eq!(max_priority_fee_per_gas, 1_000_000_000),
            other => panic!("unexpected fee rate: {other:?}"),
        }
    }

    #[test]
    fn adapter_rejects_non_evm_chain() {
        assert!(EvmAdapter::new(ChainId::Solana, "http://localhost:8545").is_err());
        assert!(EvmAdapter::new(ChainId::Polygon, "http://localhost:8545").is_ok());
    }

    #[tokio::test]
    async fn build_transfer_native_and_token() {
        let adapter = EvmAdapter::new(ChainId::Ethereum, "http://localhost:8545").unwrap();
        let from = Address::new(ChainId::Ethereum, VITALIK).unwrap();
        let to = Address::new(ChainId::Ethereum, "0x0000000000000000000000000000000000000001")
            .unwrap();
        let usdc = Address::new(ChainId::Ethereum, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
            .unwrap();

        let native = adapter.build_transfer(&from, &to, 42, None).await.unwrap();
        assert_eq!(native.chain, ChainId::Ethereum);
        assert_eq!(native.amount, 42);
        assert!(native.data.is_none() && native.token.is_none());

        let token_tx = adapter
            .build_transfer(&from, &to, 1_000_000, Some(&usdc))
            .await
            .unwrap();
        assert_eq!(token_tx.token.as_ref().unwrap().as_str(), usdc.as_str());
        let data = token_tx.data.unwrap();
        assert_eq!(&data[..4], &SELECTOR_TRANSFER);

        assert!(adapter.build_transfer(&from, &to, 0, None).await.is_err());
    }

    #[tokio::test]
    async fn history_is_unsupported_todo() {
        let adapter = EvmAdapter::new(ChainId::Ethereum, "http://localhost:8545").unwrap();
        let addr = Address::new(ChainId::Ethereum, VITALIK).unwrap();
        let err = adapter.get_transaction_history(&addr, None).await.unwrap_err();
        assert!(matches!(err, AdapterError::Unsupported(_)));
    }
}
