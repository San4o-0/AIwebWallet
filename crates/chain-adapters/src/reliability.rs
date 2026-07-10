//! Reliability layer for outbound HTTP: retry-with-backoff on transient
//! failures + per-provider concurrency limiting (a `tokio::Semaphore`).
//!
//! Shared by the EVM (through [`crate::jsonrpc::JsonRpcClient::with_reliability`]),
//! Bitcoin and TRON adapters. **Solana is deliberately left untouched**: it uses
//! the plain [`crate::jsonrpc::JsonRpcClient::new`] constructor, whose code path
//! never goes through this module.

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use tokio::sync::Semaphore;

use crate::error::AdapterError;

/// Default number of retries *after* the first attempt (so up to 4 tries total).
pub(crate) const DEFAULT_MAX_RETRIES: u32 = 3;
/// Default base backoff delay (doubled each attempt).
pub(crate) const DEFAULT_BASE_DELAY: Duration = Duration::from_millis(200);
/// Default cap on any single backoff delay.
pub(crate) const DEFAULT_MAX_DELAY: Duration = Duration::from_secs(5);
/// Default number of concurrent in-flight requests allowed per adapter instance.
pub(crate) const DEFAULT_CONCURRENCY: usize = 8;

/// Exponential-backoff retry policy.
#[derive(Debug, Clone)]
pub(crate) struct RetryPolicy {
    /// Maximum retries after the initial attempt.
    pub max_retries: u32,
    /// Base delay; attempt `n` waits ~`base_delay * 2^n` (jittered).
    pub base_delay: Duration,
    /// Upper bound on any single delay.
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            max_retries: DEFAULT_MAX_RETRIES,
            base_delay: DEFAULT_BASE_DELAY,
            max_delay: DEFAULT_MAX_DELAY,
        }
    }
}

impl RetryPolicy {
    /// Deterministic exponential backoff (no jitter), capped at `max_delay`.
    pub(crate) fn exp_backoff(&self, attempt: u32) -> Duration {
        let factor = 2u64.saturating_pow(attempt);
        let millis = (self.base_delay.as_millis() as u64).saturating_mul(factor);
        Duration::from_millis(millis).min(self.max_delay)
    }

    /// Delay to wait before the next attempt. A `Retry-After` hint (from a
    /// 429/503 response) overrides the computed backoff, but is still capped at
    /// `max_delay` so a hostile/absurd header cannot stall the caller forever.
    pub(crate) fn delay_for(&self, attempt: u32, retry_after: Option<Duration>) -> Duration {
        if let Some(hint) = retry_after {
            return hint.min(self.max_delay);
        }
        // Equal jitter: keep at least half the backoff, randomise the rest.
        let base = self.exp_backoff(attempt);
        let frac = 0.5 + 0.5 * jitter_fraction();
        base.mul_f64(frac)
    }
}

/// Cheap process-local jitter in `[0.0, 1.0)` without pulling in `rand`
/// (still native Rust). Good enough to de-synchronise retry storms.
fn jitter_fraction() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 1_000_000) as f64 / 1_000_000.0
}

/// HTTP status codes that warrant a retry.
pub(crate) fn is_transient_status(code: u16) -> bool {
    matches!(code, 429 | 500 | 502 | 503 | 504)
}

/// Parse a `Retry-After` value expressed in seconds. HTTP-date form is not
/// supported (returns `None`) — seconds cover the providers we call.
pub(crate) fn parse_retry_after(value: &str) -> Option<Duration> {
    let secs: u64 = value.trim().parse().ok()?;
    Some(Duration::from_secs(secs))
}

/// Extract a `Retry-After` hint from response headers, if present and numeric.
pub(crate) fn retry_after_from_headers(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()
        .and_then(parse_retry_after)
}

/// Failure produced by a single HTTP attempt, carrying enough context for the
/// retry loop to decide whether to try again and how long to wait.
#[derive(Debug)]
pub(crate) struct HttpFailure {
    pub error: AdapterError,
    /// `true` if the loop may retry this failure.
    pub transient: bool,
    /// Server-provided delay hint (`Retry-After`), when available.
    pub retry_after: Option<Duration>,
}

impl HttpFailure {
    /// A permanent failure — never retried (4xx except 429, JSON-RPC business
    /// errors like `execution reverted`, decode errors, ...).
    pub(crate) fn permanent(error: AdapterError) -> Self {
        HttpFailure {
            error,
            transient: false,
            retry_after: None,
        }
    }

    /// A transient failure — eligible for retry.
    pub(crate) fn transient(error: AdapterError, retry_after: Option<Duration>) -> Self {
        HttpFailure {
            error,
            transient: true,
            retry_after,
        }
    }

    /// Classify a `reqwest` transport error. Network timeouts and connection
    /// failures are transient; everything else (decode, bad request, ...) is not.
    pub(crate) fn from_reqwest(err: reqwest::Error) -> Self {
        let transient = err.is_timeout() || err.is_connect();
        HttpFailure {
            error: AdapterError::Http(err),
            transient,
            retry_after: None,
        }
    }
}

/// Build a failure from a non-success HTTP status, classifying by the code.
pub(crate) fn failure_for_status(
    code: u16,
    error: AdapterError,
    retry_after: Option<Duration>,
) -> HttpFailure {
    if is_transient_status(code) {
        HttpFailure::transient(error, retry_after)
    } else {
        HttpFailure::permanent(error)
    }
}

/// Turn a finished `reqwest::Response` into `T` (JSON) or an [`HttpFailure`],
/// mapping non-success status to [`AdapterError::Rpc`] with the HTTP code.
pub(crate) async fn handle_json_response<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, HttpFailure> {
    let status = response.status();
    if !status.is_success() {
        let code = status.as_u16();
        let retry_after = retry_after_from_headers(response.headers());
        let message = response.text().await.unwrap_or_default();
        let error = AdapterError::Rpc {
            code: code as i64,
            message,
        };
        return Err(failure_for_status(code, error, retry_after));
    }
    response.json::<T>().await.map_err(HttpFailure::from_reqwest)
}

/// Like [`handle_json_response`] but returns the raw (trimmed) text body — used
/// by the Bitcoin broadcast endpoint, which returns a bare txid string.
pub(crate) async fn handle_text_response(
    response: reqwest::Response,
) -> Result<String, HttpFailure> {
    let status = response.status();
    let code = status.as_u16();
    let retry_after = retry_after_from_headers(response.headers());
    let body = response.text().await.map_err(HttpFailure::from_reqwest)?;
    if !status.is_success() {
        let error = AdapterError::Rpc {
            code: code as i64,
            message: body,
        };
        return Err(failure_for_status(code, error, retry_after));
    }
    Ok(body.trim().to_string())
}

/// Per-provider reliability layer: a retry policy plus a shared concurrency
/// semaphore. Cloneable (the semaphore is shared via `Arc`), so every clone of
/// an adapter throttles against the *same* budget.
#[derive(Debug, Clone)]
pub(crate) struct ReliabilityLayer {
    policy: RetryPolicy,
    semaphore: Arc<Semaphore>,
}

impl ReliabilityLayer {
    pub(crate) fn new(policy: RetryPolicy, max_concurrency: usize) -> Self {
        ReliabilityLayer {
            policy,
            semaphore: Arc::new(Semaphore::new(max_concurrency.max(1))),
        }
    }

    /// Default policy + default concurrency.
    pub(crate) fn with_defaults() -> Self {
        Self::new(RetryPolicy::default(), DEFAULT_CONCURRENCY)
    }

    /// Run `op` under the concurrency permit, retrying transient failures with
    /// exponential backoff. A permit is held only while a request is in flight
    /// (released before sleeping between attempts). After the retries are
    /// exhausted a transient failure surfaces as [`AdapterError::RateLimited`].
    pub(crate) async fn run<T, F, Fut>(&self, op: F) -> Result<T, AdapterError>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, HttpFailure>>,
    {
        let mut attempt: u32 = 0;
        loop {
            let permit = self
                .semaphore
                .clone()
                .acquire_owned()
                .await
                .expect("reliability semaphore is never closed");
            let result = op().await;
            drop(permit);

            match result {
                Ok(value) => return Ok(value),
                Err(failure) => {
                    if !failure.transient {
                        return Err(failure.error);
                    }
                    if attempt >= self.policy.max_retries {
                        return Err(AdapterError::RateLimited {
                            attempts: attempt + 1,
                            message: failure.error.to_string(),
                        });
                    }
                    let delay = self.policy.delay_for(attempt, failure.retry_after);
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fast_layer() -> ReliabilityLayer {
        // Tiny delays so retry tests stay quick.
        ReliabilityLayer::new(
            RetryPolicy {
                max_retries: 3,
                base_delay: Duration::from_millis(1),
                max_delay: Duration::from_millis(5),
            },
            8,
        )
    }

    #[test]
    fn exp_backoff_grows_and_caps() {
        let policy = RetryPolicy {
            max_retries: 10,
            base_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
        };
        assert_eq!(policy.exp_backoff(0), Duration::from_millis(200));
        assert_eq!(policy.exp_backoff(1), Duration::from_millis(400));
        assert_eq!(policy.exp_backoff(2), Duration::from_millis(800));
        assert_eq!(policy.exp_backoff(3), Duration::from_millis(1600));
        // 200 * 2^5 = 6400ms would exceed the 5s cap.
        assert_eq!(policy.exp_backoff(5), Duration::from_secs(5));
        assert_eq!(policy.exp_backoff(100), Duration::from_secs(5));
    }

    #[test]
    fn retry_after_overrides_backoff_but_is_capped() {
        let policy = RetryPolicy {
            max_retries: 3,
            base_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
        };
        // A modest hint is honoured verbatim.
        assert_eq!(
            policy.delay_for(0, Some(Duration::from_secs(2))),
            Duration::from_secs(2)
        );
        // An absurd hint is capped at max_delay.
        assert_eq!(
            policy.delay_for(0, Some(Duration::from_secs(3600))),
            Duration::from_secs(5)
        );
    }

    #[test]
    fn jittered_delay_stays_within_bounds() {
        let policy = RetryPolicy {
            max_retries: 3,
            base_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
        };
        for attempt in 0..4 {
            let base = policy.exp_backoff(attempt);
            let d = policy.delay_for(attempt, None);
            assert!(d >= base / 2, "delay {d:?} below half of base {base:?}");
            assert!(d <= base, "delay {d:?} above base {base:?}");
        }
    }

    #[test]
    fn parse_retry_after_seconds() {
        assert_eq!(parse_retry_after("120"), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after("  30 "), Some(Duration::from_secs(30)));
        assert_eq!(parse_retry_after("0"), Some(Duration::from_secs(0)));
        // HTTP-date form is unsupported → None.
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after("soon"), None);
    }

    #[test]
    fn status_classification() {
        for code in [429, 500, 502, 503, 504] {
            assert!(is_transient_status(code), "{code} should be transient");
        }
        for code in [400, 401, 403, 404, 422] {
            assert!(!is_transient_status(code), "{code} should be permanent");
        }
    }

    #[test]
    fn failure_classification_transient_vs_permanent() {
        // 429 / 503 → retryable.
        let f = failure_for_status(429, AdapterError::Rpc { code: 429, message: "slow down".into() }, None);
        assert!(f.transient);
        let f = failure_for_status(503, AdapterError::Rpc { code: 503, message: "busy".into() }, None);
        assert!(f.transient);
        // 400 / 404 → not retryable.
        assert!(!failure_for_status(400, AdapterError::Rpc { code: 400, message: "bad".into() }, None).transient);
        assert!(!failure_for_status(404, AdapterError::Rpc { code: 404, message: "no".into() }, None).transient);
        // Business error (execution reverted, JSON-RPC code) → permanent.
        let revert = HttpFailure::permanent(AdapterError::Rpc {
            code: -32000,
            message: "execution reverted".into(),
        });
        assert!(!revert.transient);
    }

    #[tokio::test]
    async fn retries_then_succeeds() {
        let layer = fast_layer();
        let calls = AtomicUsize::new(0);
        let result: Result<u32, AdapterError> = layer
            .run(|| async {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    Err(HttpFailure::transient(
                        AdapterError::Rpc { code: 429, message: "429".into() },
                        None,
                    ))
                } else {
                    Ok(42)
                }
            })
            .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls.load(Ordering::SeqCst), 3); // 2 failures + 1 success
    }

    #[tokio::test]
    async fn exhausts_retries_then_rate_limited() {
        let layer = fast_layer();
        let calls = AtomicUsize::new(0);
        let result: Result<u32, AdapterError> = layer
            .run(|| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(HttpFailure::transient(
                    AdapterError::Rpc { code: 503, message: "down".into() },
                    None,
                ))
            })
            .await;
        match result {
            Err(AdapterError::RateLimited { attempts, .. }) => assert_eq!(attempts, 4),
            other => panic!("expected RateLimited, got {other:?}"),
        }
        // max_retries=3 → 1 initial + 3 retries = 4 attempts.
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn permanent_failure_is_not_retried() {
        let layer = fast_layer();
        let calls = AtomicUsize::new(0);
        let result: Result<u32, AdapterError> = layer
            .run(|| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(HttpFailure::permanent(AdapterError::Rpc {
                    code: -32000,
                    message: "execution reverted".into(),
                }))
            })
            .await;
        assert!(matches!(result, Err(AdapterError::Rpc { code: -32000, .. })));
        assert_eq!(calls.load(Ordering::SeqCst), 1); // no retry
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn semaphore_limits_concurrency() {
        const LIMIT: usize = 2;
        let layer = Arc::new(ReliabilityLayer::new(RetryPolicy::default(), LIMIT));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let layer = layer.clone();
            let in_flight = in_flight.clone();
            let max_seen = max_seen.clone();
            handles.push(tokio::spawn(async move {
                let _: Result<(), AdapterError> = layer
                    .run(|| {
                        let in_flight = in_flight.clone();
                        let max_seen = max_seen.clone();
                        async move {
                            let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                            max_seen.fetch_max(now, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            in_flight.fetch_sub(1, Ordering::SeqCst);
                            Ok(())
                        }
                    })
                    .await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert!(
            max_seen.load(Ordering::SeqCst) <= LIMIT,
            "observed {} concurrent, limit {}",
            max_seen.load(Ordering::SeqCst),
            LIMIT
        );
    }
}
