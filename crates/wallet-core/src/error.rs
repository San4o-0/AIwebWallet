//! Explicit error types for the wallet core.

use thiserror::Error;

/// All errors produced by `wallet-core`.
#[derive(Debug, Error)]
pub enum WalletError {
    /// Invalid or unparsable BIP-39 mnemonic phrase.
    #[error("invalid mnemonic: {0}")]
    Mnemonic(String),

    /// Unsupported mnemonic word count (only 12 and 24 are allowed).
    #[error("unsupported word count: {0} (expected 12 or 24)")]
    WordCount(usize),

    /// HD key derivation failed.
    #[error("key derivation failed: {0}")]
    Derivation(String),

    /// Signing failed.
    #[error("signing failed: {0}")]
    Signing(String),

    /// Key-derivation function (Argon2id) failed.
    #[error("kdf error: {0}")]
    Kdf(String),

    /// AEAD encryption failed.
    #[error("encryption failed")]
    Encryption,

    /// Decryption failed — almost always a wrong password (or corrupted vault).
    #[error("invalid password or corrupted vault")]
    InvalidPassword,

    /// Unsupported vault format version.
    #[error("unsupported vault version: {0}")]
    VaultVersion(u8),

    /// (De)serialization error.
    #[error("serialization error: {0}")]
    Serialization(String),

    /// Malformed input (bad hex, wrong length, etc.).
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

impl From<serde_json::Error> for WalletError {
    fn from(e: serde_json::Error) -> Self {
        WalletError::Serialization(e.to_string())
    }
}
