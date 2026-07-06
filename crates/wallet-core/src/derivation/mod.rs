//! HD key derivation and per-chain signers.
//!
//! Paths (per the spec):
//! - EVM:     `m/44'/60'/0'/0/x`  (BIP-44, secp256k1, EIP-55 address)
//! - Solana:  `m/44'/501'/x'/0'`  (SLIP-0010 ed25519, base58 address)
//! - Bitcoin: `m/84'/0'/x'/0/0`   (BIP-84 Native SegWit, bech32 address)

pub mod bitcoin;
pub mod evm;
pub mod solana;

use serde::{Deserialize, Serialize};

use crate::error::WalletError;

/// Addresses for one HD account index across all supported chains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivedAddresses {
    /// Account index `x` used in the derivation paths.
    pub index: u32,
    /// EIP-55 checksummed EVM address (`0x…`).
    pub evm: String,
    /// Base58-encoded Solana public key.
    pub solana: String,
    /// Bech32 (`bc1…`) Native SegWit Bitcoin address (mainnet).
    pub bitcoin: String,
}

/// Derive addresses for all supported chains at the given account index.
pub fn derive_addresses(seed: &[u8; 64], index: u32) -> Result<DerivedAddresses, WalletError> {
    let evm = evm::EvmSigner::from_seed(seed, index)?;
    let sol = solana::SolanaSigner::from_seed(seed, index);
    let btc = bitcoin::BitcoinAccount::from_seed(seed, index, ::bitcoin::Network::Bitcoin)?;
    Ok(DerivedAddresses {
        index,
        evm: evm.address(),
        solana: sol.address(),
        bitcoin: btc.address(),
    })
}
