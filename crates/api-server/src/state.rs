//! Спільний стан застосунку.

use std::sync::Arc;

use chain_adapters::{ChainAdapter, ChainId};

use crate::ai::chat::ChatAi;
use crate::ai::{ExplanationProvider, OpenAiProvider, RuleBasedProvider};
use crate::chains::{build_registry, AdapterRegistry};
use crate::config::Config;
use crate::pricing::PriceService;
use crate::risk::RiskEngine;

/// Стан, доступний усім хендлерам через `State<Arc<AppState>>`.
pub struct AppState {
    pub config: Config,
    /// Адаптери мереж (усі 7, ключ — ChainId). RPC URL-и з env (див. config).
    pub adapters: AdapterRegistry,
    /// Ціни CoinGecko з in-memory кешем (TTL 60 с).
    /// TODO(redis): кеш у Redis, спільний між репліками.
    pub prices: PriceService,
    /// Rule-based risk-engine (реальна логіка, працює без AI — F5.5).
    pub risk_engine: RiskEngine,
    /// Основний (rule-based) провайдер пояснень — завжди доступний fallback.
    pub rule_based_explainer: RuleBasedProvider,
    /// AI-провайдер пояснень (async-openai, gpt-4o-mini): тривіальні
    /// транзакції — шаблоном без API, нетривіальні/high-risk — через OpenAI
    /// з таймаутом 10 с і fallback на rule-based (ТЗ 4.3).
    pub ai_explainer: Arc<dyn ExplanationProvider>,
    /// AI-чат із function calling (gpt-4o, F7.2). `None` без OPENAI_API_KEY —
    /// хендлер чату стрімить мок-відповідь.
    pub chat_ai: Option<Arc<ChatAi>>,
    // TODO: pg_pool: sqlx::PgPool — історія, метадані (DATABASE_URL).
}

impl AppState {
    pub fn new(config: Config) -> Arc<Self> {
        let openai_key = config
            .openai_api_key
            .clone()
            .filter(|k| !k.trim().is_empty());
        if openai_key.is_none() {
            // Один warn при старті (ключ читається лише тут).
            tracing::warn!(
                "OPENAI_API_KEY не задано — AI вимкнено: /v1/tx/explain працює \
                 через rule-based шаблони, /v1/chat стрімить мок-відповідь"
            );
        }
        let ai_explainer: Arc<dyn ExplanationProvider> =
            Arc::new(OpenAiProvider::new(openai_key.clone()));
        let chat_ai = openai_key.map(|k| Arc::new(ChatAi::new(k)));
        let adapters = build_registry(&config.rpc);
        let prices = PriceService::new(config.rpc.coingecko.clone());
        Arc::new(Self {
            config,
            adapters,
            prices,
            risk_engine: RiskEngine::with_demo_lists(),
            rule_based_explainer: RuleBasedProvider,
            ai_explainer,
            chat_ai,
        })
    }

    /// Адаптер конкретної мережі (реєстр покриває всі `ChainId`).
    pub fn adapter(&self, chain: ChainId) -> Arc<dyn ChainAdapter> {
        Arc::clone(
            self.adapters
                .get(&chain)
                .expect("реєстр адаптерів покриває всі ChainId"),
        )
    }
}
