//! EVM-транзакції: EIP-1559 (type-2) збірка/RLP/keccak256-підпис і
//! EIP-191 `personal_sign`.
//!
//! Власна мінімальна RLP-реалізація (лише кодування, яке потрібно для
//! type-2 транзакцій) — без додаткових залежностей, компілюється у
//! `wasm32-unknown-unknown`. Правильність зафіксована тестами з еталонними
//! векторами, згенерованими незалежною реалізацією (`eth-account`).

use serde::Deserialize;
use sha3::{Digest, Keccak256};

use crate::derivation::evm::{EvmSignature, EvmSigner};
use crate::error::WalletError;

/// keccak256 довільних байтів.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

// ---------------------------------------------------------------------------
// Мінімальний RLP-енкодер
// ---------------------------------------------------------------------------

/// RLP-кодування байтового рядка (item).
fn rlp_bytes(out: &mut Vec<u8>, data: &[u8]) {
    match data.len() {
        1 if data[0] < 0x80 => out.push(data[0]),
        len @ 0..=55 => {
            out.push(0x80 + len as u8);
            out.extend_from_slice(data);
        }
        len => {
            let len_be_full = (len as u64).to_be_bytes();
            let len_be = strip_leading_zeros(&len_be_full);
            out.push(0xb7 + len_be.len() as u8);
            out.extend_from_slice(len_be);
            out.extend_from_slice(data);
        }
    }
}

/// RLP-кодування невід'ємного цілого: мінімальний big-endian без нулів
/// попереду; нуль кодується як порожній рядок (`0x80`).
fn rlp_uint(out: &mut Vec<u8>, value: u128) {
    rlp_bytes(out, strip_leading_zeros(&value.to_be_bytes()));
}

/// Обгортає готовий payload у RLP-список.
fn rlp_list(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 9);
    match payload.len() {
        len @ 0..=55 => out.push(0xc0 + len as u8),
        len => {
            let len_be_full = (len as u64).to_be_bytes();
            let len_be = strip_leading_zeros(&len_be_full);
            out.push(0xf7 + len_be.len() as u8);
            out.extend_from_slice(len_be);
        }
    }
    out.extend_from_slice(payload);
    out
}

fn strip_leading_zeros(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    &bytes[start..]
}

// ---------------------------------------------------------------------------
// EIP-1559 транзакція
// ---------------------------------------------------------------------------

/// EIP-1559 (type-2) транзакція без access list (MVP: перекази й виклики).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxEip1559 {
    pub chain_id: u64,
    pub nonce: u64,
    /// Wei.
    pub max_priority_fee_per_gas: u128,
    /// Wei.
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    /// `None` — деплой контракту.
    pub to: Option<[u8; 20]>,
    /// Wei.
    pub value: u128,
    /// Calldata (порожній для нативного переказу).
    pub data: Vec<u8>,
}

/// JSON-представлення параметрів транзакції для WASM-межі: всі числа —
/// рядки (десяткові або `0x`-hex), щоб не втрачати точність у JS.
#[derive(Debug, Deserialize)]
struct TxEip1559Json {
    chain_id: String,
    nonce: String,
    max_priority_fee_per_gas: String,
    max_fee_per_gas: String,
    gas_limit: String,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    data: Option<String>,
}

/// Парсить кількісне значення: `0x…`-hex або десятковий рядок.
fn parse_quantity(field: &str, value: &str) -> Result<u128, WalletError> {
    let value = value.trim();
    let parsed = if let Some(hex_digits) = value.strip_prefix("0x").or_else(|| value.strip_prefix("0X")) {
        if hex_digits.is_empty() {
            Ok(0) // "0x" зустрічається в dApp-запитах як нуль
        } else {
            u128::from_str_radix(hex_digits, 16)
        }
    } else {
        value.parse::<u128>()
    };
    parsed.map_err(|_| WalletError::InvalidInput(format!("{field}: некоректне число `{value}`")))
}

fn parse_u64(field: &str, value: &str) -> Result<u64, WalletError> {
    u64::try_from(parse_quantity(field, value)?)
        .map_err(|_| WalletError::InvalidInput(format!("{field}: значення завелике")))
}

fn parse_address(value: &str) -> Result<[u8; 20], WalletError> {
    let raw = hex::decode(value.trim().trim_start_matches("0x"))
        .map_err(|_| WalletError::InvalidInput(format!("адреса не є hex: {value}")))?;
    raw.try_into()
        .map_err(|_| WalletError::InvalidInput(format!("адреса має бути 20 байтів: {value}")))
}

impl TxEip1559 {
    /// Розбирає JSON-параметри (див. [`TxEip1559Json`]): усі числові поля —
    /// рядки (hex `0x…` або десяткові), `to` може бути відсутнім/`null`
    /// (деплой), `data` — hex-рядок calldata.
    pub fn from_json(json: &str) -> Result<Self, WalletError> {
        let p: TxEip1559Json = serde_json::from_str(json)
            .map_err(|e| WalletError::InvalidInput(format!("параметри транзакції: {e}")))?;
        let to = match p.to.as_deref() {
            None | Some("") => None,
            Some(addr) => Some(parse_address(addr)?),
        };
        let data = match p.data.as_deref() {
            None | Some("") | Some("0x") => Vec::new(),
            Some(d) => hex::decode(d.trim_start_matches("0x"))
                .map_err(|_| WalletError::InvalidInput("data не є hex".into()))?,
        };
        let tx = TxEip1559 {
            chain_id: parse_u64("chain_id", &p.chain_id)?,
            nonce: parse_u64("nonce", &p.nonce)?,
            max_priority_fee_per_gas: parse_quantity(
                "max_priority_fee_per_gas",
                &p.max_priority_fee_per_gas,
            )?,
            max_fee_per_gas: parse_quantity("max_fee_per_gas", &p.max_fee_per_gas)?,
            gas_limit: parse_u64("gas_limit", &p.gas_limit)?,
            to,
            value: parse_quantity("value", p.value.as_deref().unwrap_or("0"))?,
            data,
        };
        if tx.max_fee_per_gas < tx.max_priority_fee_per_gas {
            return Err(WalletError::InvalidInput(
                "max_fee_per_gas < max_priority_fee_per_gas".into(),
            ));
        }
        Ok(tx)
    }

    /// RLP-payload дев'яти полів (без підпису):
    /// `[chain_id, nonce, prio, max_fee, gas, to, value, data, access_list]`.
    fn rlp_fields(&self) -> Vec<u8> {
        let mut p = Vec::with_capacity(64 + self.data.len());
        rlp_uint(&mut p, self.chain_id as u128);
        rlp_uint(&mut p, self.nonce as u128);
        rlp_uint(&mut p, self.max_priority_fee_per_gas);
        rlp_uint(&mut p, self.max_fee_per_gas);
        rlp_uint(&mut p, self.gas_limit as u128);
        match &self.to {
            Some(addr) => rlp_bytes(&mut p, addr),
            None => rlp_bytes(&mut p, &[]),
        }
        rlp_uint(&mut p, self.value);
        rlp_bytes(&mut p, &self.data);
        p.extend_from_slice(&rlp_list(&[])); // порожній access list
        p
    }

    /// Хеш для підпису: `keccak256(0x02 || rlp([…9 полів]))` (EIP-2718/1559).
    pub fn signing_hash(&self) -> [u8; 32] {
        let mut preimage = vec![0x02u8];
        preimage.extend_from_slice(&rlp_list(&self.rlp_fields()));
        keccak256(&preimage)
    }

    /// Серіалізує підписану транзакцію:
    /// `0x02 || rlp([…9 полів, y_parity, r, s])` — готово для
    /// `eth_sendRawTransaction`.
    pub fn raw_signed(&self, sig: &EvmSignature) -> Vec<u8> {
        let mut payload = self.rlp_fields();
        rlp_uint(&mut payload, sig.v as u128); // y_parity: 0 або 1
        rlp_bytes(&mut payload, strip_leading_zeros(&sig.r));
        rlp_bytes(&mut payload, strip_leading_zeros(&sig.s));
        let mut raw = vec![0x02u8];
        raw.extend_from_slice(&rlp_list(&payload));
        raw
    }

    /// Підписує транзакцію та повертає `(raw_tx, tx_hash)`.
    /// `tx_hash = keccak256(raw_tx)`.
    pub fn sign(&self, signer: &EvmSigner) -> Result<(Vec<u8>, [u8; 32]), WalletError> {
        let sig = signer.sign_hash(&self.signing_hash())?;
        let raw = self.raw_signed(&sig);
        let hash = keccak256(&raw);
        Ok((raw, hash))
    }
}

// ---------------------------------------------------------------------------
// EIP-191 personal_sign
// ---------------------------------------------------------------------------

/// Хеш EIP-191: `keccak256("\x19Ethereum Signed Message:\n" + len + message)`.
pub fn eip191_hash(message: &[u8]) -> [u8; 32] {
    let mut preimage =
        Vec::with_capacity(26 + 20 + message.len());
    preimage.extend_from_slice(b"\x19Ethereum Signed Message:\n");
    preimage.extend_from_slice(message.len().to_string().as_bytes());
    preimage.extend_from_slice(message);
    keccak256(&preimage)
}

/// `personal_sign`: підпис EIP-191-хеша повідомлення.
/// Повертає 65 байтів `r || s || v`, де `v ∈ {27, 28}` (легасі-кодування,
/// яке очікують dApps/`ecrecover`).
pub fn personal_sign(signer: &EvmSigner, message: &[u8]) -> Result<[u8; 65], WalletError> {
    let sig = signer.sign_hash(&eip191_hash(message))?;
    let mut out = sig.to_bytes();
    out[64] = sig.v + 27;
    Ok(out)
}

// ---------------------------------------------------------------------------
// ERC-20 calldata
// ---------------------------------------------------------------------------

/// ABI-кодування `transfer(address,uint256)` (селектор `0xa9059cbb`).
pub fn erc20_transfer_calldata(to: &str, amount: u128) -> Result<Vec<u8>, WalletError> {
    let to = parse_address(to)?;
    let mut data = Vec::with_capacity(4 + 64);
    data.extend_from_slice(&[0xa9, 0x05, 0x9c, 0xbb]);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&to);
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&amount.to_be_bytes());
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mnemonic::mnemonic_to_seed;
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    /// Hardhat/Anvil девелоперська мнемоніка; акаунт 0 =
    /// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266.
    const TEST_MNEMONIC: &str = "test test test test test test test test test test test junk";

    fn hardhat_signer() -> EvmSigner {
        let seed = mnemonic_to_seed(TEST_MNEMONIC, "").unwrap();
        EvmSigner::from_seed(&seed, 0).unwrap()
    }

    #[test]
    fn keccak256_known_vectors() {
        // keccak256("") — відомий як codeHash порожнього акаунта Ethereum.
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        assert_eq!(
            hex::encode(keccak256(b"abc")),
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
    }

    #[test]
    fn rlp_known_vectors() {
        // Канонічні приклади зі специфікації RLP (Ethereum wiki).
        let enc_bytes = |data: &[u8]| {
            let mut out = Vec::new();
            rlp_bytes(&mut out, data);
            out
        };
        assert_eq!(enc_bytes(b"dog"), hex::decode("83646f67").unwrap());
        assert_eq!(enc_bytes(b""), vec![0x80]);
        assert_eq!(enc_bytes(&[0x0f]), vec![0x0f]);
        assert_eq!(enc_bytes(&[0x04, 0x00]), hex::decode("820400").unwrap());
        // "Lorem ipsum dolor sit amet, consectetur adipisicing elit" (56 байтів)
        let lorem = b"Lorem ipsum dolor sit amet, consectetur adipisicing elit";
        let enc = enc_bytes(lorem);
        assert_eq!(&enc[..2], &[0xb8, 0x38]);
        assert_eq!(&enc[2..], lorem);

        let mut uint = Vec::new();
        rlp_uint(&mut uint, 0);
        assert_eq!(uint, vec![0x80]);
        uint.clear();
        rlp_uint(&mut uint, 1024);
        assert_eq!(uint, hex::decode("820400").unwrap());

        // список ["cat", "dog"]
        let mut payload = Vec::new();
        rlp_bytes(&mut payload, b"cat");
        rlp_bytes(&mut payload, b"dog");
        assert_eq!(rlp_list(&payload), hex::decode("c88363617483646f67").unwrap());
        assert_eq!(rlp_list(&[]), vec![0xc0]);
    }

    /// Еталон згенеровано незалежною реалізацією eth-account 0.13.7:
    /// нативний переказ 0.01 ETH, chain_id=1, nonce=7, prio=1.5 gwei,
    /// max_fee=30 gwei, gas=21000, ключ Hardhat-акаунта 0.
    #[test]
    fn eip1559_native_transfer_matches_eth_account_vector() {
        let tx = TxEip1559 {
            chain_id: 1,
            nonce: 7,
            max_priority_fee_per_gas: 1_500_000_000,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 21_000,
            to: Some(parse_address("0x70997970C51812dc3A010C7d01b50e0d17dc79C8").unwrap()),
            value: 10_000_000_000_000_000, // 0.01 ETH
            data: Vec::new(),
        };
        let (raw, hash) = tx.sign(&hardhat_signer()).unwrap();
        assert_eq!(
            hex::encode(&raw),
            "02f87201078459682f008506fc23ac008252089470997970c51812dc3a010c7d01b50e0d17dc79c8\
             872386f26fc1000080c001a0710aaf06a4fb69d088a091e597ad99a516856937b2aed7197be84b79\
             7279273da05878f2f1e426cc79f68fb73f7550374033a9e3608f286c246948a17e7470d2ca"
        );
        assert_eq!(
            hex::encode(hash),
            "8d6945ebdb6d36c44d8696daaaa0a567f48e0bec8cc7bc328147826436759bc4"
        );
    }

    /// Еталон eth-account: ERC-20 transfer(USDC) — data non-empty, value=0,
    /// nonce=8, gas=65000.
    #[test]
    fn eip1559_erc20_transfer_matches_eth_account_vector() {
        let data = erc20_transfer_calldata(
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            1_000_000,
        )
        .unwrap();
        let tx = TxEip1559 {
            chain_id: 1,
            nonce: 8,
            max_priority_fee_per_gas: 1_500_000_000,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 65_000,
            to: Some(parse_address("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48").unwrap()),
            value: 0,
            data,
        };
        let (raw, hash) = tx.sign(&hardhat_signer()).unwrap();
        assert_eq!(
            hex::encode(&raw),
            "02f8b001088459682f008506fc23ac0082fde894a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\
             80b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800\
             000000000000000000000000000000000000000000000000000000000f4240c080a0bd1e2278ba9d\
             c64193308f17f51dab6ce83ea233c202249319931d80a52cfc4da0472c3881c2d1ab1ba1996ad8b9\
             98316b8c1920e9e0b6136ed65f9b5079466f25"
        );
        assert_eq!(
            hex::encode(hash),
            "80e53c392da8db8e59ac029b06c3617b1f5d5a119251d3c291925c0abedde535"
        );
    }

    /// Еталон eth-account: деплой контракту (`to = None`).
    #[test]
    fn eip1559_contract_creation_matches_eth_account_vector() {
        let tx = TxEip1559 {
            chain_id: 1,
            nonce: 0,
            max_priority_fee_per_gas: 1_500_000_000,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 100_000,
            to: None,
            value: 0,
            data: hex::decode("600160015500").unwrap(),
        };
        let (raw, hash) = tx.sign(&hardhat_signer()).unwrap();
        assert_eq!(
            hex::encode(&raw),
            "02f85e01808459682f008506fc23ac00830186a0808086600160015500c080a0d6f5b9151cc928f2\
             354f9b558bd37d180374b2b38494ff3df81059fff575e809a06a57f7dabfc2734dcd77d63e3c7e32\
             4f27019c10f8e4babf7774df1a9c42b13b"
        );
        assert_eq!(
            hex::encode(hash),
            "2614aa8bbc64837d39a1be79aae7fc04c3e97f6915728c2211a96c5cdebcb126"
        );
    }

    /// Еталон eth-account: personal_sign("Hello AI Wallet") ключем
    /// Hardhat-акаунта 0.
    #[test]
    fn personal_sign_matches_eth_account_vector() {
        assert_eq!(
            hex::encode(eip191_hash(b"Hello AI Wallet")),
            "4ccea8f356ecb1e1c9583dc65125902cf8c7550312edb67c0ffc53165908b4f3"
        );
        let sig = personal_sign(&hardhat_signer(), b"Hello AI Wallet").unwrap();
        assert_eq!(
            hex::encode(sig),
            "b5f24d6128c1773cbc6fecb2c536cbd237bb6cc27a2e07ef15a7a8bf1ce1c7ad\
             70cc3b44eb5d16ad149c633e5eff8df0a4357194dc903a149f3dd8b4b4ed5c16\
             1b"
        );
        assert!(sig[64] == 27 || sig[64] == 28);
    }

    /// Підпис signing-хеша відновлюється до адреси підписанта.
    #[test]
    fn signature_recovers_signer_from_signing_hash() {
        let signer = hardhat_signer();
        let tx = TxEip1559 {
            chain_id: 137,
            nonce: 3,
            max_priority_fee_per_gas: 30_000_000_000,
            max_fee_per_gas: 120_000_000_000,
            gas_limit: 21_000,
            to: Some([0x11; 20]),
            value: 1,
            data: Vec::new(),
        };
        let hash = tx.signing_hash();
        let sig = signer.sign_hash(&hash).unwrap();
        let signature = Signature::from_slice(&sig.to_bytes()[..64]).unwrap();
        let recovery_id = RecoveryId::from_byte(sig.v).unwrap();
        let recovered =
            VerifyingKey::recover_from_prehash(&hash, &signature, recovery_id).unwrap();
        // Порівнюємо через адресу нашого ж деривованого ключа.
        let recovered_signer = {
            use sha3::{Digest, Keccak256};
            let point = recovered.to_encoded_point(false);
            let h = Keccak256::digest(&point.as_bytes()[1..]);
            format!("0x{}", hex::encode(&h[12..]))
        };
        assert_eq!(
            recovered_signer.to_lowercase(),
            signer.address().to_lowercase()
        );
    }

    #[test]
    fn from_json_parses_hex_and_decimal() {
        let tx = TxEip1559::from_json(
            r#"{
                "chain_id": "0x1",
                "nonce": "7",
                "max_priority_fee_per_gas": "0x59682f00",
                "max_fee_per_gas": "30000000000",
                "gas_limit": "0x5208",
                "to": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                "value": "0x2386f26fc10000",
                "data": "0x"
            }"#,
        )
        .unwrap();
        assert_eq!(tx.chain_id, 1);
        assert_eq!(tx.nonce, 7);
        assert_eq!(tx.max_priority_fee_per_gas, 1_500_000_000);
        assert_eq!(tx.max_fee_per_gas, 30_000_000_000);
        assert_eq!(tx.gas_limit, 21_000);
        assert_eq!(tx.value, 10_000_000_000_000_000);
        assert!(tx.data.is_empty());

        // to відсутнє → деплой; value відсутнє → 0.
        let deploy = TxEip1559::from_json(
            r#"{"chain_id":"1","nonce":"0","max_priority_fee_per_gas":"1",
                "max_fee_per_gas":"2","gas_limit":"100000","data":"0x6001"}"#,
        )
        .unwrap();
        assert!(deploy.to.is_none());
        assert_eq!(deploy.value, 0);

        // Помилки: битий hex, max_fee < prio.
        assert!(TxEip1559::from_json("{").is_err());
        assert!(TxEip1559::from_json(
            r#"{"chain_id":"1","nonce":"0","max_priority_fee_per_gas":"5",
                "max_fee_per_gas":"2","gas_limit":"21000"}"#
        )
        .is_err());
        assert!(TxEip1559::from_json(
            r#"{"chain_id":"1","nonce":"zz","max_priority_fee_per_gas":"1",
                "max_fee_per_gas":"2","gas_limit":"21000"}"#
        )
        .is_err());
    }

    #[test]
    fn erc20_calldata_layout() {
        let data = erc20_transfer_calldata(
            "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
            1_000_000,
        )
        .unwrap();
        assert_eq!(
            hex::encode(data),
            "a9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045\
             00000000000000000000000000000000000000000000000000000000000f4240"
        );
    }
}
