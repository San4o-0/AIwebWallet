//! Мережеві тести проти публічних нод — запускаються вручну:
//! `cargo test -p api-server -- --ignored`
//!
//! Позначені `#[ignore]`, бо залежать від доступності публічних RPC.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use api_server::config::Config;
use api_server::routes::build_router;
use api_server::state::AppState;

const VITALIK: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOLANA_ADDR: &str = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const BITCOIN_ADDR: &str = "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97";

fn app() -> axum::Router {
    build_router(AppState::new(Config::default()))
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
#[ignore = "потребує доступу до публічних нод"]
async fn live_balances_return_real_data_or_per_chain_errors() {
    let body = json!({
        "addresses": {
            "evm": [VITALIK],
            "solana": [SOLANA_ADDR],
            "bitcoin": [BITCOIN_ADDR]
        }
    });
    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/balances")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    // 5 EVM + 1 Solana + 1 Bitcoin.
    let chains = json["chains"].as_array().unwrap();
    assert_eq!(chains.len(), 7);
    // Fail-safe: кожен запис — або реальний баланс, або має поле error.
    for cb in chains {
        assert!(cb["native"]["amount"].is_string());
        if cb["error"].is_null() {
            // Реальні дані: amount парситься як число.
            cb["native"]["amount"].as_str().unwrap().parse::<u128>().unwrap();
        }
    }
}

#[tokio::test]
#[ignore = "потребує доступу до CoinGecko"]
async fn live_prices_come_from_coingecko() {
    let resp = app()
        .oneshot(
            Request::builder()
                .uri("/v1/prices?ids=ethereum,bitcoin,solana")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    let eth = json["prices"]["ethereum"]["usd"].as_f64().unwrap();
    assert!(eth > 0.0, "ціна ETH має бути додатною, отримано {eth}");
}

#[tokio::test]
#[ignore = "потребує доступу до публічних нод"]
async fn live_fees_for_bitcoin_and_ethereum() {
    for chain in ["bitcoin", "ethereum", "solana"] {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/fees?chain={chain}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "fees для {chain}");
        let json = body_json(resp).await;
        assert_eq!(json["chain"], chain);
        assert!(json["estimate"]["standard"].is_object());
    }
}

#[tokio::test]
#[ignore = "потребує доступу до публічних нод"]
async fn live_simulate_native_transfer_from_vitalik() {
    // Реальна детермінована симуляція: баланс vitalik.eth «до» з ноди,
    // «після» = до − value − fee (F4.3).
    let body = json!({
        "chain": "ethereum",
        "tx_request": {
            "from": VITALIK,
            "to": "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            "value": "0x38d7ea4c68000" // 0.001 ETH
        },
        "signer": VITALIK
    });
    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/tx/simulate")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["success"], true);
    assert_eq!(json["simulated"], true);
    assert_eq!(json["will_revert"], false);
    let changes = json["balance_changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1);
    let ch = &changes[0];
    assert_eq!(ch["symbol"], "ETH");
    let before: f64 = ch["before"].as_str().unwrap().parse().unwrap();
    let after: f64 = ch["after"].as_str().unwrap().parse().unwrap();
    assert!(before > 0.0, "у vitalik.eth має бути ненульовий баланс");
    assert!(after < before);
    assert!(ch["delta"].as_str().unwrap().starts_with('-'));
    // eth_estimateGas може повернути трохи більше за 21000 (буфер ноди).
    let gas: u64 = json["gas_used"].as_str().unwrap().parse().unwrap();
    assert!((21_000..100_000).contains(&gas), "gas_used={gas}");
}

#[tokio::test]
#[ignore = "потребує доступу до публічних нод"]
async fn live_simulate_erc20_transfer_with_insufficient_balance() {
    // transfer(to, 10^12 USDC) від адреси без такої суми: eth_call на USDC
    // не revert-иться сам по собі? Ревертиться (SafeMath) → will_revert=true
    // АБО (залежно від ноди) детермінована математика з попередженням.
    let to_word = format!("{:0>64}", "ab5801a7d398351b8be11c439e05c5b3259aec9b");
    let amount_word = format!("{:0>64x}", 1_000_000_000_000_000_000u128); // 10^12 USDC
    let body = json!({
        "chain": "ethereum",
        "tx_request": {
            "from": VITALIK,
            "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "value": "0x0",
            "data": format!("0xa9059cbb{to_word}{amount_word}")
        },
        "signer": VITALIK
    });
    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/tx/simulate")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    // Або ловимо revert через eth_call, або математика показує недостачу.
    let reverted = json["will_revert"] == true;
    let warned = json["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap_or("").contains("Недостатньо"));
    assert!(reverted || warned, "очікував revert або попередження: {json}");
}

/// Мінімальний base58-декодер для тесту (щоб не тягнути bs58 у dev-deps).
fn base58_decode(s: &str) -> Vec<u8> {
    const ALPHABET: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut num: Vec<u8> = vec![0];
    for c in s.chars() {
        let digit = ALPHABET.find(c).expect("некоректний base58") as u32;
        let mut carry = digit;
        for byte in num.iter_mut().rev() {
            let val = (*byte as u32) * 58 + carry;
            *byte = (val & 0xff) as u8;
            carry = val >> 8;
        }
        while carry > 0 {
            num.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    // Провідні '1' — нульові байти.
    let zeros = s.chars().take_while(|c| *c == '1').count();
    let mut out = vec![0u8; zeros];
    let start = num.iter().position(|b| *b != 0).unwrap_or(num.len());
    out.extend_from_slice(&num[start..]);
    out
}

/// Серіалізує мінімальну legacy-транзакцію Solana: SystemProgram::transfer
/// із fee payer = `from` (підпис нульовий — simulateTransaction викликається
/// з sigVerify:false + replaceRecentBlockhash:true).
fn build_solana_transfer_tx(from_b58: &str, lamports: u64) -> Vec<u8> {
    let from = base58_decode(from_b58);
    assert_eq!(from.len(), 32);
    let mut tx = Vec::new();
    tx.push(1); // compact-u16: 1 підпис
    tx.extend_from_slice(&[0u8; 64]); // нульовий підпис
    // Message header.
    tx.push(1); // numRequiredSignatures
    tx.push(0); // numReadonlySignedAccounts
    tx.push(1); // numReadonlyUnsignedAccounts (System Program)
    tx.push(2); // compact-u16: 2 акаунти
    tx.extend_from_slice(&from); // [0] fee payer / відправник (=одержувач)
    tx.extend_from_slice(&[0u8; 32]); // [1] System Program (111...)
    tx.extend_from_slice(&[0u8; 32]); // recent blockhash (замінюється RPC)
    tx.push(1); // compact-u16: 1 інструкція
    tx.push(1); // program id index → System Program
    tx.push(2); // 2 акаунти в інструкції
    tx.push(0); // from
    tx.push(0); // to (самому собі)
    tx.push(12); // довжина data: u32 discriminator + u64 lamports
    tx.extend_from_slice(&2u32.to_le_bytes()); // SystemInstruction::Transfer
    tx.extend_from_slice(&lamports.to_le_bytes());
    tx
}

#[tokio::test]
#[ignore = "потребує доступу до публічних нод"]
async fn live_simulate_solana_is_real_simulate_transaction() {
    use base64::Engine as _;
    let tx = build_solana_transfer_tx(SOLANA_ADDR, 1_000);
    let body = json!({
        "chain": "solana",
        "tx_request": {
            "data": base64::engine::general_purpose::STANDARD.encode(&tx),
            "value": "1000"
        },
        "signer": SOLANA_ADDR
    });
    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/tx/simulate")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    // simulateTransaction реально виконався: або успіх, або конкретна
    // причина фейлу (напр., AccountNotFound для порожнього акаунта).
    assert_eq!(json["simulated"], true, "відповідь: {json}");
    if json["will_revert"] == true {
        assert!(json["revert_reason"].is_string());
    }
}

#[tokio::test]
#[ignore = "потребує доступу до mempool.space і CoinGecko"]
async fn live_bitcoin_analytics_fees_and_summary() {
    for endpoint in ["fees", "summary"] {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v1/analytics/{endpoint}?address={BITCOIN_ADDR}&period=1y"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "analytics/{endpoint}");
        let json = body_json(resp).await;
        assert_eq!(json["period"], "1y");
        assert_eq!(json["address"], BITCOIN_ADDR);
    }
}

#[tokio::test]
#[ignore = "потребує ETHERSCAN_API_KEY і доступ до Etherscan"]
async fn live_evm_history_via_etherscan() {
    if std::env::var("ETHERSCAN_API_KEY").is_err() {
        eprintln!("ETHERSCAN_API_KEY не задано — пропускаю");
        return;
    }
    let resp = app()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/history?address={VITALIK}&chain=ethereum&limit=10"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    let items = json["items"].as_array().unwrap();
    assert!(!items.is_empty(), "у vitalik.eth має бути історія");
    for item in items {
        assert_eq!(item["chain"], "ethereum");
        assert!(item["description"].as_str().unwrap().len() > 3);
    }
}

#[tokio::test]
#[ignore = "потребує ALCHEMY_API_KEY"]
async fn live_simulate_with_alchemy_asset_changes() {
    // Задокументований шлях alchemy_simulateAssetChanges (F4.3) —
    // тестується ЛИШЕ за наявності ключа.
    if std::env::var("ALCHEMY_API_KEY").is_err() {
        eprintln!("ALCHEMY_API_KEY не задано — пропускаю");
        return;
    }
    let body = json!({
        "chain": "ethereum",
        "tx_request": {
            "from": VITALIK,
            "to": "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            "value": "0x38d7ea4c68000"
        },
        "signer": VITALIK
    });
    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/tx/simulate")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["simulated"], true);
    assert!(!json["balance_changes"].as_array().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "потребує доступу до mempool.space"]
async fn live_bitcoin_history_is_real() {
    let resp = app()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/history?address={BITCOIN_ADDR}&chain=bitcoin&limit=5"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    let items = json["items"].as_array().unwrap();
    for item in items {
        assert_eq!(item["chain"], "bitcoin");
        assert_eq!(item["symbol"], "BTC");
    }
}
