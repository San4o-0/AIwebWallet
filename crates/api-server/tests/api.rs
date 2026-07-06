//! Інтеграційні тести роутера через tower::ServiceExt::oneshot.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use api_server::config::Config;
use api_server::routes::build_router;
use api_server::state::AppState;

fn app() -> axum::Router {
    build_router(AppState::new(Config::default()))
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn health_returns_ok() {
    let resp = app()
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["status"], "ok");
    assert!(json["version"].is_string());
}

#[tokio::test]
async fn tx_risk_flags_unlimited_approve_as_high() {
    // approve(spender, U256::MAX)
    let calldata = format!(
        "0x095ea7b3{:0>64}{}",
        "1111111254eeb25477b68fb85ed929f73a960582",
        "f".repeat(64)
    );
    let body = json!({
        "chain": "ethereum",
        "tx_request": {
            "from": "0xd1c24f50d05946b3fabefbae3cd0a7e9938c63f2",
            "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "data": calldata
        },
        "dapp_origin": "https://app.uniswap.org",
        "sign_method": "eth_sendTransaction"
    });

    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/tx/risk")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["level"], "high");
    assert_eq!(json["requires_confirmation"], true);
    let reasons = json["reasons"].as_array().unwrap();
    assert!(reasons
        .iter()
        .any(|r| r["code"] == "unlimited_approve"));
}

#[tokio::test]
async fn tx_risk_plain_transfer_is_low() {
    let body = json!({
        "chain": "ethereum",
        "tx_request": {
            "from": "0xd1c24f50d05946b3fabefbae3cd0a7e9938c63f2",
            "to": "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            "value": "0xde0b6b3a7640000"
        },
        "sign_method": "eth_sendTransaction"
    });

    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/tx/risk")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["level"], "low");
    assert_eq!(json["requires_confirmation"], false);
    assert!(json["reasons"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn tx_explain_returns_ukrainian_rule_based_text() {
    let body = json!({
        "decoded": {
            "chain": "ethereum",
            "action": "approve",
            "selector": "0x095ea7b3",
            "symbol": "USDC",
            "spender": "0x1111111254eeb25477b68fb85ed929f73a960582",
            "unlimited": true
        },
        "lang": "uk"
    });

    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/tx/explain")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["source"], "rule_based");
    assert_eq!(json["lang"], "uk");
    assert!(json["explanation"]
        .as_str()
        .unwrap()
        .contains("ВСІ ваші USDC"));
}
