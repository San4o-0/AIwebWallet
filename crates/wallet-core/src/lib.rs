//! # wallet-core
//!
//! Crypto core of AI Wallet (non-custodial browser-extension wallet).
//! Compiles natively and for `wasm32-unknown-unknown` (no tokio, no `std::fs`).
//!
//! Responsibilities:
//! - **Mnemonics** — BIP-39 generation (12/24 words), validation, seed recovery.
//! - **HD derivation** — EVM (`m/44'/60'/0'/0/x`, secp256k1, EIP-55),
//!   Solana (`m/44'/501'/x'/0'`, SLIP-0010 ed25519, base58),
//!   Bitcoin (`m/84'/0'/x'/0/0`, BIP-84 Native SegWit bech32),
//!   TRON (`m/44'/195'/0'/0/x`, secp256k1, base58check `T…`).
//! - **Signing** — EVM recoverable ECDSA over 32-byte hashes, Solana ed25519
//!   over arbitrary bytes; Bitcoin exposes WIF/xprv for BDK (PSBT signing TODO).
//! - **Vault** — password → Argon2id → AES-256-GCM encrypted storage with
//!   random salt/nonce; secrets are zeroized on drop.
//!
//! Enable the `wasm` feature for `wasm-bindgen` bindings (kept behind the
//! feature gate so native builds pull no wasm dependencies).

#![forbid(unsafe_code)]

pub mod derivation;
pub mod error;
pub mod evm_tx;
pub mod mnemonic;
pub mod vault;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use derivation::bitcoin::BitcoinAccount;
pub use derivation::evm::{EvmSignature, EvmSigner};
pub use derivation::solana::SolanaSigner;
pub use derivation::tron::TronSigner;
pub use derivation::{derive_addresses, DerivedAddresses};
pub use error::WalletError;
pub use evm_tx::{eip191_hash, erc20_transfer_calldata, keccak256, personal_sign, TxEip1559};
pub use mnemonic::{generate_mnemonic, mnemonic_to_seed, validate_mnemonic, WordCount};
pub use vault::{
    decrypt_vault, encrypt_vault, encrypt_vault_with_params, AccountMeta, EncryptedVault,
    KdfParams, VaultData,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: mnemonic → vault → unlock → derive → sign.
    #[test]
    fn full_wallet_lifecycle() {
        let phrase = generate_mnemonic(WordCount::Words12).unwrap();
        let seed = mnemonic_to_seed(&phrase, "").unwrap();
        let addresses = derive_addresses(&seed, 0).unwrap();
        assert!(addresses.evm.starts_with("0x"));
        assert!(addresses.bitcoin.starts_with("bc1q"));
        assert!(addresses.tron.starts_with('T'));

        let vault = VaultData {
            mnemonic: phrase.to_string(),
            accounts: vec![AccountMeta {
                name: "Account 1".into(),
                index: 0,
                evm_address: addresses.evm.clone(),
                solana_address: addresses.solana.clone(),
                bitcoin_address: addresses.bitcoin.clone(),
                tron_address: addresses.tron.clone(),
            }],
        };
        let kdf = KdfParams {
            m_cost: 8 * 1024,
            t_cost: 1,
            p_cost: 1,
        };
        let encrypted = encrypt_vault_with_params(&vault, "hunter2!", kdf).unwrap();
        let unlocked = decrypt_vault(&encrypted, "hunter2!").unwrap();
        assert_eq!(unlocked.mnemonic, *phrase);

        // Re-derive from the unlocked vault and sign on both chains.
        let seed2 = mnemonic_to_seed(&unlocked.mnemonic, "").unwrap();
        let evm = EvmSigner::from_seed(&seed2, 0).unwrap();
        assert_eq!(evm.address(), addresses.evm);
        let sig = evm.sign_hash(&[0x42u8; 32]).unwrap();
        assert!(sig.v <= 1);

        let sol = SolanaSigner::from_seed(&seed2, 0);
        assert_eq!(sol.address(), addresses.solana);
        let sol_sig = sol.sign(b"hello");
        assert!(derivation::solana::verify(
            &sol.public_key_bytes(),
            b"hello",
            &sol_sig
        ));
    }
}
