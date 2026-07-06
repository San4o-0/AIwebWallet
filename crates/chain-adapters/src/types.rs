//! Shared, chain-agnostic types used across all adapters.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::AdapterError;

// ---------------------------------------------------------------------------
// ChainId
// ---------------------------------------------------------------------------

/// Supported networks (MVP set from TZ §F2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChainId {
    Ethereum,
    Polygon,
    Bsc,
    Arbitrum,
    Base,
    Solana,
    Bitcoin,
}

impl ChainId {
    /// All supported chains.
    pub const ALL: [ChainId; 7] = [
        ChainId::Ethereum,
        ChainId::Polygon,
        ChainId::Bsc,
        ChainId::Arbitrum,
        ChainId::Base,
        ChainId::Solana,
        ChainId::Bitcoin,
    ];

    /// `true` for EVM-compatible networks.
    pub fn is_evm(&self) -> bool {
        matches!(
            self,
            ChainId::Ethereum | ChainId::Polygon | ChainId::Bsc | ChainId::Arbitrum | ChainId::Base
        )
    }

    /// Numeric EVM chain id (EIP-155), `None` for non-EVM chains.
    pub fn evm_chain_id(&self) -> Option<u64> {
        match self {
            ChainId::Ethereum => Some(1),
            ChainId::Polygon => Some(137),
            ChainId::Bsc => Some(56),
            ChainId::Arbitrum => Some(42161),
            ChainId::Base => Some(8453),
            ChainId::Solana | ChainId::Bitcoin => None,
        }
    }

    /// Ticker of the native coin.
    pub fn native_symbol(&self) -> &'static str {
        match self {
            ChainId::Ethereum | ChainId::Arbitrum | ChainId::Base => "ETH",
            ChainId::Polygon => "POL",
            ChainId::Bsc => "BNB",
            ChainId::Solana => "SOL",
            ChainId::Bitcoin => "BTC",
        }
    }

    /// Decimals of the native coin (wei = 18, lamports = 9, satoshi = 8).
    pub fn native_decimals(&self) -> u8 {
        match self {
            ChainId::Solana => 9,
            ChainId::Bitcoin => 8,
            _ => 18,
        }
    }

    /// Canonical lowercase name.
    pub fn as_str(&self) -> &'static str {
        match self {
            ChainId::Ethereum => "ethereum",
            ChainId::Polygon => "polygon",
            ChainId::Bsc => "bsc",
            ChainId::Arbitrum => "arbitrum",
            ChainId::Base => "base",
            ChainId::Solana => "solana",
            ChainId::Bitcoin => "bitcoin",
        }
    }
}

impl fmt::Display for ChainId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ChainId {
    type Err = AdapterError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "ethereum" | "eth" => Ok(ChainId::Ethereum),
            "polygon" | "matic" => Ok(ChainId::Polygon),
            "bsc" | "bnb" => Ok(ChainId::Bsc),
            "arbitrum" => Ok(ChainId::Arbitrum),
            "base" => Ok(ChainId::Base),
            "solana" | "sol" => Ok(ChainId::Solana),
            "bitcoin" | "btc" => Ok(ChainId::Bitcoin),
            other => Err(AdapterError::InvalidInput(format!("unknown chain: {other}"))),
        }
    }
}

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/// A chain-tagged, syntactically validated address.
///
/// Validation is intentionally *syntactic* (charset/length/prefix): full
/// checksum verification (EIP-55, base58check, bech32) belongs to
/// `wallet-core`, which owns key material and encoding.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Address {
    chain: ChainId,
    value: String,
}

const BASE58_ALPHABET: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32_CHARSET: &str = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

impl Address {
    /// Create a validated address for the given chain.
    pub fn new(chain: ChainId, value: impl Into<String>) -> Result<Self, AdapterError> {
        let mut value: String = value.into();
        let valid = if chain.is_evm() {
            // EVM addresses are case-insensitive; normalize to lowercase.
            let ok = value.len() == 42
                && value.starts_with("0x")
                && value[2..].chars().all(|c| c.is_ascii_hexdigit());
            if ok {
                value = value.to_ascii_lowercase();
            }
            ok
        } else {
            match chain {
                ChainId::Solana => {
                    (32..=44).contains(&value.len())
                        && value.chars().all(|c| BASE58_ALPHABET.contains(c))
                }
                ChainId::Bitcoin => is_plausible_bitcoin_address(&value),
                _ => unreachable!("all non-EVM chains handled above"),
            }
        };

        if valid {
            Ok(Address { chain, value })
        } else {
            Err(AdapterError::InvalidAddress {
                chain: chain.to_string(),
                value,
            })
        }
    }

    pub fn evm(chain: ChainId, value: impl Into<String>) -> Result<Self, AdapterError> {
        let chain_ok = chain.is_evm();
        let addr = Self::new(chain, value)?;
        if chain_ok {
            Ok(addr)
        } else {
            Err(AdapterError::InvalidInput(format!("{chain} is not an EVM chain")))
        }
    }

    pub fn solana(value: impl Into<String>) -> Result<Self, AdapterError> {
        Self::new(ChainId::Solana, value)
    }

    pub fn bitcoin(value: impl Into<String>) -> Result<Self, AdapterError> {
        Self::new(ChainId::Bitcoin, value)
    }

    pub fn chain(&self) -> ChainId {
        self.chain
    }

    pub fn as_str(&self) -> &str {
        &self.value
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.value)
    }
}

fn is_plausible_bitcoin_address(s: &str) -> bool {
    // bech32 / bech32m (bc1..., tb1..., bcrt1...)
    for prefix in ["bc1", "tb1", "bcrt1"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return (11..=87).contains(&rest.len())
                && rest.chars().all(|c| BECH32_CHARSET.contains(c));
        }
    }
    // legacy base58check (P2PKH "1...", P2SH "3...", testnet "m/n/2...")
    if s.starts_with(['1', '3', 'm', 'n', '2']) {
        return (26..=35).contains(&s.len()) && s.chars().all(|c| BASE58_ALPHABET.contains(c));
    }
    false
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/// Balance of a single asset (native coin or token) in base units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenBalance {
    /// Ticker symbol ("ETH", "USDC", ...). For unknown SPL mints this is "SPL".
    pub symbol: String,
    /// Number of decimals of the asset.
    pub decimals: u8,
    /// Amount in base units (wei / lamports / satoshi / token base units).
    pub amount: u128,
    /// Contract address / mint. `None` for the native coin.
    pub token_address: Option<String>,
    /// USD valuation, filled by a price service (not by adapters).
    pub usd_value: Option<f64>,
}

impl TokenBalance {
    /// Human-readable amount (`amount / 10^decimals`). Lossy for display only.
    pub fn ui_amount(&self) -> f64 {
        self.amount as f64 / 10f64.powi(self.decimals as i32)
    }
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/// A chain-specific fee rate.
///
/// Externally tagged in JSON (`{"eip1559": {...}}`) — serde's internal
/// tagging does not support `u128` payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeeRate {
    /// EVM EIP-1559 parameters, in wei.
    Eip1559 {
        max_fee_per_gas: u128,
        max_priority_fee_per_gas: u128,
    },
    /// Bitcoin fee rate in satoshis per virtual byte.
    BitcoinSatPerVb { sat_per_vbyte: u64 },
    /// Solana: fixed base fee per signature + compute-unit priority price.
    SolanaPriority {
        base_fee_lamports: u64,
        priority_fee_micro_lamports: u64,
    },
}

/// Three-tier fee estimate (TZ §F3.2–F3.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeEstimate {
    pub slow: FeeRate,
    pub standard: FeeRate,
    pub fast: FeeRate,
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/// An *unsigned* transfer intent produced by [`crate::ChainAdapter::build_transfer`].
///
/// Signing and final wire-format serialization happen in `wallet-core`.
/// For EVM ERC-20 transfers, `to` is the human recipient, `token` is the
/// contract, and `data` contains the ready `transfer(to, amount)` calldata —
/// the on-chain `to` of the signed transaction must be the token contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TxRequest {
    pub chain: ChainId,
    pub from: Address,
    pub to: Address,
    /// Amount in base units of the transferred asset.
    pub amount: u128,
    /// Token contract / SPL mint. `None` for a native-coin transfer.
    pub token: Option<Address>,
    /// EVM calldata (ERC-20 `transfer`), empty for other chains.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    /// Selected fee rate, if the caller already chose a tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee: Option<FeeRate>,
    /// EVM nonce, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<u64>,
}

/// Lifecycle status of a transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    Pending,
    Confirmed,
    Failed,
    Unknown,
}

/// One history entry (TZ §F3.6). Field availability varies per chain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransactionRecord {
    pub chain: ChainId,
    /// Transaction hash / Solana signature / Bitcoin txid.
    pub hash: String,
    pub from: Option<String>,
    pub to: Option<String>,
    /// Net amount in native base units, relative to the queried address.
    pub amount: Option<u128>,
    /// Token contract/mint if this was a token movement.
    pub token_address: Option<String>,
    /// Fee paid, in native base units.
    pub fee: Option<u128>,
    pub status: TxStatus,
    pub block_height: Option<u64>,
    /// Unix timestamp (seconds).
    pub timestamp: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_id_roundtrip_and_props() {
        for chain in ChainId::ALL {
            assert_eq!(chain.as_str().parse::<ChainId>().unwrap(), chain);
        }
        assert_eq!(ChainId::Ethereum.evm_chain_id(), Some(1));
        assert_eq!(ChainId::Base.evm_chain_id(), Some(8453));
        assert_eq!(ChainId::Solana.evm_chain_id(), None);
        assert!(ChainId::Arbitrum.is_evm());
        assert!(!ChainId::Bitcoin.is_evm());
        assert_eq!(ChainId::Solana.native_decimals(), 9);
        assert_eq!(ChainId::Bitcoin.native_symbol(), "BTC");
        assert!("dogecoin".parse::<ChainId>().is_err());
    }

    #[test]
    fn evm_address_validation_and_normalization() {
        let a = Address::new(ChainId::Ethereum, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")
            .unwrap();
        assert_eq!(a.as_str(), "0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
        assert_eq!(a.chain(), ChainId::Ethereum);

        assert!(Address::new(ChainId::Ethereum, "0x1234").is_err());
        assert!(Address::new(ChainId::Ethereum, "d8da6bf26964af9d7eed9e03e53415d37aa96045").is_err());
        assert!(Address::new(ChainId::Ethereum, "0xZZda6bf26964af9d7eed9e03e53415d37aa96045").is_err());
    }

    #[test]
    fn solana_address_validation() {
        assert!(Address::solana("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T").is_ok());
        // '0', 'O', 'I', 'l' are not in base58
        assert!(Address::solana("0Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T").is_err());
        assert!(Address::solana("tooshort").is_err());
    }

    #[test]
    fn bitcoin_address_validation() {
        assert!(Address::bitcoin("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").is_ok());
        assert!(Address::bitcoin("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").is_ok());
        assert!(Address::bitcoin("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").is_ok());
        assert!(Address::bitcoin("bc1BADCHARSET").is_err());
        assert!(Address::bitcoin("xyz").is_err());
    }

    #[test]
    fn token_balance_ui_amount() {
        let b = TokenBalance {
            symbol: "USDC".into(),
            decimals: 6,
            amount: 12_345_678,
            token_address: Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()),
            usd_value: Some(12.34),
        };
        assert!((b.ui_amount() - 12.345678).abs() < 1e-9);
    }

    #[test]
    fn fee_estimate_serde_roundtrip() {
        let est = FeeEstimate {
            slow: FeeRate::Eip1559 {
                max_fee_per_gas: 20_000_000_000,
                max_priority_fee_per_gas: 1_000_000_000,
            },
            standard: FeeRate::BitcoinSatPerVb { sat_per_vbyte: 12 },
            fast: FeeRate::SolanaPriority {
                base_fee_lamports: 5000,
                priority_fee_micro_lamports: 10_000,
            },
        };
        let json = serde_json::to_string(&est).unwrap();
        let back: FeeEstimate = serde_json::from_str(&json).unwrap();
        assert_eq!(back, est);
    }
}
