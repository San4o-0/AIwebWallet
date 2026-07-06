//! # chain-adapters
//!
//! Abstraction over blockchain networks for AI Wallet (TZ §2 F2/F3, §9).
//!
//! One trait — [`ChainAdapter`] — with three implementations:
//!
//! - [`EvmAdapter`] — Ethereum / Polygon / BSC / Arbitrum / Base over JSON-RPC
//! - [`SolanaAdapter`] — Solana over JSON-RPC
//! - [`BitcoinAdapter`] — Bitcoin over the mempool.space REST API
//!
//! Adapters deal exclusively with **public** data (addresses, unsigned
//! intents, signed bytes). Key management, transaction serialization and
//! signing live in `wallet-core`; adapters accept already-signed bytes for
//! [`ChainAdapter::broadcast`].
//!
//! ```no_run
//! use chain_adapters::{Address, ChainAdapter, ChainId, EvmAdapter};
//!
//! # async fn demo() -> Result<(), chain_adapters::AdapterError> {
//! let eth = EvmAdapter::new(ChainId::Ethereum, "https://eth.example/rpc")?;
//! let addr = Address::new(ChainId::Ethereum, "0xd8da6bf26964af9d7eed9e03e53415d37aa96045")?;
//! let balance = eth.get_native_balance(&addr).await?;
//! println!("{} {}", balance.ui_amount(), balance.symbol);
//! # Ok(())
//! # }
//! ```

pub mod bitcoin;
pub mod error;
pub mod evm;
mod jsonrpc;
pub mod solana;
pub mod types;

pub use bitcoin::BitcoinAdapter;
pub use error::AdapterError;
pub use evm::{EvmAdapter, TokenConfig};
pub use solana::SolanaAdapter;
pub use types::{
    Address, ChainId, FeeEstimate, FeeRate, TokenBalance, TransactionRecord, TxRequest, TxStatus,
};

use async_trait::async_trait;

/// Uniform async interface to a blockchain network.
///
/// Implementations must be cheap to clone or share (`Send + Sync`) so the
/// api-server can hold one adapter per configured network.
#[async_trait]
pub trait ChainAdapter: Send + Sync {
    /// Network served by this adapter instance.
    fn chain(&self) -> ChainId;

    /// Native-coin balance of `address` in base units (wei/lamports/satoshi).
    async fn get_native_balance(&self, address: &Address) -> Result<TokenBalance, AdapterError>;

    /// Token balances (ERC-20 / SPL). Empty for chains without tokens (BTC).
    async fn get_token_balances(&self, address: &Address)
        -> Result<Vec<TokenBalance>, AdapterError>;

    /// Current three-tier fee estimate (slow / standard / fast, TZ §F3.2–F3.4).
    async fn estimate_fees(&self) -> Result<FeeEstimate, AdapterError>;

    /// Build an unsigned transfer intent. `token = None` means native coin.
    ///
    /// The returned [`TxRequest`] is handed to `wallet-core` for
    /// serialization + signing; it never contains key material.
    async fn build_transfer(
        &self,
        from: &Address,
        to: &Address,
        amount: u128,
        token: Option<&Address>,
    ) -> Result<TxRequest, AdapterError>;

    /// Broadcast a fully signed transaction; returns the tx hash / signature / txid.
    async fn broadcast(&self, signed_tx: &[u8]) -> Result<String, AdapterError>;

    /// Page of transaction history for `address`.
    ///
    /// `cursor = None` returns the most recent page; pass the returned
    /// `next_cursor` to fetch older records. `next_cursor = None` means the
    /// history is exhausted.
    async fn get_transaction_history(
        &self,
        address: &Address,
        cursor: Option<String>,
    ) -> Result<(Vec<TransactionRecord>, Option<String>), AdapterError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The trait must stay object-safe: the api-server keeps a
    /// `HashMap<ChainId, Box<dyn ChainAdapter>>`.
    #[test]
    fn chain_adapter_is_object_safe() {
        fn assert_object_safe(_: &dyn ChainAdapter) {}

        let adapters: Vec<Box<dyn ChainAdapter>> = vec![
            Box::new(EvmAdapter::new(ChainId::Ethereum, "http://localhost:8545").unwrap()),
            Box::new(SolanaAdapter::new("http://localhost:8899")),
            Box::new(BitcoinAdapter::new()),
        ];
        for adapter in &adapters {
            assert_object_safe(adapter.as_ref());
        }
        assert_eq!(adapters[0].chain(), ChainId::Ethereum);
        assert_eq!(adapters[1].chain(), ChainId::Solana);
        assert_eq!(adapters[2].chain(), ChainId::Bitcoin);
    }
}
