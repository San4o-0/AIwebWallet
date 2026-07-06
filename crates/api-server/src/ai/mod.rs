//! ai-service: пояснення транзакцій (ТЗ F4, розділ 4.3).
//!
//! Архітектура: trait [`ExplanationProvider`] з двома імплементаціями:
//! - [`RuleBasedProvider`] — ПРАЦЮЄ вже зараз: шаблонні пояснення для
//!   типових транзакцій (нативний переказ, ERC-20 transfer, approve).
//!   За ТЗ 4.3 стандартні випадки пояснюються шаблоном БЕЗ виклику API.
//! - [`OpenAiProvider`] — заглушка. TODO: async-openai (gpt-4o-mini) для
//!   нетривіальних випадків; залежність свідомо НЕ додана, щоб не роздувати
//!   збірку скелета.
//!
//! Fail-safe (ТЗ 1.2, 4.3): таймаут AI 10 с → fallback на rule-based.

use async_trait::async_trait;

use crate::dto::{DecodedTx, ExplainRequest, ExplainResponse};
use crate::risk::{APPROVE_SELECTOR, ERC20_TRANSFER_SELECTOR};

#[derive(Debug)]
pub enum ProviderError {
    /// Провайдер не сконфігурований (нема API-ключа тощо).
    NotConfigured,
    /// Помилка виклику зовнішнього API.
    Upstream(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::NotConfigured => write!(f, "AI-провайдер не сконфігурований"),
            ProviderError::Upstream(e) => write!(f, "помилка AI API: {e}"),
        }
    }
}

impl std::error::Error for ProviderError {}

/// Провайдер людських пояснень транзакцій.
///
/// Вхід — УЖЕ декодовані структуровані дані (не сирий hex), див. ТЗ 4.3.
#[async_trait]
pub trait ExplanationProvider: Send + Sync {
    async fn explain(&self, req: &ExplainRequest) -> Result<ExplainResponse, ProviderError>;
}

// ---------------------------------------------------------------------------
// RuleBasedProvider — реальна логіка
// ---------------------------------------------------------------------------

/// Мова пояснення.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Uk,
    En,
}

impl Lang {
    fn from_opt(lang: Option<&str>) -> Self {
        match lang {
            Some(l) if l.eq_ignore_ascii_case("en") => Lang::En,
            _ => Lang::Uk,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Lang::Uk => "uk",
            Lang::En => "en",
        }
    }
}

/// Шаблонні rule-based пояснення (без AI). Покриває базові випадки:
/// нативний переказ, ERC-20 transfer (0xa9059cbb), approve (0x095ea7b3).
#[derive(Debug, Default, Clone)]
pub struct RuleBasedProvider;

impl RuleBasedProvider {
    /// Синхронна серцевина — зручно для юніт-тестів.
    pub fn explain_sync(&self, req: &ExplainRequest) -> ExplainResponse {
        let lang = Lang::from_opt(req.lang.as_deref());
        let d = &req.decoded;

        let mut text = match classify(d) {
            TxKind::NativeTransfer => native_transfer_text(d, lang),
            TxKind::Erc20Transfer => erc20_transfer_text(d, lang),
            TxKind::Approve { unlimited } => approve_text(d, unlimited, lang),
            TxKind::Other => fallback_text(d, lang),
        };

        // Додаємо попередження про високий ризик (F5.1: AI/шаблон лише
        // формулює — сам скоринг у risk-engine).
        if let Some(risk) = &req.risk {
            if risk.level == "high" {
                let reasons = risk
                    .reasons
                    .iter()
                    .map(|r| r.message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ");
                match lang {
                    Lang::Uk => {
                        text.push_str(&format!(" УВАГА, високий ризик: {reasons}."));
                    }
                    Lang::En => {
                        text.push_str(&format!(" WARNING, high risk: {reasons}."));
                    }
                }
            }
        }

        ExplainResponse {
            explanation: text,
            source: "rule_based".to_string(),
            lang: lang.as_str().to_string(),
        }
    }
}

#[async_trait]
impl ExplanationProvider for RuleBasedProvider {
    async fn explain(&self, req: &ExplainRequest) -> Result<ExplainResponse, ProviderError> {
        Ok(self.explain_sync(req))
    }
}

enum TxKind {
    NativeTransfer,
    Erc20Transfer,
    Approve { unlimited: bool },
    Other,
}

fn classify(d: &DecodedTx) -> TxKind {
    let selector = d
        .selector
        .as_deref()
        .map(|s| s.trim_start_matches("0x").to_lowercase());

    match (d.action.as_str(), selector.as_deref()) {
        ("approve", _) | (_, Some(APPROVE_SELECTOR)) => TxKind::Approve {
            unlimited: d.unlimited.unwrap_or(false),
        },
        ("erc20_transfer", _) | (_, Some(ERC20_TRANSFER_SELECTOR)) => TxKind::Erc20Transfer,
        ("native_transfer", _) => TxKind::NativeTransfer,
        _ => TxKind::Other,
    }
}

fn or_unknown(v: &Option<String>, lang: Lang) -> String {
    v.clone().unwrap_or_else(|| match lang {
        Lang::Uk => "невідомо".to_string(),
        Lang::En => "unknown".to_string(),
    })
}

fn native_transfer_text(d: &DecodedTx, lang: Lang) -> String {
    let amount = or_unknown(&d.amount, lang);
    let symbol = d.symbol.clone().unwrap_or_default();
    let to = or_unknown(&d.to, lang);
    match lang {
        Lang::Uk => format!("Ви надсилаєте {amount} {symbol} на адресу {to}."),
        Lang::En => format!("You are sending {amount} {symbol} to {to}."),
    }
}

fn erc20_transfer_text(d: &DecodedTx, lang: Lang) -> String {
    let amount = or_unknown(&d.amount, lang);
    let symbol = d
        .symbol
        .clone()
        .unwrap_or_else(|| match lang {
            Lang::Uk => "токенів".to_string(),
            Lang::En => "tokens".to_string(),
        });
    let to = or_unknown(&d.to, lang);
    match lang {
        Lang::Uk => format!("Ви переказуєте {amount} {symbol} на адресу {to}."),
        Lang::En => format!("You are transferring {amount} {symbol} to {to}."),
    }
}

fn approve_text(d: &DecodedTx, unlimited: bool, lang: Lang) -> String {
    let spender = or_unknown(&d.spender, lang);
    let symbol = d.symbol.clone().unwrap_or_else(|| match lang {
        Lang::Uk => "токени".to_string(),
        Lang::En => "tokens".to_string(),
    });
    if unlimited {
        match lang {
            Lang::Uk => format!(
                "Ви даєте {spender} дозвіл витрачати ВСІ ваші {symbol} без обмежень. \
                 Контракт зможе зняти токени у будь-який момент без вашої участі."
            ),
            Lang::En => format!(
                "You are granting {spender} permission to spend ALL of your {symbol} \
                 with no limit. The contract will be able to withdraw the tokens at any time."
            ),
        }
    } else {
        let amount = or_unknown(&d.amount, lang);
        match lang {
            Lang::Uk => format!("Ви даєте {spender} дозвіл витрачати до {amount} {symbol}."),
            Lang::En => format!(
                "You are granting {spender} permission to spend up to {amount} {symbol}."
            ),
        }
    }
}

fn fallback_text(d: &DecodedTx, lang: Lang) -> String {
    let to = or_unknown(&d.to, lang);
    let method = d
        .method
        .clone()
        .or_else(|| d.selector.clone())
        .unwrap_or_else(|| match lang {
            Lang::Uk => "невідомий метод".to_string(),
            Lang::En => "unknown method".to_string(),
        });
    match lang {
        Lang::Uk => format!(
            "Ви взаємодієте з контрактом {to} (метод {method}). \
             Перевірте деталі перед підписанням."
        ),
        Lang::En => format!(
            "You are interacting with contract {to} (method {method}). \
             Review the details before signing."
        ),
    }
}

// ---------------------------------------------------------------------------
// OpenAiProvider — заглушка
// ---------------------------------------------------------------------------

/// Заглушка AI-провайдера.
///
/// TODO: реалізувати через `async-openai`:
/// - модель `gpt-4o-mini` для пояснень (ТЗ 4.3);
/// - у prompt подавати ТІЛЬКИ структуровані декодовані дані як user-поля,
///   ніколи як інструкції (захист від prompt injection, ТЗ розділ 6, п.5);
/// - таймаут 10 с + fallback на RuleBasedProvider;
/// - кеш шаблонних типів транзакцій (без виклику API);
/// - rate limit і денний бюджет токенів на користувача.
#[derive(Debug, Clone)]
pub struct OpenAiProvider {
    #[allow(dead_code)]
    api_key: Option<String>,
    #[allow(dead_code)]
    model: String,
}

impl OpenAiProvider {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
            api_key,
            model: "gpt-4o-mini".to_string(),
        }
    }
}

#[async_trait]
impl ExplanationProvider for OpenAiProvider {
    async fn explain(&self, _req: &ExplainRequest) -> Result<ExplainResponse, ProviderError> {
        // TODO: виклик Chat Completions через async-openai; поки що провайдер
        // сигналізує «не сконфігуровано», а хендлер робить fallback на rule-based.
        Err(ProviderError::NotConfigured)
    }
}

// ---------------------------------------------------------------------------
// Тести rule-based пояснень
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{RiskReasonDto, RiskResponse};

    fn req(decoded: DecodedTx, lang: Option<&str>) -> ExplainRequest {
        ExplainRequest {
            decoded,
            simulation: None,
            risk: None,
            lang: lang.map(str::to_string),
        }
    }

    #[test]
    fn explains_native_transfer_uk() {
        let decoded = DecodedTx {
            chain: "ethereum".into(),
            action: "native_transfer".into(),
            amount: Some("0.5".into()),
            symbol: Some("ETH".into()),
            to: Some("0xd1c24f50d05946b3fabefbae3cd0a7e9938c63f2".into()),
            ..Default::default()
        };
        let resp = RuleBasedProvider.explain_sync(&req(decoded, None));
        assert_eq!(resp.lang, "uk");
        assert_eq!(resp.source, "rule_based");
        assert!(resp.explanation.contains("Ви надсилаєте 0.5 ETH"));
        assert!(resp.explanation.contains("0xd1c24f50"));
    }

    #[test]
    fn explains_erc20_transfer_by_selector() {
        let decoded = DecodedTx {
            chain: "polygon".into(),
            action: "contract_call".into(),
            selector: Some("0xa9059cbb".into()),
            amount: Some("150".into()),
            symbol: Some("USDC".into()),
            to: Some("0xab5801a7d398351b8be11c439e05c5b3259aec9b".into()),
            ..Default::default()
        };
        let resp = RuleBasedProvider.explain_sync(&req(decoded, None));
        assert!(resp.explanation.contains("Ви переказуєте 150 USDC"));
    }

    #[test]
    fn explains_unlimited_approve_with_warning() {
        let decoded = DecodedTx {
            chain: "ethereum".into(),
            action: "approve".into(),
            selector: Some("0x095ea7b3".into()),
            symbol: Some("USDC".into()),
            spender: Some("0x1111111254eeb25477b68fb85ed929f73a960582".into()),
            unlimited: Some(true),
            ..Default::default()
        };
        let mut r = req(decoded, None);
        r.risk = Some(RiskResponse {
            level: "high".into(),
            reasons: vec![RiskReasonDto {
                code: "unlimited_approve".into(),
                message: "Необмежений approve".into(),
            }],
            requires_confirmation: true,
        });
        let resp = RuleBasedProvider.explain_sync(&r);
        assert!(resp.explanation.contains("ВСІ ваші USDC"));
        assert!(resp.explanation.contains("УВАГА, високий ризик"));
    }

    #[test]
    fn explains_limited_approve() {
        let decoded = DecodedTx {
            chain: "ethereum".into(),
            action: "approve".into(),
            amount: Some("1000".into()),
            symbol: Some("DAI".into()),
            spender: Some("0x1111111254eeb25477b68fb85ed929f73a960582".into()),
            unlimited: Some(false),
            ..Default::default()
        };
        let resp = RuleBasedProvider.explain_sync(&req(decoded, None));
        assert!(resp.explanation.contains("до 1000 DAI"));
        assert!(!resp.explanation.contains("ВСІ"));
    }

    #[test]
    fn explains_in_english() {
        let decoded = DecodedTx {
            chain: "ethereum".into(),
            action: "native_transfer".into(),
            amount: Some("1".into()),
            symbol: Some("ETH".into()),
            to: Some("0xab5801a7d398351b8be11c439e05c5b3259aec9b".into()),
            ..Default::default()
        };
        let resp = RuleBasedProvider.explain_sync(&req(decoded, Some("en")));
        assert_eq!(resp.lang, "en");
        assert!(resp.explanation.contains("You are sending 1 ETH"));
    }

    #[test]
    fn unknown_action_gets_fallback() {
        let decoded = DecodedTx {
            chain: "ethereum".into(),
            action: "contract_call".into(),
            selector: Some("0xdeadbeef".into()),
            to: Some("0xab5801a7d398351b8be11c439e05c5b3259aec9b".into()),
            ..Default::default()
        };
        let resp = RuleBasedProvider.explain_sync(&req(decoded, None));
        assert!(resp.explanation.contains("Ви взаємодієте з контрактом"));
    }

    #[tokio::test]
    async fn openai_stub_is_not_configured() {
        let provider = OpenAiProvider::new(None);
        let decoded = DecodedTx::default();
        let err = provider.explain(&req(decoded, None)).await.unwrap_err();
        assert!(matches!(err, ProviderError::NotConfigured));
    }
}
