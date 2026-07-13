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
    /// Базовий URL OpenAI-сумісного API. Env: `OPENAI_API_BASE`.
    /// Дозволяє підключити сумісні провайдери: Groq
    /// (`https://api.groq.com/openai/v1`), Ollama (`http://localhost:11434/v1`),
    /// Gemini тощо. Без значення — api.openai.com.
    pub openai_api_base: Option<String>,
    /// Модель AI-чату (F7.2). Env: `AI_CHAT_MODEL`, дефолт — gpt-4o.
    pub ai_chat_model: Option<String>,
    /// Модель пояснень транзакцій (F4.1). Env: `AI_EXPLAIN_MODEL`,
    /// дефолт — gpt-4o-mini.
    pub ai_explain_model: Option<String>,
    /// Ключ Etherscan API v2 (один на всі EVM-мережі, F3.6/F6). Env:
    /// `ETHERSCAN_API_KEY`. Без ключа історія EVM повертається порожньою
    /// з полем `note` (graceful degradation, не падає).
    pub etherscan_api_key: Option<String>,
    /// Ключ Alchemy (опційний, F4.3): якщо задано, /v1/tx/simulate для EVM
    /// використовує `alchemy_simulateAssetChanges` замість детермінованої
    /// симуляції. Env: `ALCHEMY_API_KEY`.
    pub alchemy_api_key: Option<String>,
    /// Ключ TronGrid (опційний): без нього публічні rate-limit'и жорсткі.
    /// Env: `TRONGRID_API_KEY`.
    pub trongrid_api_key: Option<String>,
    /// CORS allowlist (origin розширення). Env: `ALLOWED_ORIGINS` (через кому).
    ///
    /// Порожній список = dev-режим: дозволяються лише схеми `chrome-extension://`,
    /// `moz-extension://` і localhost (див. `routes::cors_layer`). Звичайні
    /// веб-сторінки заблоковані в обох режимах.
    pub allowed_origins: Vec<String>,
    /// Загальний вхідний ліміт per-IP на всі `/v1/*`.
    /// Env: `RATE_LIMIT_RPM` (дефолт 60), `RATE_LIMIT_BURST` (дефолт 20).
    pub rate_limit_rpm: u32,
    pub rate_limit_burst: u32,
    /// Жорсткіший ліміт per-IP на AI-ендпоінти (`/v1/chat`, `/v1/tx/explain`) —
    /// це прямі гроші за токени OpenAI.
    /// Env: `CHAT_RATE_LIMIT_RPM` (дефолт 5), `CHAT_RATE_LIMIT_BURST` (дефолт 2).
    pub chat_rate_limit_rpm: u32,
    pub chat_rate_limit_burst: u32,
    /// Чи довіряти `X-Forwarded-For`/`X-Real-IP` при визначенні IP клієнта.
    /// Env: `TRUST_PROXY_HEADERS` (`1`/`true`), дефолт `false`.
    ///
    /// Вмикати ТІЛЬКИ якщо сервер стоїть за довіреним реверс-проксі/LB.
    /// Інакше клієнт підмінить заголовок і обійде rate limiting.
    pub trust_proxy_headers: bool,
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
    /// Env: `TRON_API_URL` (корінь TronGrid-сумісного API).
    pub tron: String,
    /// Env: `MEMPOOL_SPACE_URL` (REST-корінь mempool.space).
    pub mempool_space: String,
    /// Env: `COINGECKO_API_URL` (корінь CoinGecko API v3).
    pub coingecko: String,
    /// Env: `ETHERSCAN_API_URL` (корінь Etherscan API v2 — один ендпоінт
    /// на всі EVM-мережі, мережа обирається параметром `chainid`).
    pub etherscan: String,
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
            tron: var("TRON_API_URL", defaults::TRON_API_URL),
            mempool_space: var("MEMPOOL_SPACE_URL", defaults::MEMPOOL_SPACE_URL),
            coingecko: var("COINGECKO_API_URL", defaults::COINGECKO_API_URL),
            etherscan: var("ETHERSCAN_API_URL", defaults::ETHERSCAN_API_URL),
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
            tron: defaults::TRON_API_URL.into(),
            mempool_space: defaults::MEMPOOL_SPACE_URL.into(),
            coingecko: defaults::COINGECKO_API_URL.into(),
            etherscan: defaults::ETHERSCAN_API_URL.into(),
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
    pub const TRON_API_URL: &str = "https://api.trongrid.io";
    pub const MEMPOOL_SPACE_URL: &str = "https://mempool.space/api";
    pub const COINGECKO_API_URL: &str = "https://api.coingecko.com/api/v3";
    pub const ETHERSCAN_API_URL: &str = "https://api.etherscan.io/v2/api";

    /// Загальний ліміт: 60 запитів/хв per-IP, сплеск до 20 (розширення при
    /// відкритті робить кілька паралельних запитів: баланси/ціни/історія).
    pub const RATE_LIMIT_RPM: u32 = 60;
    pub const RATE_LIMIT_BURST: u32 = 20;
    /// AI-ендпоінти: 5 запитів/хв per-IP, сплеск 2. Живий користувач стільки
    /// не пише; усе, що вище, — це вже качання нашого OPENAI_API_KEY.
    pub const CHAT_RATE_LIMIT_RPM: u32 = 5;
    pub const CHAT_RATE_LIMIT_BURST: u32 = 2;
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

        // Число з env або дефолт (порожнє/некоректне значення → дефолт).
        let num = |name: &str, default: u32| {
            env::var(name)
                .ok()
                .and_then(|v| v.trim().parse::<u32>().ok())
                .unwrap_or(default)
        };

        Self {
            port,
            database_url: env::var("DATABASE_URL").ok(),
            redis_url: env::var("REDIS_URL").ok(),
            openai_api_key: env::var("OPENAI_API_KEY").ok(),
            openai_api_base: env::var("OPENAI_API_BASE")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            ai_chat_model: env::var("AI_CHAT_MODEL")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            ai_explain_model: env::var("AI_EXPLAIN_MODEL")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            etherscan_api_key: env::var("ETHERSCAN_API_KEY")
                .ok()
                .filter(|k| !k.trim().is_empty()),
            alchemy_api_key: env::var("ALCHEMY_API_KEY")
                .ok()
                .filter(|k| !k.trim().is_empty()),
            trongrid_api_key: env::var("TRONGRID_API_KEY")
                .ok()
                .filter(|k| !k.trim().is_empty()),
            allowed_origins,
            rate_limit_rpm: num("RATE_LIMIT_RPM", defaults::RATE_LIMIT_RPM),
            rate_limit_burst: num("RATE_LIMIT_BURST", defaults::RATE_LIMIT_BURST),
            chat_rate_limit_rpm: num("CHAT_RATE_LIMIT_RPM", defaults::CHAT_RATE_LIMIT_RPM),
            chat_rate_limit_burst: num("CHAT_RATE_LIMIT_BURST", defaults::CHAT_RATE_LIMIT_BURST),
            trust_proxy_headers: env::var("TRUST_PROXY_HEADERS")
                .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
                .unwrap_or(false),
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
            openai_api_base: None,
            ai_chat_model: None,
            ai_explain_model: None,
            etherscan_api_key: None,
            alchemy_api_key: None,
            trongrid_api_key: None,
            allowed_origins: Vec::new(),
            rate_limit_rpm: defaults::RATE_LIMIT_RPM,
            rate_limit_burst: defaults::RATE_LIMIT_BURST,
            chat_rate_limit_rpm: defaults::CHAT_RATE_LIMIT_RPM,
            chat_rate_limit_burst: defaults::CHAT_RATE_LIMIT_BURST,
            trust_proxy_headers: false,
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
