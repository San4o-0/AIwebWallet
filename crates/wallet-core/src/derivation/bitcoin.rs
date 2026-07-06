//! Bitcoin: BIP-84 derivation (`m/84'/0'/x'/0/0`), Native SegWit (bech32) addresses.
//!
//! Full PSBT signing will live in the BDK-based flow (see `chain-adapters`);
//! this module exposes the derived keys (WIF / account xprv) that BDK consumes.

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::{Address, CompressedPublicKey, Network, PrivateKey};
use zeroize::Zeroizing;

use crate::error::WalletError;

/// One BIP-84 Bitcoin account: `m/84'/{coin}'/{index}'` with the first
/// external address at `…/0/0`.
pub struct BitcoinAccount {
    network: Network,
    /// Account-level extended private key: `m/84'/{coin}'/{index}'`.
    account_xprv: Xpriv,
    /// Key at `m/84'/{coin}'/{index}'/0/0` (first receive address).
    address_key: PrivateKey,
    address: Address,
}

impl BitcoinAccount {
    /// Derive the account at `m/84'/{coin}'/{index}'/0/0` from a BIP-39 seed.
    /// `coin` is 0 for mainnet and 1 for test networks, per SLIP-44.
    pub fn from_seed(seed: &[u8; 64], index: u32, network: Network) -> Result<Self, WalletError> {
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(network, seed)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;

        let coin = if network == Network::Bitcoin { 0 } else { 1 };
        let account_path: DerivationPath = format!("m/84'/{coin}'/{index}'")
            .parse()
            .map_err(|e: bitcoin::bip32::Error| WalletError::Derivation(e.to_string()))?;
        let account_xprv = master
            .derive_priv(&secp, &account_path)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;

        let receive_path: DerivationPath = "m/0/0"
            .parse()
            .map_err(|e: bitcoin::bip32::Error| WalletError::Derivation(e.to_string()))?;
        let child = account_xprv
            .derive_priv(&secp, &receive_path)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;

        let address_key = PrivateKey::new(child.private_key, network);
        let pubkey = CompressedPublicKey::from_private_key(&secp, &address_key)
            .map_err(|e| WalletError::Derivation(e.to_string()))?;
        let address = Address::p2wpkh(&pubkey, network);

        Ok(Self {
            network,
            account_xprv,
            address_key,
            address,
        })
    }

    /// First receive address (`bc1…` / `tb1…` bech32 Native SegWit).
    pub fn address(&self) -> String {
        self.address.to_string()
    }

    /// Network this account was derived for.
    pub fn network(&self) -> Network {
        self.network
    }

    /// WIF-encoded private key of the first receive address (for import/debug).
    pub fn receive_key_wif(&self) -> Zeroizing<String> {
        Zeroizing::new(self.address_key.to_wif())
    }

    /// Account-level xprv (`m/84'/{coin}'/{index}'`) as a base58 string.
    ///
    /// This is what a BDK descriptor wallet consumes, e.g.
    /// `wpkh({xprv}/0/*)` for receive and `wpkh({xprv}/1/*)` for change.
    ///
    /// TODO: replace raw key export with in-core PSBT signing
    /// (`bdk_wallet`/`bitcoin` PSBT signer) once the transaction flow lands.
    pub fn account_xprv(&self) -> Zeroizing<String> {
        Zeroizing::new(self.account_xprv.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mnemonic::mnemonic_to_seed;

    const VECTOR_PHRASE: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    /// Official BIP-84 test vector: first receive address for the standard mnemonic.
    #[test]
    fn bip84_standard_vector() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        let account = BitcoinAccount::from_seed(&seed, 0, Network::Bitcoin).unwrap();
        assert_eq!(
            account.address(),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
    }

    /// The exported account xprv must reproduce the same first receive address
    /// when `/0/0` is derived from it (this is exactly how BDK will use it).
    #[test]
    fn exported_xprv_reproduces_address() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        let account = BitcoinAccount::from_seed(&seed, 0, Network::Bitcoin).unwrap();

        let secp = Secp256k1::new();
        let xprv: Xpriv = account.account_xprv().parse().unwrap();
        let child = xprv
            .derive_priv(&secp, &"m/0/0".parse::<DerivationPath>().unwrap())
            .unwrap();
        let privkey = PrivateKey::new(child.private_key, Network::Bitcoin);
        let pubkey = CompressedPublicKey::from_private_key(&secp, &privkey).unwrap();
        let address = Address::p2wpkh(&pubkey, Network::Bitcoin);
        assert_eq!(address.to_string(), account.address());
    }

    #[test]
    fn different_indices_give_different_addresses() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        let a0 = BitcoinAccount::from_seed(&seed, 0, Network::Bitcoin).unwrap();
        let a1 = BitcoinAccount::from_seed(&seed, 1, Network::Bitcoin).unwrap();
        assert_ne!(a0.address(), a1.address());
        assert!(a0.address().starts_with("bc1q"));
        assert!(a1.address().starts_with("bc1q"));
    }

    #[test]
    fn testnet_addresses_use_tb1_and_coin_type_1() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        let t = BitcoinAccount::from_seed(&seed, 0, Network::Testnet).unwrap();
        assert!(t.address().starts_with("tb1q"));
    }
}
