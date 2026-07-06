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
    /// RPC-ендпоінти мереж (дефолти — публічні ноди).
    pub rpc: RpcConfig,
}

/// URL-и RPC/REST-провайдерів для chain-adapters та цінового сервісу.
#[derive(Debug, Clone)]
pub struct RpcConfig {
    /// Env: `ETH_RPC_URL`.
    pub ethereum: String,
    /// Env: `POLYGON_RPC_URL`.
    pub polygon: String,
    /// Env: `BSC_RPC_URL`.
    pub bsc: String,
    /// Env: `ARBITRUM_RPC_URL`.
    pub arbitrum: String,
    /// Env: `BASE_RPC_URL`.
    pub base: String,
    /// Env: `SOLANA_RPC_URL`.
    pub solana: String,
    /// Env: `MEMPOOL_SPACE_URL` (REST-корінь mempool.space).
    pub mempool_space: String,
    /// Env: `COINGECKO_API_URL` (корінь CoinGecko API v3).
    pub coingecko: String,
}

impl RpcConfig {
    pub fn from_env() -> Self {
        let var = |name: &str, default: &str| env::var(name).unwrap_or_else(|_| default.to_string());
        Self {
            ethereum: var("ETH_RPC_URL", defaults::ETH_RPC_URL),
            polygon: var("POLYGON_RPC_URL", defaults::POLYGON_RPC_URL),
            bsc: var("BSC_RPC_URL", defaults::BSC_RPC_URL),
            arbitrum: var("ARBITRUM_RPC_URL", defaults::ARBITRUM_RPC_URL),
            base: var("BASE_RPC_URL", defaults::BASE_RPC_URL),
            solana: var("SOLANA_RPC_URL", defaults::SOLANA_RPC_URL),
            mempool_space: var("MEMPOOL_SPACE_URL", defaults::MEMPOOL_SPACE_URL),
            coingecko: var("COINGECKO_API_URL", defaults::COINGECKO_API_URL),
        }
    }
}

impl Default for RpcConfig {
    fn default() -> Self {
        Self {
            ethereum: defaults::ETH_RPC_URL.into(),
            polygon: defaults::POLYGON_RPC_URL.into(),
            bsc: defaults::BSC_RPC_URL.into(),
            arbitrum: defaults::ARBITRUM_RPC_URL.into(),
            base: defaults::BASE_RPC_URL.into(),
            solana: defaults::SOLANA_RPC_URL.into(),
            mempool_space: defaults::MEMPOOL_SPACE_URL.into(),
            coingecko: defaults::COINGECKO_API_URL.into(),
        }
    }
}

/// Публічні ноди за замовчуванням (безкоштовні, без ключів).
pub mod defaults {
    pub const ETH_RPC_URL: &str = "https://ethereum-rpc.publicnode.com";
    pub const POLYGON_RPC_URL: &str = "https://polygon-bor-rpc.publicnode.com";
    pub const BSC_RPC_URL: &str = "https://bsc-rpc.publicnode.com";
    pub const ARBITRUM_RPC_URL: &str = "https://arbitrum-one-rpc.publicnode.com";
    pub const BASE_RPC_URL: &str = "https://base-rpc.publicnode.com";
    pub const SOLANA_RPC_URL: &str = "https://api.mainnet-beta.solana.com";
    pub const MEMPOOL_SPACE_URL: &str = "https://mempool.space/api";
    pub const COINGECKO_API_URL: &str = "https://api.coingecko.com/api/v3";
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
            rpc: RpcConfig::from_env(),
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
            rpc: RpcConfig::default(),
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
