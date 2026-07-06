//! EVM: BIP-44 secp256k1 derivation, EIP-55 addresses, recoverable signatures.

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::Secp256k1;
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::error::WalletError;

/// A 65-byte recoverable secp256k1 signature over a 32-byte hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmSignature {
    /// `r` component (32 bytes).
    pub r: [u8; 32],
    /// `s` component (32 bytes, low-S normalized).
    pub s: [u8; 32],
    /// Recovery id (0 or 1). For legacy Ethereum encoding add 27.
    pub v: u8,
}

impl EvmSignature {
    /// Serialize as `r || s || v` (65 bytes), `v` ∈ {0, 1}.
    pub fn to_bytes(&self) -> [u8; 65] {
        let mut out = [0u8; 65];
        out[..32].copy_from_slice(&self.r);
        out[32..64].copy_from_slice(&self.s);
        out[64] = self.v;
        out
    }
}

/// secp256k1 signer for one EVM account (`m/44'/60'/0'/0/index`).
pub struct EvmSigner {
    signing_key: SigningKey,
}

impl EvmSigner {
    /// Derive the signer at `m/44'/60'/0'/0/{index}` from a BIP-39 seed.
    pub fn from_seed(seed: &[u8; 64], index: u32) -> Result<Self, WalletError> {
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(bitcoin::NetworkKind::Main, seed)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;
        let path: DerivationPath = format!("m/44'/60'/0'/0/{index}")
            .parse()
            .map_err(|e: bitcoin::bip32::Error| WalletError::Derivation(e.to_string()))?;
        let child = master
            .derive_priv(&secp, &path)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;
        let sk_bytes = Zeroizing::new(child.private_key.secret_bytes());
        Self::from_private_key(&sk_bytes)
    }

    /// Build a signer directly from a raw 32-byte private key (per-chain import).
    pub fn from_private_key(private_key: &[u8; 32]) -> Result<Self, WalletError> {
        let signing_key = SigningKey::from_bytes(private_key.into())
            .map_err(|e| WalletError::Derivation(e.to_string()))?;
        Ok(Self { signing_key })
    }

    /// EIP-55 checksummed address (`0x…`).
    pub fn address(&self) -> String {
        let verifying_key = self.signing_key.verifying_key();
        pubkey_to_address(verifying_key)
    }

    /// Raw private key bytes. Handle with care; wrap in `Zeroizing` at call sites.
    pub fn private_key_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.signing_key.to_bytes().into())
    }

    /// Sign a 32-byte prehashed message (e.g. a keccak256 transaction hash)
    /// and return the recoverable signature.
    pub fn sign_hash(&self, hash: &[u8; 32]) -> Result<EvmSignature, WalletError> {
        let (signature, recovery_id): (Signature, RecoveryId) = self
            .signing_key
            .sign_prehash_recoverable(hash)
            .map_err(|e| WalletError::Signing(e.to_string()))?;
        let bytes = signature.to_bytes();
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&bytes[..32]);
        s.copy_from_slice(&bytes[32..]);
        Ok(EvmSignature {
            r,
            s,
            v: recovery_id.to_byte(),
        })
    }
}

/// keccak256(pubkey_uncompressed[1..])[12..] with EIP-55 checksum.
fn pubkey_to_address(key: &VerifyingKey) -> String {
    let encoded = key.to_encoded_point(false);
    // Skip the 0x04 uncompressed prefix.
    let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    to_eip55(&addr)
}

/// Apply the EIP-55 mixed-case checksum to a raw 20-byte address.
fn to_eip55(address: &[u8; 20]) -> String {
    let lower = hex::encode(address);
    let hash = Keccak256::digest(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = if i % 2 == 0 {
            hash[i / 2] >> 4
        } else {
            hash[i / 2] & 0x0f
        };
        if nibble >= 8 {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mnemonic::mnemonic_to_seed;

    /// Well-known development mnemonic (Hardhat/Anvil default accounts).
    const TEST_MNEMONIC: &str =
        "test test test test test test test test test test test junk";

    #[test]
    fn derives_known_hardhat_addresses() {
        let seed = mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        let signer0 = EvmSigner::from_seed(&seed, 0).unwrap();
        assert_eq!(signer0.address(), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
        let signer1 = EvmSigner::from_seed(&seed, 1).unwrap();
        assert_eq!(signer1.address(), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    }

    #[test]
    fn signature_recovers_to_signer_address() {
        let seed = mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        let signer = EvmSigner::from_seed(&seed, 0).unwrap();

        let hash: [u8; 32] = Keccak256::digest(b"ai-wallet test message").into();
        let sig = signer.sign_hash(&hash).unwrap();

        let signature = Signature::from_slice(&sig.to_bytes()[..64]).unwrap();
        let recovery_id = RecoveryId::from_byte(sig.v).unwrap();
        let recovered =
            VerifyingKey::recover_from_prehash(&hash, &signature, recovery_id).unwrap();
        assert_eq!(pubkey_to_address(&recovered), signer.address());
    }

    #[test]
    fn eip55_checksum_known_vectors() {
        // Vectors from the EIP-55 specification.
        let cases = [
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
            "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
        ];
        for expected in cases {
            let raw: [u8; 20] = hex::decode(expected.to_lowercase().trim_start_matches("0x"))
                .unwrap()
                .try_into()
                .unwrap();
            assert_eq!(to_eip55(&raw), expected);
        }
    }
}
