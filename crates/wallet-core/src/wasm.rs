//! `wasm-bindgen` bindings for the browser extension (feature = "wasm").
//!
//! Complex values cross the boundary as JSON strings — the TypeScript side
//! parses them into typed objects. Errors surface as rejected promises /
//! thrown `Error`s with the `WalletError` display message.

use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::error::WalletError;
use crate::{derivation, evm_tx, mnemonic, vault};

fn js_err(e: WalletError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn seed_from(mnemonic_phrase: &str) -> Result<Zeroizing<[u8; 64]>, JsValue> {
    mnemonic::mnemonic_to_seed(mnemonic_phrase, "").map_err(js_err)
}

/// Generate a new BIP-39 mnemonic. `word_count` must be 12 or 24.
#[wasm_bindgen(js_name = generateMnemonic)]
pub fn generate_mnemonic(word_count: usize) -> Result<String, JsValue> {
    let wc = mnemonic::WordCount::try_from(word_count).map_err(js_err)?;
    let phrase = mnemonic::generate_mnemonic(wc).map_err(js_err)?;
    Ok(phrase.to_string())
}

/// Validate a BIP-39 mnemonic phrase.
#[wasm_bindgen(js_name = validateMnemonic)]
pub fn validate_mnemonic(phrase: &str) -> bool {
    mnemonic::validate_mnemonic(phrase).is_ok()
}

/// Create an encrypted vault from a mnemonic and password.
///
/// Derives account 0 addresses for all chains, encrypts with Argon2id +
/// AES-256-GCM and returns the `EncryptedVault` as a JSON string (safe to
/// store in `chrome.storage.local`).
#[wasm_bindgen(js_name = createVault)]
pub fn create_vault(
    mnemonic_phrase: &str,
    password: &str,
    account_name: &str,
) -> Result<String, JsValue> {
    mnemonic::validate_mnemonic(mnemonic_phrase).map_err(js_err)?;
    let seed = seed_from(mnemonic_phrase)?;
    let addresses = derivation::derive_addresses(&seed, 0).map_err(js_err)?;

    let data = vault::VaultData {
        mnemonic: mnemonic_phrase.trim().to_string(),
        accounts: vec![vault::AccountMeta {
            name: account_name.to_string(),
            index: 0,
            evm_address: addresses.evm,
            solana_address: addresses.solana,
            bitcoin_address: addresses.bitcoin,
            tron_address: addresses.tron,
        }],
    };
    let encrypted = vault::encrypt_vault(&data, password).map_err(js_err)?;
    serde_json::to_string(&encrypted).map_err(|e| js_err(e.into()))
}

/// Unlock an encrypted vault (JSON string) with a password.
/// Returns the plaintext `VaultData` as a JSON string.
/// Rejects with "invalid password or corrupted vault" on a wrong password.
#[wasm_bindgen(js_name = unlockVault)]
pub fn unlock_vault(vault_json: &str, password: &str) -> Result<String, JsValue> {
    let encrypted: vault::EncryptedVault =
        serde_json::from_str(vault_json).map_err(|e| js_err(e.into()))?;
    let data = vault::decrypt_vault(&encrypted, password).map_err(js_err)?;
    let out = serde_json::to_string(&data).map_err(|e| js_err(e.into()));
    drop(data); // zeroizes the mnemonic
    out
}

/// Derive addresses (EVM/Solana/Bitcoin/TRON) for the given account index.
/// Returns JSON:
/// `{"index":0,"evm":"0x…","solana":"…","bitcoin":"bc1…","tron":"T…"}`.
#[wasm_bindgen(js_name = deriveAddresses)]
pub fn derive_addresses(mnemonic_phrase: &str, index: u32) -> Result<String, JsValue> {
    let seed = seed_from(mnemonic_phrase)?;
    let addresses = derivation::derive_addresses(&seed, index).map_err(js_err)?;
    serde_json::to_string(&addresses).map_err(|e| js_err(e.into()))
}

/// Sign a 32-byte hash (hex, with or without `0x`) with the EVM key at
/// `m/44'/60'/0'/0/{index}`. Returns 65 bytes `r||s||v` as hex, `v` ∈ {0,1}.
#[wasm_bindgen(js_name = signEvmHash)]
pub fn sign_evm_hash(
    mnemonic_phrase: &str,
    index: u32,
    hash_hex: &str,
) -> Result<String, JsValue> {
    let raw = hex::decode(hash_hex.trim_start_matches("0x"))
        .map_err(|_| js_err(WalletError::InvalidInput("hash is not valid hex".into())))?;
    let hash: [u8; 32] = raw
        .try_into()
        .map_err(|_| js_err(WalletError::InvalidInput("hash must be 32 bytes".into())))?;

    let seed = seed_from(mnemonic_phrase)?;
    let signer = derivation::evm::EvmSigner::from_seed(&seed, index).map_err(js_err)?;
    let signature = signer.sign_hash(&hash).map_err(js_err)?;
    Ok(hex::encode(signature.to_bytes()))
}

/// Sign an EIP-1559 (type-2) transaction with the EVM key at
/// `m/44'/60'/0'/0/{index}`.
///
/// `tx_params_json` — JSON with string quantities (hex `0x…` or decimal):
/// `{chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
///   to?, value?, data?}`.
/// Returns JSON `{"raw_tx": "0x02…", "tx_hash": "0x…"}` — the raw tx is
/// ready for `eth_sendRawTransaction`, `tx_hash = keccak256(raw_tx)`.
#[wasm_bindgen(js_name = signEvmTransaction)]
pub fn sign_evm_transaction(
    mnemonic_phrase: &str,
    index: u32,
    tx_params_json: &str,
) -> Result<String, JsValue> {
    let tx = evm_tx::TxEip1559::from_json(tx_params_json).map_err(js_err)?;
    let seed = seed_from(mnemonic_phrase)?;
    let signer = derivation::evm::EvmSigner::from_seed(&seed, index).map_err(js_err)?;
    let (raw, hash) = tx.sign(&signer).map_err(js_err)?;
    Ok(format!(
        r#"{{"raw_tx":"0x{}","tx_hash":"0x{}"}}"#,
        hex::encode(raw),
        hex::encode(hash)
    ))
}

/// EIP-191 `personal_sign` with the EVM key at `m/44'/60'/0'/0/{index}`.
/// `message` — raw message bytes (the JS side decodes dApp hex payloads).
/// Returns the 65-byte signature `r || s || v` (`v` ∈ {27, 28}) as `0x…` hex.
#[wasm_bindgen(js_name = personalSign)]
pub fn personal_sign(
    mnemonic_phrase: &str,
    index: u32,
    message: &[u8],
) -> Result<String, JsValue> {
    let seed = seed_from(mnemonic_phrase)?;
    let signer = derivation::evm::EvmSigner::from_seed(&seed, index).map_err(js_err)?;
    let signature = evm_tx::personal_sign(&signer, message).map_err(js_err)?;
    Ok(format!("0x{}", hex::encode(signature)))
}

/// ABI-encode ERC-20 `transfer(to, amount)` calldata.
/// `amount` — decimal or hex (`0x…`) string in token base units.
/// Returns `0x…` hex calldata.
#[wasm_bindgen(js_name = erc20TransferCalldata)]
pub fn erc20_transfer_calldata(to: &str, amount: &str) -> Result<String, JsValue> {
    let amount = amount.trim();
    let parsed = if let Some(h) = amount.strip_prefix("0x") {
        u128::from_str_radix(h, 16)
    } else {
        amount.parse::<u128>()
    }
    .map_err(|_| js_err(WalletError::InvalidInput(format!("некоректна сума: {amount}"))))?;
    let data = evm_tx::erc20_transfer_calldata(to, parsed).map_err(js_err)?;
    Ok(format!("0x{}", hex::encode(data)))
}

/// Sign arbitrary bytes with the Solana key at `m/44'/501'/{index}'/0'`.
/// Returns the 64-byte ed25519 signature as base58.
#[wasm_bindgen(js_name = signSolanaMessage)]
pub fn sign_solana_message(
    mnemonic_phrase: &str,
    index: u32,
    message: &[u8],
) -> Result<String, JsValue> {
    let seed = seed_from(mnemonic_phrase)?;
    let signer = derivation::solana::SolanaSigner::from_seed(&seed, index);
    Ok(bs58::encode(signer.sign(message)).into_string())
}

/// Export the Bitcoin account-level xprv (`m/84'/0'/{index}'`) for BDK
/// descriptor wallets. TODO: replace with in-core PSBT signing.
#[wasm_bindgen(js_name = exportBitcoinXprv)]
pub fn export_bitcoin_xprv(mnemonic_phrase: &str, index: u32) -> Result<String, JsValue> {
    let seed = seed_from(mnemonic_phrase)?;
    let account =
        derivation::bitcoin::BitcoinAccount::from_seed(&seed, index, bitcoin::Network::Bitcoin)
            .map_err(js_err)?;
    Ok(account.account_xprv().to_string())
}

/// Export the WIF private key of the first Bitcoin receive address
/// (`m/84'/0'/{index}'/0/0`).
#[wasm_bindgen(js_name = exportBitcoinWif)]
pub fn export_bitcoin_wif(mnemonic_phrase: &str, index: u32) -> Result<String, JsValue> {
    let seed = seed_from(mnemonic_phrase)?;
    let account =
        derivation::bitcoin::BitcoinAccount::from_seed(&seed, index, bitcoin::Network::Bitcoin)
            .map_err(js_err)?;
    Ok(account.receive_key_wif().to_string())
}
