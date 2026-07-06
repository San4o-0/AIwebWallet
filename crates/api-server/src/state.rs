//! Спільний стан застосунку.

use std::sync::Arc;

use crate::ai::{ExplanationProvider, OpenAiProvider, RuleBasedProvider};
use crate::config::Config;
use crate::risk::RiskEngine;

/// Стан, доступний усім хендлерам через `State<Arc<AppState>>`.
pub struct AppState {
    pub config: Config,
    /// Rule-based risk-engine (реальна логіка, працює без AI — F5.5).
    pub risk_engine: RiskEngine,
    /// Основний (rule-based) провайдер пояснень — завжди доступний fallback.
    pub rule_based_explainer: RuleBasedProvider,
    /// AI-провайдер (поки заглушка).
    /// TODO: async-openai клієнт; вибирати AI для нетривіальних транзакцій.
    pub ai_explainer: Arc<dyn ExplanationProvider>,
    // TODO: pg_pool: sqlx::PgPool — історія, метадані (DATABASE_URL).
    // TODO: redis: fred::clients::Pool — ціни, rate limit, сесії (REDIS_URL).
    // TODO: http-клієнти RPC-провайдерів (Alchemy/Ankr, Helius, mempool.space).
}

impl AppState {
    pub fn new(config: Config) -> Arc<Self> {
        let ai_explainer: Arc<dyn ExplanationProvider> =
            Arc::new(OpenAiProvider::new(config.openai_api_key.clone()));
        Arc::new(Self {
            config,
            risk_engine: RiskEngine::with_demo_lists(),
            rule_based_explainer: RuleBasedProvider,
            ai_explainer,
        })
    }
}
