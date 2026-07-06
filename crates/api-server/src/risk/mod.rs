//! risk-engine: rule-based скоринг запитів на підпис (ТЗ F5.1–F5.5).
//!
//! РЕАЛЬНА логіка (працює без AI, F5.5):
//! - детектор unlimited approve (селектор `approve(address,uint256)` =
//!   0x095ea7b3, value == U256::MAX або «фактично необмежене» > u128::MAX);
//! - детектор небезпечного методу підпису `eth_sign`;
//! - перевірка адреси одержувача по скам-списку (демо-HashSet);
//! - перевірка dapp_origin по демо-списку фішингових доменів.
//!
//! TODO (F5.2, F5.4):
//! - новий/неверифікований контракт (Sourcify/Etherscan + вік контракту);
//! - несподівана втрата активів за результатом симуляції;
//! - permit / setApprovalForAll «на все»;
//! - живі скам-фіди (ScamSniffer, ChainPatrol) замість вбудованого демо-списку,
//!   періодичне оновлення в Redis.

use std::collections::HashSet;

/// Селектор `approve(address,uint256)`.
pub const APPROVE_SELECTOR: &str = "095ea7b3";
/// Селектор `transfer(address,uint256)` (використовується декодером/explain).
pub const ERC20_TRANSFER_SELECTOR: &str = "a9059cbb";

/// Рівень ризику (F5.1): 🟢 / 🟡 / 🔴.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

impl RiskLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            RiskLevel::Low => "low",
            RiskLevel::Medium => "medium",
            RiskLevel::High => "high",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiskReason {
    pub code: &'static str,
    pub message: String,
    pub level: RiskLevel,
}

#[derive(Debug, Clone)]
pub struct RiskAssessment {
    pub level: RiskLevel,
    pub reasons: Vec<RiskReason>,
}

/// Вхід для скорингу — тільки публічні дані.
#[derive(Debug, Clone, Default)]
pub struct RiskInput {
    pub to: Option<String>,
    /// Calldata hex (з 0x або без).
    pub data: Option<String>,
    pub sign_method: Option<String>,
    pub dapp_origin: Option<String>,
}

/// Результат розбору calldata approve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApproveCall {
    pub spender: String,
    /// 32 байти значення allowance.
    pub value: [u8; 32],
}

impl ApproveCall {
    /// Точний U256::MAX (усі 32 байти = 0xff).
    pub fn is_exact_max(&self) -> bool {
        self.value.iter().all(|b| *b == 0xff)
    }

    /// «Фактично необмежений» дозвіл: value > u128::MAX
    /// (жоден реальний токен-сапплай близько не підходить) —
    /// покриває і U256::MAX, і «близькі до максимуму» значення.
    pub fn is_effectively_unlimited(&self) -> bool {
        self.value[..16].iter().any(|b| *b != 0)
    }
}

pub struct RiskEngine {
    /// Скам-адреси (lowercase). ДЕМО-список — TODO: замінити живими фідами (F5.4).
    scam_addresses: HashSet<String>,
    /// Фішингові домени dApp. ДЕМО-список.
    phishing_domains: HashSet<String>,
}

impl Default for RiskEngine {
    fn default() -> Self {
        Self::with_demo_lists()
    }
}

impl RiskEngine {
    /// Двигун із вбудованим демо-скам-списком.
    pub fn with_demo_lists() -> Self {
        let scam_addresses: HashSet<String> = [
            // ДЕМО-адреси для розробки/тестів (не з реальних фідів).
            "0x0000000000000000000000000000000000000bad",
            "0x1111111254eeb25477b68fb85ed929f73a960dad",
            "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        ]
        .into_iter()
        .map(str::to_lowercase)
        .collect();

        let phishing_domains: HashSet<String> = [
            // ДЕМО-домени.
            "app-uniswap.xyz",
            "metamask-wallet-verify.com",
            "claim-airdrop.io",
        ]
        .into_iter()
        .map(str::to_lowercase)
        .collect();

        Self {
            scam_addresses,
            phishing_domains,
        }
    }

    /// Головна точка входу: rule-based скоринг (< 800 мс, ТЗ розділ 7 —
    /// фактично мікросекунди, все в пам'яті).
    pub fn assess(&self, input: &RiskInput) -> RiskAssessment {
        let mut reasons: Vec<RiskReason> = Vec::new();

        if let Some(r) = self.detect_eth_sign(input.sign_method.as_deref()) {
            reasons.push(r);
        }
        if let Some(r) = self.detect_scam_address(input.to.as_deref()) {
            reasons.push(r);
        }
        if let Some(r) = self.detect_phishing_origin(input.dapp_origin.as_deref()) {
            reasons.push(r);
        }
        if let Some(data) = input.data.as_deref() {
            if let Some(approve) = parse_approve_calldata(data) {
                if approve.is_effectively_unlimited() {
                    reasons.push(RiskReason {
                        code: "unlimited_approve",
                        message: format!(
                            "Необмежений approve: контракт {} зможе витрачати ВСІ ваші токени без ліміту",
                            approve.spender
                        ),
                        level: RiskLevel::High,
                    });
                } else {
                    reasons.push(RiskReason {
                        code: "token_approve",
                        message: format!(
                            "Ви надаєте {} дозвіл на витрату ваших токенів (обмежена сума)",
                            approve.spender
                        ),
                        level: RiskLevel::Medium,
                    });
                }
            }
        }

        // TODO: детектор нового/неверифікованого контракту (потрібен RPC + Sourcify).
        // TODO: детектор несподіваної втрати активів за симуляцією (потрібен tx-service).
        // TODO: розбір permit (EIP-2612) та setApprovalForAll(true).

        let level = reasons
            .iter()
            .map(|r| r.level)
            .max()
            .unwrap_or(RiskLevel::Low);

        RiskAssessment { level, reasons }
    }

    /// Детектор небезпечного методу підпису `eth_sign` (сліпий підпис
    /// довільного хеша — може бути чим завгодно, включно з транзакцією).
    pub fn detect_eth_sign(&self, sign_method: Option<&str>) -> Option<RiskReason> {
        match sign_method {
            Some(m) if m.eq_ignore_ascii_case("eth_sign") => Some(RiskReason {
                code: "eth_sign",
                message: "Небезпечний метод eth_sign: сліпий підпис довільних даних — \
                          ним можна підписати будь-яку транзакцію"
                    .to_string(),
                level: RiskLevel::High,
            }),
            _ => None,
        }
    }

    /// Перевірка адреси одержувача по скам-списку.
    pub fn detect_scam_address(&self, to: Option<&str>) -> Option<RiskReason> {
        let to = to?;
        if self.scam_addresses.contains(&to.to_lowercase()) {
            Some(RiskReason {
                code: "scam_address",
                message: format!("Адреса {to} присутня у скам-списку"),
                level: RiskLevel::High,
            })
        } else {
            None
        }
    }

    /// Перевірка домену dApp по списку фішингових.
    pub fn detect_phishing_origin(&self, origin: Option<&str>) -> Option<RiskReason> {
        let origin = origin?;
        let host = origin
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or("")
            .to_lowercase();
        if self.phishing_domains.contains(&host) {
            Some(RiskReason {
                code: "phishing_domain",
                message: format!("Домен dApp «{host}» схожий на фішинговий"),
                level: RiskLevel::High,
            })
        } else {
            None
        }
    }
}

/// Розбирає calldata `approve(address,uint256)`:
/// `0x095ea7b3` + 32 байти (spender, вирівняний зліва) + 32 байти (value).
pub fn parse_approve_calldata(data: &str) -> Option<ApproveCall> {
    let hex = data.strip_prefix("0x").unwrap_or(data);
    // 8 (селектор) + 64 (spender) + 64 (value) hex-символів.
    if hex.len() < 8 + 64 + 64 {
        return None;
    }
    if !hex[..8].eq_ignore_ascii_case(APPROVE_SELECTOR) {
        return None;
    }
    let spender = format!("0x{}", &hex[8 + 24..8 + 64].to_lowercase());
    let value_bytes = decode_hex_32(&hex[8 + 64..8 + 128])?;
    Some(ApproveCall {
        spender,
        value: value_bytes,
    })
}

fn decode_hex_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Тести детекторів
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SPENDER: &str = "1111111254eeb25477b68fb85ed929f73a960582";

    fn approve_calldata(value_hex_64: &str) -> String {
        format!("0x{APPROVE_SELECTOR}{:0>64}{value_hex_64}", SPENDER)
    }

    #[test]
    fn detects_unlimited_approve_u256_max() {
        let data = approve_calldata(&"f".repeat(64));
        let call = parse_approve_calldata(&data).expect("має розпарситись");
        assert!(call.is_exact_max());
        assert!(call.is_effectively_unlimited());
        assert_eq!(call.spender, format!("0x{SPENDER}"));

        let engine = RiskEngine::with_demo_lists();
        let assessment = engine.assess(&RiskInput {
            to: Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()),
            data: Some(data),
            ..Default::default()
        });
        assert_eq!(assessment.level, RiskLevel::High);
        assert!(assessment.reasons.iter().any(|r| r.code == "unlimited_approve"));
    }

    #[test]
    fn detects_near_max_approve_as_unlimited() {
        // value = 2^200 (> u128::MAX, але не точний MAX).
        let mut value = ["0"; 64].join("");
        value.replace_range(13..14, "1"); // біт у старших 16 байтах
        let data = approve_calldata(&value);
        let call = parse_approve_calldata(&data).expect("має розпарситись");
        assert!(!call.is_exact_max());
        assert!(call.is_effectively_unlimited());
    }

    #[test]
    fn limited_approve_is_medium_not_high() {
        // value = 1000 * 10^6 (типовий USDC allowance) = 0x3b9aca00.
        let data = approve_calldata(&format!("{:0>64}", "3b9aca00"));
        let call = parse_approve_calldata(&data).expect("має розпарситись");
        assert!(!call.is_effectively_unlimited());

        let engine = RiskEngine::with_demo_lists();
        let assessment = engine.assess(&RiskInput {
            to: Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()),
            data: Some(data),
            ..Default::default()
        });
        assert_eq!(assessment.level, RiskLevel::Medium);
        assert!(assessment.reasons.iter().any(|r| r.code == "token_approve"));
    }

    #[test]
    fn non_approve_calldata_is_ignored() {
        // ERC-20 transfer — не approve.
        let data = format!(
            "0x{ERC20_TRANSFER_SELECTOR}{:0>64}{:0>64}",
            SPENDER, "3b9aca00"
        );
        assert!(parse_approve_calldata(&data).is_none());
    }

    #[test]
    fn detects_eth_sign() {
        let engine = RiskEngine::with_demo_lists();
        let assessment = engine.assess(&RiskInput {
            sign_method: Some("eth_sign".into()),
            ..Default::default()
        });
        assert_eq!(assessment.level, RiskLevel::High);
        assert!(assessment.reasons.iter().any(|r| r.code == "eth_sign"));

        // Безпечні методи не тригерять.
        let ok = engine.assess(&RiskInput {
            sign_method: Some("eth_signTypedData_v4".into()),
            ..Default::default()
        });
        assert!(ok.reasons.iter().all(|r| r.code != "eth_sign"));
    }

    #[test]
    fn detects_scam_address_case_insensitive() {
        let engine = RiskEngine::with_demo_lists();
        let assessment = engine.assess(&RiskInput {
            to: Some("0x0000000000000000000000000000000000000BAD".into()),
            ..Default::default()
        });
        assert_eq!(assessment.level, RiskLevel::High);
        assert!(assessment.reasons.iter().any(|r| r.code == "scam_address"));
    }

    #[test]
    fn detects_phishing_origin() {
        let engine = RiskEngine::with_demo_lists();
        let assessment = engine.assess(&RiskInput {
            dapp_origin: Some("https://app-uniswap.xyz/swap".into()),
            ..Default::default()
        });
        assert_eq!(assessment.level, RiskLevel::High);
        assert!(assessment.reasons.iter().any(|r| r.code == "phishing_domain"));
    }

    #[test]
    fn plain_native_transfer_is_low() {
        let engine = RiskEngine::with_demo_lists();
        let assessment = engine.assess(&RiskInput {
            to: Some("0xd1c24f50d05946b3fabefbae3cd0a7e9938c63f2".into()),
            data: None,
            sign_method: Some("eth_sendTransaction".into()),
            dapp_origin: Some("https://app.uniswap.org".into()),
        });
        assert_eq!(assessment.level, RiskLevel::Low);
        assert!(assessment.reasons.is_empty());
    }
}
