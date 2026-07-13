//! Інструменти AI-чату (function calling, ТЗ F7.2).
//!
//! Модель НЕ вигадує цифри: кожна відповідь про баланси/історію/комісії/ціни
//! будується на РЕАЛЬНИХ даних AppState — тих самих хендлерах, що обслуговують
//! /v1/balances, /v1/history, /v1/fees, /v1/prices.
//!
//! БЕЗПЕКА (F7.4, ТЗ розділ 6 п.5): тут СВІДОМО немає інструментів для
//! підпису, надсилання чи broadcast транзакцій — чат лише читає дані.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_openai::types::chat::{ChatCompletionTool, ChatCompletionTools, FunctionObject};
use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};

use chain_adapters::{Address, ChainId};

use crate::chains::native_coingecko_id;
use crate::dto::{AddressBook, BalancesRequest, FeeEstimateQuery, HistoryRequest};
use crate::handlers;
use crate::state::AppState;

/// Скільки записів історії віддаємо моделі за один виклик інструмента.
const HISTORY_LIMIT: u32 = 20;

/// Визначення інструментів для Chat Completions API.
pub fn tool_definitions() -> Vec<ChatCompletionTools> {
    vec![
        function_tool(
            "get_balances",
            "Портфель користувача: баланси нативних монет і токенів у всіх \
             мережах (EVM, Solana, Bitcoin) з оцінкою в USD. Викликай, коли \
             питання стосується балансів, портфеля чи вартості активів.",
            json!({
                "type": "object",
                "properties": {
                    "addresses": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Публічні адреси користувача (EVM 0x…, Solana base58, Bitcoin bc1…/1…/3…)."
                    }
                },
                "required": ["addresses"]
            }),
        ),
        function_tool(
            "get_transaction_history",
            "Історія транзакцій адреси в конкретній мережі: суми, напрямки, \
             контрагенти, комісії в USD, статуси.",
            json!({
                "type": "object",
                "properties": {
                    "address": { "type": "string", "description": "Адреса, для якої потрібна історія." },
                    "chain": {
                        "type": "string",
                        "enum": ["ethereum", "polygon", "bsc", "arbitrum", "base", "solana", "bitcoin"],
                        "description": "Мережа."
                    }
                },
                "required": ["address", "chain"]
            }),
        ),
        function_tool(
            "get_fee_estimates",
            "Поточні комісії мережі (три рівні: slow/standard/fast) у нативних \
             одиницях (gwei / sat/vB / lamports).",
            json!({
                "type": "object",
                "properties": {
                    "chain": {
                        "type": "string",
                        "enum": ["ethereum", "polygon", "bsc", "arbitrum", "base", "solana", "bitcoin"],
                        "description": "Мережа."
                    }
                },
                "required": ["chain"]
            }),
        ),
        function_tool(
            "get_prices",
            "Поточні ціни криптоактивів у USD зі зміною за 24 години \
             (CoinGecko). Без параметра ids повертає ціни нативних монет усіх \
             підтримуваних мереж.",
            json!({
                "type": "object",
                "properties": {
                    "ids": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "CoinGecko id (наприклад: ethereum, solana, bitcoin, usd-coin). Необов'язково."
                    }
                }
            }),
        ),
    ]
}

fn function_tool(name: &str, description: &str, parameters: Value) -> ChatCompletionTools {
    ChatCompletionTools::Function(ChatCompletionTool {
        function: FunctionObject {
            name: name.to_string(),
            description: Some(description.to_string()),
            parameters: Some(parameters),
            strict: None,
        },
    })
}

/// Виконує інструмент і повертає JSON-результат для tool-повідомлення.
///
/// Помилки не пробиваються нагору — модель отримує `{"error": "..."}`
/// і може чесно сказати користувачу, що дані недоступні (fail-safe).
pub async fn execute_tool(state: &Arc<AppState>, name: &str, arguments: &str) -> Value {
    let args: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));

    match name {
        "get_balances" => {
            let addresses: Vec<String> = args["addresses"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if addresses.is_empty() {
                return json!({ "error": "не передано жодної адреси" });
            }
            let book = classify_addresses(&addresses);
            let Json(resp) = handlers::balances::balances(
                State(Arc::clone(state)),
                Json(BalancesRequest { addresses: book }),
            )
            .await;
            to_value(&resp)
        }
        "get_transaction_history" => {
            let Some(address) = args["address"].as_str() else {
                return json!({ "error": "параметр address обовʼязковий" });
            };
            let chain = args["chain"].as_str().unwrap_or("ethereum").to_string();
            let req = HistoryRequest {
                address: address.to_string(),
                chain: Some(chain),
                cursor: None,
                limit: Some(HISTORY_LIMIT),
            };
            match handlers::history::history(State(Arc::clone(state)), Json(req)).await {
                Ok(Json(resp)) => to_value(&resp),
                Err(e) => json!({ "error": e.message }),
            }
        }
        "get_fee_estimates" => {
            let Some(chain) = args["chain"].as_str() else {
                return json!({ "error": "параметр chain обовʼязковий" });
            };
            let query = FeeEstimateQuery { chain: chain.to_string() };
            match handlers::fees::fees(State(Arc::clone(state)), Query(query)).await {
                Ok(Json(resp)) => to_value(&resp),
                Err(e) => json!({ "error": e.message }),
            }
        }
        "get_prices" => {
            let ids: Vec<String> = match args["ids"].as_array() {
                Some(list) if !list.is_empty() => list
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect(),
                _ => default_price_ids(),
            };
            let (prices, updated_at) = state.prices.get_prices(&ids).await;
            json!({ "prices": prices, "updated_at": updated_at })
        }
        other => json!({ "error": format!("невідомий інструмент: {other}") }),
    }
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

/// CoinGecko id нативних монет усіх підтримуваних мереж (без дублів).
fn default_price_ids() -> Vec<String> {
    ChainId::ALL
        .iter()
        .map(|c| native_coingecko_id(*c).to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Розкладає плоский список адрес по мережах через валідатори
/// chain-adapters: EVM (0x…) → всі EVM-мережі, далі Bitcoin, TRON, Solana.
/// Порядок важливий: коротка base58-адреса BTC не має потрапити в Solana,
/// а TRON (`T…`, 34 символи) — підмножина Solana-патерну, тому перевіряється
/// раніше.
pub(crate) fn classify_addresses(addresses: &[String]) -> AddressBook {
    let mut book = AddressBook::default();
    for a in addresses {
        if Address::new(ChainId::Ethereum, a.clone()).is_ok() {
            book.evm.push(a.clone());
        } else if Address::new(ChainId::Bitcoin, a.clone()).is_ok() {
            book.bitcoin.push(a.clone());
        } else if Address::new(ChainId::Tron, a.clone()).is_ok() {
            book.tron.push(a.clone());
        } else if Address::new(ChainId::Solana, a.clone()).is_ok() {
            book.solana.push(a.clone());
        } else {
            tracing::debug!("нерозпізнана адреса в чаті: {a}");
        }
    }
    book
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn tool_definitions_serialize_to_openai_schema() {
        let tools = tool_definitions();
        assert_eq!(tools.len(), 4);

        let json = serde_json::to_value(&tools).unwrap();
        let names: Vec<&str> = json
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                // Формат OpenAI: {"type":"function","function":{"name":...}}
                assert_eq!(t["type"], "function");
                assert!(t["function"]["description"].is_string());
                assert_eq!(t["function"]["parameters"]["type"], "object");
                t["function"]["name"].as_str().unwrap()
            })
            .collect();
        assert_eq!(
            names,
            vec![
                "get_balances",
                "get_transaction_history",
                "get_fee_estimates",
                "get_prices"
            ]
        );

        // Обовʼязкові параметри — на місці.
        let history = &json[1]["function"]["parameters"];
        assert_eq!(history["required"][0], "address");
        assert_eq!(history["required"][1], "chain");
    }

    #[test]
    fn no_signing_or_sending_tools_exposed() {
        // F7.4 / ТЗ розділ 6 п.5: чат не має інструментів для підпису
        // чи надсилання коштів.
        let json = serde_json::to_string(&tool_definitions()).unwrap().to_lowercase();
        for forbidden in ["sign", "send", "broadcast", "transfer", "approve"] {
            assert!(
                !json.contains(&format!("\"name\":\"{forbidden}")),
                "знайдено заборонений інструмент: {forbidden}"
            );
        }
    }

    #[test]
    fn classify_addresses_routes_by_chain() {
        let book = classify_addresses(&[
            "0xd8da6bf26964af9d7eed9e03e53415d37aa96045".to_string(),
            "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".to_string(),
            "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T".to_string(),
            "не-адреса".to_string(),
        ]);
        assert_eq!(book.evm, vec!["0xd8da6bf26964af9d7eed9e03e53415d37aa96045"]);
        assert_eq!(book.bitcoin, vec!["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"]);
        assert_eq!(book.solana, vec!["4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"]);
    }

    #[tokio::test]
    async fn unknown_tool_returns_error_json() {
        let state = AppState::new(Config::default());
        let result = execute_tool(&state, "sign_transaction", "{}").await;
        assert!(result["error"].as_str().unwrap().contains("невідомий інструмент"));
    }

    #[tokio::test]
    async fn get_balances_without_addresses_returns_error_json() {
        let state = AppState::new(Config::default());
        let result = execute_tool(&state, "get_balances", r#"{"addresses":[]}"#).await;
        assert!(result["error"].as_str().unwrap().contains("адреси"));
        // Некоректний JSON аргументів теж не панікує.
        let result = execute_tool(&state, "get_balances", "не json").await;
        assert!(result.get("error").is_some());
    }
}
