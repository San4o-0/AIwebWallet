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
