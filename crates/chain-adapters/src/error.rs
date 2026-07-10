//! Unified error type for all chain adapters.

use thiserror::Error;

/// Errors produced by any [`crate::ChainAdapter`] implementation.
#[derive(Debug, Error)]
pub enum AdapterError {
    /// Underlying HTTP transport failure (timeouts, DNS, TLS, ...).
    #[error("http transport error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON (de)serialization failure.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// A JSON-RPC / REST node returned an application-level error.
    #[error("rpc error {code}: {message}")]
    Rpc { code: i64, message: String },

    /// Address failed validation for the target chain.
    #[error("invalid address for {chain}: {value}")]
    InvalidAddress { chain: String, value: String },

    /// A response could not be interpreted (unexpected shape, overflow, bad hex...).
    #[error("response parse error: {0}")]
    Parse(String),

    /// Caller supplied invalid input (zero amount, wrong chain, ...).
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// Operation is not supported by this adapter (yet).
    #[error("unsupported operation: {0}")]
    Unsupported(String),

    /// A transient upstream failure (429 / 5xx / network) that persisted after
    /// the retry budget was exhausted. Distinguished from one-shot errors so
    /// callers can back off or surface a "provider busy" state.
    #[error("rate limited: gave up after {attempts} attempt(s): {message}")]
    RateLimited { attempts: u32, message: String },
}

impl AdapterError {
    /// Helper for building a parse error from anything printable.
    pub fn parse(msg: impl Into<String>) -> Self {
        AdapterError::Parse(msg.into())
    }
}
