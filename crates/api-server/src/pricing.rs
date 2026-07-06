//! Ціновий сервіс: CoinGecko `/simple/price` + in-memory кеш (F2.5).
//!
//! Кеш — `tokio::sync::RwLock` із TTL 60 с; при недоступності CoinGecko
//! повертаємо застарілі значення (fail-safe, ТЗ §1.2).
//! TODO(redis): винести кеш у Redis (спільний між репліками) + rate limit.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::dto::PriceInfo;
use crate::handlers::now_secs;

/// TTL кешу цін (ТЗ: ціни оновлюються раз на хвилину).
const PRICE_TTL: Duration = Duration::from_secs(60);
/// Таймаут запиту до CoinGecko.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct CachedPrice {
    info: PriceInfo,
    fetched_at: Instant,
    fetched_at_unix: u64,
}

/// Клієнт CoinGecko з кешем у пам'яті.
pub struct PriceService {
    http: reqwest::Client,
    base_url: String,
    ttl: Duration,
    cache: RwLock<HashMap<String, CachedPrice>>,
}

impl PriceService {
    /// `base_url` — корінь CoinGecko API v3 (`https://api.coingecko.com/api/v3`).
    pub fn new(base_url: impl Into<String>) -> Self {
        // CoinGecko відповідає 403 на запити без User-Agent.
        let http = reqwest::Client::builder()
            .user_agent(concat!("ai-wallet/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            ttl: PRICE_TTL,
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// Ціни для CoinGecko id-ів. Свіжі значення — з кешу; відсутні/застарілі —
    /// одним запитом до CoinGecko. Якщо CoinGecko недоступний, повертаємо
    /// застарілий кеш (невідомі id просто відсутні у результаті).
    ///
    /// Повертає `(ціни, unix-час останнього оновлення)`.
    pub async fn get_prices(&self, ids: &[String]) -> (HashMap<String, PriceInfo>, u64) {
        let mut result: HashMap<String, PriceInfo> = HashMap::new();
        let mut updated_at: u64 = 0;
        let mut to_fetch: Vec<String> = Vec::new();

        {
            let cache = self.cache.read().await;
            for id in ids {
                match cache.get(id) {
                    Some(entry) if entry.fetched_at.elapsed() < self.ttl => {
                        result.insert(id.clone(), entry.info.clone());
                        updated_at = updated_at.max(entry.fetched_at_unix);
                    }
                    _ => to_fetch.push(id.clone()),
                }
            }
        }

        if to_fetch.is_empty() {
            return (result, updated_at);
        }

        match self.fetch(&to_fetch).await {
            Ok(fresh) => {
                let now_unix = now_secs();
                let now = Instant::now();
                let mut cache = self.cache.write().await;
                for (id, info) in fresh {
                    cache.insert(
                        id.clone(),
                        CachedPrice {
                            info: info.clone(),
                            fetched_at: now,
                            fetched_at_unix: now_unix,
                        },
                    );
                    result.insert(id, info);
                }
                updated_at = updated_at.max(now_unix);
            }
            Err(err) => {
                // Fail-safe: віддаємо застарілий кеш замість помилки (ТЗ §1.2).
                tracing::warn!("coingecko недоступний: {err}; використовую застарілий кеш");
                let cache = self.cache.read().await;
                for id in &to_fetch {
                    if let Some(entry) = cache.get(id) {
                        result.insert(id.clone(), entry.info.clone());
                        updated_at = updated_at.max(entry.fetched_at_unix);
                    }
                }
            }
        }

        if updated_at == 0 {
            updated_at = now_secs();
        }
        (result, updated_at)
    }

    async fn fetch(&self, ids: &[String]) -> Result<HashMap<String, PriceInfo>, reqwest::Error> {
        let url = format!(
            "{}/simple/price?ids={}&vs_currencies=usd&include_24hr_change=true",
            self.base_url,
            ids.join(",")
        );
        let raw: HashMap<String, HashMap<String, f64>> = self
            .http
            .get(&url)
            .timeout(FETCH_TIMEOUT)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        Ok(raw
            .into_iter()
            .filter_map(|(id, fields)| {
                fields.get("usd").map(|usd| {
                    (
                        id,
                        PriceInfo {
                            usd: *usd,
                            usd_24h_change: fields.get("usd_24h_change").copied().unwrap_or(0.0),
                        },
                    )
                })
            })
            .collect())
    }

    /// Пряме наповнення кешу (для тестів і прогріву).
    #[doc(hidden)]
    pub async fn prime(&self, id: &str, info: PriceInfo, age: Duration) {
        let now = Instant::now();
        self.cache.write().await.insert(
            id.to_string(),
            CachedPrice {
                info,
                fetched_at: now.checked_sub(age).unwrap_or(now),
                fetched_at_unix: now_secs().saturating_sub(age.as_secs()),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// base_url, куди свідомо неможливо достукатись — будь-який fetch падає.
    fn offline_service() -> PriceService {
        PriceService::new("http://127.0.0.1:1/api/v3")
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn fresh_cache_hit_avoids_network() {
        let svc = offline_service();
        svc.prime(
            "ethereum",
            PriceInfo { usd: 3500.0, usd_24h_change: 1.5 },
            Duration::ZERO,
        )
        .await;

        // fetch неможливий (порт 1) — якщо кеш не спрацює, ціни не буде.
        let (prices, updated_at) = svc.get_prices(&ids(&["ethereum"])).await;
        assert_eq!(prices.get("ethereum").unwrap().usd, 3500.0);
        assert!(updated_at > 0);
    }

    #[tokio::test]
    async fn stale_cache_is_served_when_fetch_fails() {
        let svc = offline_service();
        svc.prime(
            "bitcoin",
            PriceInfo { usd: 97_500.0, usd_24h_change: -0.4 },
            Duration::from_secs(600), // давно протух (TTL 60с)
        )
        .await;

        let (prices, _) = svc.get_prices(&ids(&["bitcoin"])).await;
        // Fail-safe: застаріле значення краще за відсутнє.
        assert_eq!(prices.get("bitcoin").unwrap().usd, 97_500.0);
    }

    #[tokio::test]
    async fn unknown_ids_are_absent_not_errors() {
        let svc = offline_service();
        let (prices, _) = svc.get_prices(&ids(&["dogwifhat"])).await;
        assert!(prices.is_empty());
    }

    #[tokio::test]
    async fn mixed_fresh_and_missing_returns_fresh_part() {
        let svc = offline_service();
        svc.prime(
            "solana",
            PriceInfo { usd: 170.0, usd_24h_change: 0.0 },
            Duration::ZERO,
        )
        .await;

        let (prices, _) = svc.get_prices(&ids(&["solana", "ethereum"])).await;
        assert_eq!(prices.len(), 1);
        assert_eq!(prices.get("solana").unwrap().usd, 170.0);
    }
}
