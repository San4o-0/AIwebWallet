//! HTTP-хендлери ендпоінтів `/v1`.

pub mod analytics;
pub mod balances;
pub mod chat;
pub mod fees;
pub mod health;
pub mod history;
pub mod prices;
pub mod tx;
pub mod tx_params;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chain_adapters::AdapterError;

/// Поточний unix-час у секундах (для таймстемпів).
pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Уніфікована помилка API: `{"error": "..."}` з відповідним HTTP-статусом.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }

    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_GATEWAY, message: message.into() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(serde_json::json!({ "error": self.message }));
        (self.status, body).into_response()
    }
}

impl From<AdapterError> for ApiError {
    fn from(err: AdapterError) -> Self {
        let status = match &err {
            AdapterError::InvalidAddress { .. } | AdapterError::InvalidInput(_) => {
                StatusCode::BAD_REQUEST
            }
            AdapterError::Unsupported(_) => StatusCode::NOT_IMPLEMENTED,
            // Провайдер тротлив запити (429/5xx) і ретраї в chain-adapters
            // вичерпані — клієнту варто повторити пізніше.
            AdapterError::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            // Помилки транспорту/ноди — проблема upstream, не клієнта.
            AdapterError::Http(_)
            | AdapterError::Rpc { .. }
            | AdapterError::Parse(_)
            | AdapterError::Json(_) => StatusCode::BAD_GATEWAY,
        };
        Self { status, message: err.to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_errors_map_to_http_statuses() {
        let bad_input: ApiError = AdapterError::InvalidInput("нуль".into()).into();
        assert_eq!(bad_input.status, StatusCode::BAD_REQUEST);

        let bad_addr: ApiError = AdapterError::InvalidAddress {
            chain: "bitcoin".into(),
            value: "xyz".into(),
        }
        .into();
        assert_eq!(bad_addr.status, StatusCode::BAD_REQUEST);

        let unsupported: ApiError = AdapterError::Unsupported("історія EVM".into()).into();
        assert_eq!(unsupported.status, StatusCode::NOT_IMPLEMENTED);

        let rpc: ApiError = AdapterError::Rpc { code: -32000, message: "boom".into() }.into();
        assert_eq!(rpc.status, StatusCode::BAD_GATEWAY);
    }
}
