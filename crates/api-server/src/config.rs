//! Конфігурація сервера через змінні оточення.

use std::env;

/// Конфігурація застосунку.
///
/// Читається з env вручну (без крейта `envy`, щоб не роздувати збірку).
#[derive(Debug, Clone)]
pub struct Config {
    /// Порт HTTP-сервера. Env: `PORT`, за замовчуванням 8080.
    pub port: u16,
    /// PostgreSQL. Env: `DATABASE_URL`.
    /// TODO: підключити sqlx::PgPool (історія транзакцій, кеш метаданих, JSONB для сирих tx).
    pub database_url: Option<String>,
    /// Redis. Env: `REDIS_URL`.
    /// TODO: підключити fred (ціни, rate limiting, кеш RPC, сесії).
    pub redis_url: Option<String>,
    /// Ключ OpenAI API. Env: `OPENAI_API_KEY`.
    /// TODO: використовується провайдером ai::OpenAiProvider (async-openai).
    pub openai_api_key: Option<String>,
    /// CORS allowlist (origin розширення). Env: `ALLOWED_ORIGINS` (через кому).
    /// TODO: у проді — тільки extension origin (ТЗ розділ 6, п.6).
    pub allowed_origins: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(8080);

        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        Self {
            port,
            database_url: env::var("DATABASE_URL").ok(),
            redis_url: env::var("REDIS_URL").ok(),
            openai_api_key: env::var("OPENAI_API_KEY").ok(),
            allowed_origins,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 8080,
            database_url: None,
            redis_url: None,
            openai_api_key: None,
            allowed_origins: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_port_is_8080() {
        let cfg = Config::default();
        assert_eq!(cfg.port, 8080);
    }
}
