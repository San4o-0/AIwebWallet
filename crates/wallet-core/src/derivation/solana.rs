//! Solana: SLIP-0010 ed25519 derivation (`m/44'/501'/x'/0'`), base58 addresses,
//! ed25519 signatures over arbitrary bytes.

use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use zeroize::Zeroizing;

/// ed25519 signer for one Solana account (`m/44'/501'/index'/0'`).
pub struct SolanaSigner {
    signing_key: SigningKey,
}

impl SolanaSigner {
    /// Derive the signer at `m/44'/501'/{index}'/0'` (SLIP-0010, all segments
    /// hardened, as ed25519 requires) from a BIP-39 seed.
    pub fn from_seed(seed: &[u8; 64], index: u32) -> Self {
        // `slip10_ed25519` hardens every index internally (| 0x8000_0000).
        let key = Zeroizing::new(slip10_ed25519::derive_ed25519_private_key(
            seed,
            &[44, 501, index, 0],
        ));
        Self {
            signing_key: SigningKey::from_bytes(&key),
        }
    }

    /// Build a signer directly from a raw 32-byte ed25519 secret key.
    pub fn from_private_key(private_key: &[u8; 32]) -> Self {
        Self {
            signing_key: SigningKey::from_bytes(private_key),
        }
    }

    /// Solana address: base58-encoded 32-byte public key.
    pub fn address(&self) -> String {
        bs58::encode(self.signing_key.verifying_key().as_bytes()).into_string()
    }

    /// Raw 32-byte public key.
    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    /// Raw secret key bytes. Handle with care; wrap in `Zeroizing` at call sites.
    pub fn private_key_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.signing_key.to_bytes())
    }

    /// 64-byte Solana keypair encoding (secret || public), as used by CLI/Phantom exports.
    pub fn keypair_bytes(&self) -> Zeroizing<[u8; 64]> {
        Zeroizing::new(self.signing_key.to_keypair_bytes())
    }

    /// ed25519 signature over arbitrary bytes (e.g. a serialized Solana message).
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing_key.sign(message).to_bytes()
    }
}

/// Verify an ed25519 signature against a 32-byte public key.
pub fn verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    key.verify(message, &ed25519_dalek::Signature::from_bytes(signature))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mnemonic::mnemonic_to_seed;

    const VECTOR_PHRASE: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn derivation_is_deterministic_and_index_sensitive() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        let a = SolanaSigner::from_seed(&seed, 0);
        let b = SolanaSigner::from_seed(&seed, 0);
        let c = SolanaSigner::from_seed(&seed, 1);
        assert_eq!(a.address(), b.address());
        assert_ne!(a.address(), c.address());
    }

    #[test]
    fn address_is_base58_of_32_byte_pubkey() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        let signer = SolanaSigner::from_seed(&seed, 0);
        let decoded = bs58::decode(signer.address()).into_vec().unwrap();
        assert_eq!(decoded.len(), 32);
        assert_eq!(decoded, signer.public_key_bytes());
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        let signer = SolanaSigner::from_seed(&seed, 0);
        let message = b"ai-wallet solana test message";
        let signature = signer.sign(message);
        assert!(verify(&signer.public_key_bytes(), message, &signature));
        assert!(!verify(&signer.public_key_bytes(), b"tampered", &signature));
    }
}
