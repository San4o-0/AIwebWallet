//! TRON: BIP-44 secp256k1 derivation (`m/44'/195'/0'/0/x`, як у TronLink),
//! base58check-адреси з префіксом `0x41`.
//!
//! Криптографія збігається з EVM (secp256k1 + keccak256 публічного ключа);
//! відрізняється лише derivation path і кодування адреси:
//! `base58check(0x41 || keccak256(pubkey)[12..])`.

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::Secp256k1;
use k256::ecdsa::{SigningKey, VerifyingKey};
// sha2::Digest і sha3::Digest — один трейт digest::Digest, імпорт один.
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use zeroize::Zeroizing;

use crate::error::WalletError;

/// Префікс байта версії TRON mainnet (адреси `T…`).
const TRON_MAINNET_PREFIX: u8 = 0x41;

/// secp256k1 signer одного TRON-акаунта (`m/44'/195'/0'/0/index`).
pub struct TronSigner {
    signing_key: SigningKey,
}

impl TronSigner {
    /// Деривує signer за шляхом `m/44'/195'/0'/0/{index}` з BIP-39 seed.
    pub fn from_seed(seed: &[u8; 64], index: u32) -> Result<Self, WalletError> {
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(bitcoin::NetworkKind::Main, seed)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;
        let path: DerivationPath = format!("m/44'/195'/0'/0/{index}")
            .parse()
            .map_err(|e: bitcoin::bip32::Error| WalletError::Derivation(e.to_string()))?;
        let child = master
            .derive_priv(&secp, &path)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;
        let sk_bytes = Zeroizing::new(child.private_key.secret_bytes());
        let signing_key = SigningKey::from_bytes((&*sk_bytes).into())
            .map_err(|e| WalletError::Derivation(e.to_string()))?;
        Ok(Self { signing_key })
    }

    /// Base58check-адреса mainnet (`T…`).
    pub fn address(&self) -> String {
        pubkey_to_address(self.signing_key.verifying_key())
    }

    /// Сирі байти приватного ключа (для майбутнього підпису транзакцій).
    pub fn private_key_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.signing_key.to_bytes().into())
    }
}

/// `base58check(0x41 || keccak256(pubkey_uncompressed[1..])[12..])`.
fn pubkey_to_address(key: &VerifyingKey) -> String {
    let encoded = key.to_encoded_point(false);
    let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    let mut payload = [0u8; 21];
    payload[0] = TRON_MAINNET_PREFIX;
    payload[1..].copy_from_slice(&hash[12..]);
    base58check(&payload)
}

/// Base58Check: `base58(payload || sha256(sha256(payload))[..4])`.
fn base58check(payload: &[u8]) -> String {
    let checksum = Sha256::digest(Sha256::digest(payload));
    let mut bytes = Vec::with_capacity(payload.len() + 4);
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(&checksum[..4]);
    bs58::encode(bytes).into_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mnemonic::mnemonic_to_seed;

    const TEST_MNEMONIC: &str =
        "test test test test test test test test test test test junk";

    /// Декодує base58check-адресу назад у 21-байтний payload з перевіркою
    /// контрольної суми (незалежна перевірка кодування).
    fn decode_base58check(address: &str) -> Vec<u8> {
        let raw = bs58::decode(address).into_vec().unwrap();
        assert!(raw.len() > 4);
        let (payload, checksum) = raw.split_at(raw.len() - 4);
        let expected = Sha256::digest(Sha256::digest(payload));
        assert_eq!(checksum, &expected[..4], "невірна контрольна сума base58check");
        payload.to_vec()
    }

    #[test]
    fn derives_valid_mainnet_address() {
        let seed = mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        let signer = TronSigner::from_seed(&seed, 0).unwrap();
        let address = signer.address();

        // Формат mainnet: T…, 34 символи.
        assert!(address.starts_with('T'), "адреса має починатися з T: {address}");
        assert_eq!(address.len(), 34);

        // Payload: 0x41 + 20 байтів keccak-хеша публічного ключа.
        let payload = decode_base58check(&address);
        assert_eq!(payload.len(), 21);
        assert_eq!(payload[0], TRON_MAINNET_PREFIX);

        let encoded = signer.signing_key.verifying_key().to_encoded_point(false);
        let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
        assert_eq!(&payload[1..], &hash[12..]);
    }

    /// Відомі вектори, отримані незалежною реалізацією (ethers v6:
    /// BIP-32 m/44'/195'/0'/0/x + keccak256 + base58check) — гарантія
    /// сумісності з TronLink та іншими гаманцями.
    #[test]
    fn matches_independent_derivation_vectors() {
        let seed = mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        let a0 = TronSigner::from_seed(&seed, 0).unwrap().address();
        let a1 = TronSigner::from_seed(&seed, 1).unwrap().address();
        assert_eq!(a0, "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6");
        assert_eq!(a1, "TPjjvMwjPoDC32V2dGDYTkLH4E5LAtBZ6C");
    }

    #[test]
    fn different_indices_give_different_addresses() {
        let seed = mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        let a0 = TronSigner::from_seed(&seed, 0).unwrap().address();
        let a1 = TronSigner::from_seed(&seed, 1).unwrap().address();
        assert_ne!(a0, a1);
        // Деривація детермінована.
        assert_eq!(a0, TronSigner::from_seed(&seed, 0).unwrap().address());
    }

    #[test]
    fn tron_path_differs_from_evm_key() {
        // Шлях m/44'/195' НЕ збігається з EVM m/44'/60' — ключі різні.
        let seed = mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        let tron = TronSigner::from_seed(&seed, 0).unwrap();
        let evm = crate::derivation::evm::EvmSigner::from_seed(&seed, 0).unwrap();
        assert_ne!(
            tron.private_key_bytes().as_slice(),
            evm.private_key_bytes().as_slice()
        );
    }
}
