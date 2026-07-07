//! Encrypted vault: password → Argon2id → AES-256-GCM.
//!
//! The plaintext vault (`VaultData`) holds the mnemonic and account metadata.
//! `encrypt_vault` produces a self-describing `EncryptedVault` (KDF params,
//! salt, nonce, ciphertext) that is safe to persist in `chrome.storage.local`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::WalletError;

/// Current vault format version.
pub const VAULT_VERSION: u8 = 1;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Domain-separation tag mixed into the AEAD as associated data.
const AAD: &[u8] = b"ai-wallet/vault/v1";

/// Metadata for one derived account (public data only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountMeta {
    /// User-visible account name.
    pub name: String,
    /// HD derivation index `x`.
    pub index: u32,
    /// EIP-55 EVM address.
    pub evm_address: String,
    /// Base58 Solana address.
    pub solana_address: String,
    /// Bech32 Bitcoin address.
    pub bitcoin_address: String,
    /// Base58check TRON address (`T…`). `#[serde(default)]`: vault'и,
    /// створені до появи TRON, розшифровуються з порожнім рядком —
    /// background доозначує адресу при першому розблокуванні.
    #[serde(default)]
    pub tron_address: String,
}

/// Plaintext vault contents. Zeroized on drop.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct VaultData {
    /// BIP-39 mnemonic phrase (the only true secret in the vault).
    pub mnemonic: String,
    /// Public account metadata (no secrets — skipped by zeroize).
    #[zeroize(skip)]
    pub accounts: Vec<AccountMeta>,
}

/// Argon2id parameters stored alongside the ciphertext so old vaults keep
/// decrypting after defaults change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost: u32,
    /// Iterations.
    pub t_cost: u32,
    /// Parallelism.
    pub p_cost: u32,
}

impl Default for KdfParams {
    /// Memory-hard defaults: 64 MiB, 3 iterations, 1 lane.
    fn default() -> Self {
        Self {
            m_cost: 64 * 1024,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

/// Encrypted, serializable vault blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedVault {
    /// Format version.
    pub version: u8,
    /// Argon2id parameters used for this blob.
    pub kdf: KdfParams,
    /// Hex-encoded random salt (16 bytes).
    pub salt: String,
    /// Hex-encoded random AES-GCM nonce (12 bytes).
    pub nonce: String,
    /// Hex-encoded ciphertext (includes the GCM tag).
    pub ciphertext: String,
}

/// Encrypt the vault with the default (memory-hard) Argon2id parameters.
pub fn encrypt_vault(data: &VaultData, password: &str) -> Result<EncryptedVault, WalletError> {
    encrypt_vault_with_params(data, password, KdfParams::default())
}

/// Encrypt the vault with explicit Argon2id parameters.
pub fn encrypt_vault_with_params(
    data: &VaultData,
    password: &str,
    kdf: KdfParams,
) -> Result<EncryptedVault, WalletError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let key = derive_key(password.as_bytes(), &salt, &kdf)?;
    let plaintext = Zeroizing::new(serde_json::to_vec(data)?);

    let cipher = Aes256Gcm::new((&*key).into());
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: AAD,
            },
        )
        .map_err(|_| WalletError::Encryption)?;

    Ok(EncryptedVault {
        version: VAULT_VERSION,
        kdf,
        salt: hex::encode(salt),
        nonce: hex::encode(nonce),
        ciphertext: hex::encode(ciphertext),
    })
}

/// Decrypt the vault. Returns `WalletError::InvalidPassword` when the password
/// is wrong or the blob has been tampered with (GCM tag mismatch).
pub fn decrypt_vault(vault: &EncryptedVault, password: &str) -> Result<VaultData, WalletError> {
    if vault.version != VAULT_VERSION {
        return Err(WalletError::VaultVersion(vault.version));
    }

    let salt = decode_hex_fixed::<SALT_LEN>(&vault.salt, "salt")?;
    let nonce = decode_hex_fixed::<NONCE_LEN>(&vault.nonce, "nonce")?;
    let ciphertext = hex::decode(&vault.ciphertext)
        .map_err(|_| WalletError::InvalidInput("ciphertext is not valid hex".into()))?;

    let key = derive_key(password.as_bytes(), &salt, &vault.kdf)?;
    let cipher = Aes256Gcm::new((&*key).into());
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: AAD,
                },
            )
            .map_err(|_| WalletError::InvalidPassword)?,
    );

    Ok(serde_json::from_slice(&plaintext)?)
}

/// password + salt → 32-byte AES key via Argon2id.
fn derive_key(
    password: &[u8],
    salt: &[u8],
    kdf: &KdfParams,
) -> Result<Zeroizing<[u8; KEY_LEN]>, WalletError> {
    let params = Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(KEY_LEN))
        .map_err(|e| WalletError::Kdf(e.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(password, salt, key.as_mut())
        .map_err(|e| WalletError::Kdf(e.to_string()))?;
    Ok(key)
}

fn decode_hex_fixed<const N: usize>(input: &str, field: &str) -> Result<[u8; N], WalletError> {
    let bytes = hex::decode(input)
        .map_err(|_| WalletError::InvalidInput(format!("{field} is not valid hex")))?;
    bytes
        .try_into()
        .map_err(|_| WalletError::InvalidInput(format!("{field} has wrong length")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fast-but-valid Argon2 params so the test suite stays quick.
    fn test_kdf() -> KdfParams {
        KdfParams {
            m_cost: 8 * 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    fn sample_vault() -> VaultData {
        VaultData {
            mnemonic: "test test test test test test test test test test test junk".into(),
            accounts: vec![AccountMeta {
                name: "Account 1".into(),
                index: 0,
                evm_address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266".into(),
                solana_address: "11111111111111111111111111111111".into(),
                bitcoin_address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu".into(),
                tron_address: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8".into(),
            }],
        }
    }

    /// Vault, зашифрований ДО появи TRON (без tron_address у JSON),
    /// має розшифровуватися з порожньою TRON-адресою (serde default).
    #[test]
    fn legacy_vault_without_tron_address_decrypts() {
        let legacy_json = r#"{
            "mnemonic": "test test test test test test test test test test test junk",
            "accounts": [{
                "name": "Account 1",
                "index": 0,
                "evm_address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                "solana_address": "11111111111111111111111111111111",
                "bitcoin_address": "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
            }]
        }"#;
        let data: VaultData = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(data.accounts[0].tron_address, "");

        // Повний цикл: старий формат шифрується/розшифровується без втрат.
        let encrypted = encrypt_vault_with_params(&data, "pw", test_kdf()).unwrap();
        let decrypted = decrypt_vault(&encrypted, "pw").unwrap();
        assert_eq!(decrypted.accounts[0].tron_address, "");
        assert_eq!(decrypted.accounts[0].evm_address, data.accounts[0].evm_address);
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let vault = sample_vault();
        let encrypted = encrypt_vault_with_params(&vault, "correct horse battery staple", test_kdf()).unwrap();
        let decrypted = decrypt_vault(&encrypted, "correct horse battery staple").unwrap();
        assert_eq!(decrypted.mnemonic, vault.mnemonic);
        assert_eq!(decrypted.accounts, vault.accounts);
    }

    #[test]
    fn wrong_password_fails() {
        let encrypted =
            encrypt_vault_with_params(&sample_vault(), "right password", test_kdf()).unwrap();
        // Note: `VaultData` intentionally has no `Debug` impl (mnemonic must
        // not leak into logs), so extract the error via `.err()`.
        let err = decrypt_vault(&encrypted, "wrong password").err().unwrap();
        assert!(matches!(err, WalletError::InvalidPassword));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let mut encrypted =
            encrypt_vault_with_params(&sample_vault(), "password", test_kdf()).unwrap();
        // Flip the last hex nibble of the ciphertext.
        let mut chars: Vec<char> = encrypted.ciphertext.chars().collect();
        let last = chars.last_mut().unwrap();
        *last = if *last == '0' { '1' } else { '0' };
        encrypted.ciphertext = chars.into_iter().collect();
        assert!(matches!(
            decrypt_vault(&encrypted, "password"),
            Err(WalletError::InvalidPassword)
        ));
    }

    #[test]
    fn salts_and_nonces_are_random() {
        let a = encrypt_vault_with_params(&sample_vault(), "pw", test_kdf()).unwrap();
        let b = encrypt_vault_with_params(&sample_vault(), "pw", test_kdf()).unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn unknown_version_is_rejected() {
        let mut encrypted =
            encrypt_vault_with_params(&sample_vault(), "pw", test_kdf()).unwrap();
        encrypted.version = 99;
        assert!(matches!(
            decrypt_vault(&encrypted, "pw"),
            Err(WalletError::VaultVersion(99))
        ));
    }

    #[test]
    fn encrypted_vault_survives_json_serialization() {
        let encrypted =
            encrypt_vault_with_params(&sample_vault(), "pw", test_kdf()).unwrap();
        let json = serde_json::to_string(&encrypted).unwrap();
        let restored: EncryptedVault = serde_json::from_str(&json).unwrap();
        let decrypted = decrypt_vault(&restored, "pw").unwrap();
        assert_eq!(decrypted.mnemonic, sample_vault().mnemonic);
    }

    /// The default parameters must be memory-hard (>= 64 MiB) and functional.
    #[test]
    fn default_params_roundtrip() {
        assert!(KdfParams::default().m_cost >= 64 * 1024);
        let encrypted = encrypt_vault(&sample_vault(), "pw").unwrap();
        assert!(decrypt_vault(&encrypted, "pw").is_ok());
    }
}
