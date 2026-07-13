//! Вхідний rate limiting (per-IP), ТЗ розділ 6, п.6.
//!
//! # Навіщо
//!
//! Без нього після деплою API стає відкритим AI-проксі: будь-хто може
//! качати `/v1/chat` і спалювати наш `OPENAI_API_KEY` (а також квоти
//! Etherscan/RPC). CORS від цього НЕ рятує — див. модуль [`crate::routes`].
//!
//! # Алгоритм
//!
//! Token bucket per-IP: місткість = `burst`, поповнення = `rpm / 60` токенів
//! на секунду. Дає рівний sustained-ліміт `rpm` запитів/хв, але дозволяє
//! короткий сплеск до `burst` (розширення на старті робить кілька паралельних
//! запитів: баланси + ціни + історія).
//!
//! Стан — in-memory `Mutex<HashMap<IpAddr, Bucket>>`.
//! TODO(redis): у проді з кількома репліками лічильники мають жити в Redis
//! (`REDIS_URL` вже є в конфізі), інакше ліміт множиться на число реплік.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// Скільки тримати неактивні відра, перш ніж прибрати їх (захист від росту мапи).
const IDLE_TTL: Duration = Duration::from_secs(600);
/// Прибирання протухлих відер запускається не частіше, ніж раз на стільки.
const GC_INTERVAL: Duration = Duration::from_secs(60);

/// Параметри одного ліміту.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    /// Sustained-ліміт: запитів за хвилину з однієї IP.
    pub rpm: u32,
    /// Місткість відра: скільки запитів поспіль можна зробити «залпом».
    pub burst: u32,
}

impl RateLimitConfig {
    pub fn new(rpm: u32, burst: u32) -> Self {
        // Нуль зробив би ендпоінт недоступним назавжди — підстраховуємось.
        Self { rpm: rpm.max(1), burst: burst.max(1) }
    }

    /// Токенів на секунду.
    fn refill_per_sec(&self) -> f64 {
        f64::from(self.rpm) / 60.0
    }
}

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

/// Token-bucket лімітер, спільний для всіх запитів одного ліміту.
#[derive(Debug)]
pub struct RateLimiter {
    config: RateLimitConfig,
    /// Чи довіряти `X-Forwarded-For` / `X-Real-IP` (тільки за реверс-проксі!).
    trust_proxy_headers: bool,
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
    last_gc: Mutex<Instant>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig, trust_proxy_headers: bool) -> Arc<Self> {
        Arc::new(Self {
            config,
            trust_proxy_headers,
            buckets: Mutex::new(HashMap::new()),
            last_gc: Mutex::new(Instant::now()),
        })
    }

    /// Списує один токен. `Ok(())` — пропускаємо, `Err(retry_after_secs)` — 429.
    fn check(&self, ip: IpAddr) -> Result<(), u64> {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().expect("rate limiter mutex");

        let bucket = buckets.entry(ip).or_insert_with(|| Bucket {
            tokens: f64::from(self.config.burst),
            last_refill: now,
        });

        // Поповнення пропорційно часу, що минув, до стелі burst.
        let elapsed = now.saturating_duration_since(bucket.last_refill).as_secs_f64();
        let refilled = bucket.tokens + elapsed * self.config.refill_per_sec();
        bucket.tokens = refilled.min(f64::from(self.config.burst));
        bucket.last_refill = now;

        let result = if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            // Скільки чекати до появи одного токена (мінімум 1 с — Retry-After у секундах).
            let deficit = 1.0 - bucket.tokens;
            let secs = (deficit / self.config.refill_per_sec()).ceil().max(1.0);
            Err(secs as u64)
        };

        drop(buckets);
        self.maybe_gc(now);
        result
    }

    /// Періодично прибирає відра, у які давно не стукали (щоб мапа не росла
    /// вічно від сканерів з тисячами IP).
    fn maybe_gc(&self, now: Instant) {
        let mut last_gc = self.last_gc.lock().expect("rate limiter gc mutex");
        if now.saturating_duration_since(*last_gc) < GC_INTERVAL {
            return;
        }
        *last_gc = now;
        drop(last_gc);

        let mut buckets = self.buckets.lock().expect("rate limiter mutex");
        buckets.retain(|_, b| now.saturating_duration_since(b.last_refill) < IDLE_TTL);
    }
}

/// IP клієнта: реальний peer з `ConnectInfo`, за проксі — заголовки.
///
/// `X-Forwarded-For` довіряємо ЛИШЕ якщо `TRUST_PROXY_HEADERS=1`: інакше
/// будь-хто підмінив би заголовок і обійшов ліміт, підставляючи випадкові IP.
fn client_ip(req: &Request, trust_proxy_headers: bool) -> IpAddr {
    if trust_proxy_headers {
        let from_header = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .or_else(|| {
                req.headers()
                    .get("x-real-ip")
                    .and_then(|v| v.to_str().ok())
            })
            .and_then(|v| v.trim().parse::<IpAddr>().ok());
        if let Some(ip) = from_header {
            return ip;
        }
    }

    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip())
        // Тести (`oneshot`) і виклики без ConnectInfo: єдине спільне відро.
        // Це БЕЗПЕЧНА сторона помилки — ліміт застосовується, а не обходиться.
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// Axum-мідлвара. Підключається через `from_fn_with_state(limiter, rate_limit)`.
pub async fn rate_limit(
    State(limiter): State<Arc<RateLimiter>>,
    req: Request,
    next: Next,
) -> Response {
    // CORS-preflight не доходить сюди (його перехоплює CorsLayer вище), але
    // якщо колись переставлять шари — OPTIONS не має «з'їдати» бюджет: він
    // нічого не коштує (в OpenAI/RPC не ходить), а от з'їдений AI-токен
    // означав би 429 на справжній POST /v1/chat одразу після preflight.
    if req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }

    let ip = client_ip(&req, limiter.trust_proxy_headers);
    match limiter.check(ip) {
        Ok(()) => next.run(req).await,
        Err(retry_after) => {
            tracing::debug!(%ip, path = %req.uri().path(), "rate limit: 429");
            let body = Json(serde_json::json!({
                "error": format!(
                    "Забагато запитів. Ліміт {} запитів/хв. Спробуйте через {retry_after} с.",
                    limiter.config.rpm
                )
            }));
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, retry_after.to_string())],
                body,
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IP: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

    #[test]
    fn burst_is_allowed_then_blocked() {
        let limiter = RateLimiter::new(RateLimitConfig::new(60, 3), false);
        for _ in 0..3 {
            assert!(limiter.check(IP).is_ok());
        }
        // Четвертий поспіль — відро порожнє.
        assert!(limiter.check(IP).is_err());
    }

    #[test]
    fn retry_after_is_at_least_one_second() {
        let limiter = RateLimiter::new(RateLimitConfig::new(5, 1), false);
        assert!(limiter.check(IP).is_ok());
        let retry = limiter.check(IP).unwrap_err();
        assert!(retry >= 1, "Retry-After має бути >= 1 с, було {retry}");
    }

    #[test]
    fn limits_are_per_ip() {
        let limiter = RateLimiter::new(RateLimitConfig::new(60, 1), false);
        assert!(limiter.check(IP).is_ok());
        assert!(limiter.check(IP).is_err());
        // Інша IP має власне відро.
        let other = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7));
        assert!(limiter.check(other).is_ok());
    }

    #[test]
    fn zero_config_is_clamped_to_one() {
        let cfg = RateLimitConfig::new(0, 0);
        assert_eq!(cfg.rpm, 1);
        assert_eq!(cfg.burst, 1);
    }
}
