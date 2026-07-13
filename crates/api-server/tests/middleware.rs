//! Інтеграційні тести захисних мідлварів: CORS-allowlist і вхідний rate limiting.
//!
//! Через `tower::ServiceExt::oneshot` — без підняття сокета.
//! Увага: `oneshot` не дає `ConnectInfo`, тож усі запити в тесті йдуть від
//! однієї «IP» — саме те, що треба, аби перевірити спрацювання ліміту.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use api_server::config::Config;
use api_server::routes::build_router;
use api_server::state::AppState;

fn app_with(config: Config) -> axum::Router {
    build_router(AppState::new(config))
}

/// Дефолтний конфіг, але з високими лімітами — щоб CORS-тести не впиралися в 429.
fn cors_config(allowed_origins: Vec<String>) -> Config {
    Config {
        allowed_origins,
        rate_limit_rpm: 6000,
        rate_limit_burst: 1000,
        chat_rate_limit_rpm: 6000,
        chat_rate_limit_burst: 1000,
        ..Config::default()
    }
}

/// GET /v1/health з заданим Origin → значення `access-control-allow-origin`.
async fn acao_for(app: axum::Router, origin: &str) -> Option<String> {
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .header(header::ORIGIN, origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "сам запит має відпрацювати");
    resp.headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .map(|v| v.to_str().unwrap().to_string())
}

// ---------------------------------------------------------------- CORS

#[tokio::test]
async fn cors_dev_mode_blocks_web_pages() {
    // Без ALLOWED_ORIGINS (dev): звичайний сайт НЕ отримує ACAO → не прочитає відповідь.
    let acao = acao_for(app_with(cors_config(vec![])), "https://evil.com").await;
    assert_eq!(acao, None, "https://evil.com не має отримувати CORS-дозвіл");

    // Навіть якщо origin схожий на розширення, але це http(s)-сайт.
    let acao = acao_for(
        app_with(cors_config(vec![])),
        "https://chrome-extension.evil.com",
    )
    .await;
    assert_eq!(acao, None);
}

#[tokio::test]
async fn cors_dev_mode_allows_extension_and_localhost_origins() {
    let chrome = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    let acao = acao_for(app_with(cors_config(vec![])), chrome).await;
    assert_eq!(acao.as_deref(), Some(chrome));

    // Firefox: UUID випадковий на кожну інсталяцію — тільки за схемою.
    let firefox = "moz-extension://2c8a1b3d-4e5f-6789-abcd-ef0123456789";
    let acao = acao_for(app_with(cors_config(vec![])), firefox).await;
    assert_eq!(acao.as_deref(), Some(firefox));

    let local = "http://localhost:5173";
    let acao = acao_for(app_with(cors_config(vec![])), local).await;
    assert_eq!(acao.as_deref(), Some(local));
}

#[tokio::test]
async fn cors_strict_allowlist_permits_only_listed_origins() {
    let allowed = "chrome-extension://ppppppppppppppppppppppppppppppp1";
    let cfg = || cors_config(vec![allowed.to_string()]);

    assert_eq!(
        acao_for(app_with(cfg()), allowed).await.as_deref(),
        Some(allowed)
    );

    // Інше розширення — вже НЕ можна (у dev-режимі було б можна).
    let other_ext = "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz9";
    assert_eq!(acao_for(app_with(cfg()), other_ext).await, None);

    // Веб-сайт — тим паче.
    assert_eq!(acao_for(app_with(cfg()), "https://evil.com").await, None);
}

#[tokio::test]
async fn cors_preflight_rejects_evil_origin_and_allows_extension() {
    // Preflight від чужого сайту: без ACAO браузер заблокує сам запит.
    let resp = app_with(cors_config(vec![]))
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/v1/chat")
                .header(header::ORIGIN, "https://evil.com")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(resp
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .is_none());

    // Preflight від розширення: дозволено, з методами й заголовками.
    let ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    let resp = app_with(cors_config(vec![]))
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/v1/chat")
                .header(header::ORIGIN, ext)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let headers = resp.headers();
    assert_eq!(
        headers
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap()
            .to_str()
            .unwrap(),
        ext
    );
    let methods = headers
        .get(header::ACCESS_CONTROL_ALLOW_METHODS)
        .unwrap()
        .to_str()
        .unwrap()
        .to_ascii_uppercase();
    assert!(methods.contains("GET") && methods.contains("POST"));
    // Не permissive: небезпечних методів немає.
    assert!(!methods.contains("DELETE") && !methods.contains("PUT"));
}

// -------------------------------------------------------- Rate limiting

#[tokio::test]
async fn rate_limit_returns_429_with_json_error_and_retry_after() {
    // burst 2 → третій запит поспіль з тієї ж «IP» відхиляється.
    let app = app_with(Config {
        rate_limit_rpm: 1,
        rate_limit_burst: 2,
        ..Config::default()
    });

    for i in 0..2 {
        let resp = app
            .clone()
            .oneshot(Request::builder().uri("/v1/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "запит {i} мав пройти");
    }

    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/v1/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(
        resp.headers().contains_key(header::RETRY_AFTER),
        "429 має нести Retry-After"
    );

    // Формат помилки — той самий, що й у решти API: {"error": "..."}.
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(json["error"].is_string());
}

#[tokio::test]
async fn root_health_is_not_rate_limited() {
    // Корінний /health — для LB-проб, ліміт на нього не вішаємо.
    let app = app_with(Config {
        rate_limit_rpm: 1,
        rate_limit_burst: 1,
        ..Config::default()
    });
    for _ in 0..5 {
        let resp = app
            .clone()
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn chat_limit_is_stricter_than_global() {
    // Глобальний ліміт щедрий, AI-ліміт — burst 1.
    let app = app_with(Config {
        rate_limit_rpm: 600,
        rate_limit_burst: 100,
        chat_rate_limit_rpm: 1,
        chat_rate_limit_burst: 1,
        ..Config::default()
    });

    let chat_req = || {
        Request::builder()
            .method("POST")
            .uri("/v1/chat")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"messages": [{"role": "user", "content": "привіт"}]}).to_string(),
            ))
            .unwrap()
    };

    // Перший чат-запит проходить крізь лімітер (статус залежить від хендлера,
    // головне — не 429).
    let resp = app.clone().oneshot(chat_req()).await.unwrap();
    assert_ne!(resp.status(), StatusCode::TOO_MANY_REQUESTS);

    // Другий — уже 429, хоч глобальний ліміт далеко не вичерпано.
    let resp = app.clone().oneshot(chat_req()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);

    // Інші (дешеві) ендпоінти при цьому працюють — ліміти незалежні.
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/v1/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn tx_explain_shares_the_strict_ai_limit() {
    let app = app_with(Config {
        rate_limit_rpm: 600,
        rate_limit_burst: 100,
        chat_rate_limit_rpm: 1,
        chat_rate_limit_burst: 1,
        ..Config::default()
    });

    let explain_req = || {
        Request::builder()
            .method("POST")
            .uri("/v1/tx/explain")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"decoded": {"chain": "ethereum", "action": "transfer"}, "lang": "uk"})
                    .to_string(),
            ))
            .unwrap()
    };

    let resp = app.clone().oneshot(explain_req()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = app.clone().oneshot(explain_req()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
}
