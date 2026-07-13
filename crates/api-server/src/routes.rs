//! Роутер `/v1` + мідлвари (CORS, rate limiting, trace).
//!
//! # Модель загроз (ТЗ розділ 6, п.6)
//!
//! Бекенд тримає платні ключі (`OPENAI_API_KEY`, `ETHERSCAN_API_KEY`, RPC-квоти).
//! Без захисту публічний деплой = безкоштовний AI-проксі для всього інтернету.
//! Два різні механізми, які НЕ замінюють один одного:
//!
//! * **CORS** ([`cors_layer`]) — не дає чужому сайту читати відповіді нашого API
//!   з браузера користувача. Це захист КОРИСТУВАЧА, не наших ключів: `curl`,
//!   скрипт чи бот взагалі не надсилають `Origin` і не читають CORS-заголовки —
//!   для них CORS не існує. Ним НЕ можна захистити AI-проксі.
//! * **Rate limiting** ([`crate::ratelimit`]) — єдине, що реально обмежує
//!   спалювання ключів: працює для будь-якого клієнта, з Origin і без.
//!
//! TODO(автентифікація): справжнє рішення — анонімна сесія через підпис
//! повідомлення адресою гаманця (SIWE-подібно, ТЗ розділ 5): клієнт підписує
//! nonce, отримує короткоживучий токен, ліміти рахуються per-session, а не
//! per-IP (IP шариться через NAT/CGNAT і легко міняється). Не реалізовано.

use std::sync::Arc;

use axum::{
    http::{
        header::{ACCEPT, CONTENT_TYPE},
        request::Parts,
        HeaderValue, Method,
    },
    middleware::from_fn_with_state,
    routing::{get, post},
    Router,
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};

use crate::config::Config;
use crate::handlers;
use crate::ratelimit::{rate_limit, RateLimitConfig, RateLimiter};
use crate::state::AppState;

/// Схеми origin, яким довіряємо в dev-режимі (без `ALLOWED_ORIGINS`).
///
/// Firefox видає розширенню `moz-extension://<UUID>`, де UUID **випадковий на
/// кожну інсталяцію** — статичний allowlist для нього неможливий у принципі.
/// Chrome дає стабільний `chrome-extension://<id>`, його в проді слід явно
/// перелічити в `ALLOWED_ORIGINS`.
const EXTENSION_SCHEMES: [&str; 2] = ["chrome-extension://", "moz-extension://"];

/// Чи це localhost-origin (dev-зручність: Vite/`npm run dev`).
fn is_local_dev_origin(origin: &str) -> bool {
    origin.starts_with("http://localhost:")
        || origin.starts_with("http://127.0.0.1:")
        || origin == "http://localhost"
        || origin == "http://127.0.0.1"
}

/// CORS-політика.
///
/// * `ALLOWED_ORIGINS` заданий → **суворий allowlist**: тільки ці origin.
/// * не заданий (dev) → predicate: `chrome-extension://*`, `moz-extension://*`
///   і `http://localhost:*`.
///
/// В обох режимах звичайна веб-сторінка (`https://будь-який-сайт`) НЕ отримує
/// `access-control-allow-origin` і не може прочитати відповідь.
pub fn cors_layer(config: &Config) -> CorsLayer {
    let allow_origin = if config.allowed_origins.is_empty() {
        tracing::info!(
            "CORS: dev-режим (ALLOWED_ORIGINS не задано) — дозволено chrome-extension://*, \
             moz-extension://*, http://localhost:*. У проді задайте ALLOWED_ORIGINS."
        );
        AllowOrigin::predicate(|origin: &HeaderValue, _parts: &Parts| {
            let Ok(origin) = origin.to_str() else {
                return false;
            };
            EXTENSION_SCHEMES.iter().any(|s| origin.starts_with(s)) || is_local_dev_origin(origin)
        })
    } else {
        let list: Vec<HeaderValue> = config
            .allowed_origins
            .iter()
            .filter_map(|o| match HeaderValue::from_str(o) {
                Ok(v) => Some(v),
                Err(_) => {
                    tracing::warn!("CORS: некоректний origin у ALLOWED_ORIGINS, пропущено: {o}");
                    None
                }
            })
            .collect();
        tracing::info!(
            "CORS: суворий allowlist ({} origin): {}",
            list.len(),
            config.allowed_origins.join(", ")
        );
        AllowOrigin::list(list)
    };

    CorsLayer::new()
        .allow_origin(allow_origin)
        // Тільки те, що реально використовує розширення. OPTIONS потрібен
        // браузеру для preflight; DELETE/PUT/PATCH у нас немає.
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        // CONTENT_TYPE — JSON-тіла; ACCEPT — `text/event-stream` для стріму /v1/chat.
        .allow_headers([CONTENT_TYPE, ACCEPT])
}

/// Збирає повний роутер застосунку. Використовується і в main, і в тестах.
pub fn build_router(state: Arc<AppState>) -> Router {
    let cors = cors_layer(&state.config);

    // Два незалежні token-bucket лімітери per-IP.
    let global_limiter = RateLimiter::new(
        RateLimitConfig::new(state.config.rate_limit_rpm, state.config.rate_limit_burst),
        state.config.trust_proxy_headers,
    );
    // AI-ендпоінти коштують грошей за токени → окремий, значно жорсткіший ліміт.
    // Він застосовується ДОДАТКОВО до глобального (спрацьовує той, що суворіший).
    let ai_limiter = RateLimiter::new(
        RateLimitConfig::new(
            state.config.chat_rate_limit_rpm,
            state.config.chat_rate_limit_burst,
        ),
        state.config.trust_proxy_headers,
    );
    tracing::info!(
        "Rate limiting per-IP: /v1/* — {}/хв (burst {}), AI (/v1/chat, /v1/tx/explain) — {}/хв (burst {})",
        state.config.rate_limit_rpm,
        state.config.rate_limit_burst,
        state.config.chat_rate_limit_rpm,
        state.config.chat_rate_limit_burst,
    );

    // Найдорожчі ендпоінти: обидва можуть піти в OpenAI.
    let ai_routes = Router::new()
        .route("/tx/explain", post(handlers::tx::explain))
        .route("/chat", post(handlers::chat::chat))
        .layer(from_fn_with_state(ai_limiter, rate_limit));

    let v1 = Router::new()
        .route("/balances", post(handlers::balances::balances))
        .route("/history", get(handlers::history::history))
        .route("/fees", get(handlers::fees::fees))
        .route("/tx/params", get(handlers::tx_params::tx_params))
        .route("/tx/decode", post(handlers::tx::decode))
        .route("/tx/simulate", post(handlers::tx::simulate))
        .route("/tx/risk", post(handlers::tx::risk))
        .route("/tx/broadcast", post(handlers::tx::broadcast))
        .route("/analytics/fees", get(handlers::analytics::fees))
        .route("/analytics/summary", get(handlers::analytics::summary))
        .route("/prices", get(handlers::prices::prices))
        .route("/health", get(handlers::health::health))
        .merge(ai_routes)
        // Глобальний ліміт — на все /v1/*, включно з AI-роутами вище.
        .layer(from_fn_with_state(global_limiter, rate_limit));

    Router::new()
        .nest("/v1", v1)
        // Дублюємо health на корені для простих LB-проб — БЕЗ rate limiting,
        // інакше активний liveness-probe сам себе заблокує.
        .route("/health", get(handlers::health::health))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}
