//! Minimal JSON-RPC 2.0 client over HTTP, shared by the EVM and Solana adapters.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AdapterError;

#[derive(Debug, Clone)]
pub(crate) struct JsonRpcClient {
    http: reqwest::Client,
    url: String,
}

#[derive(Debug, Serialize)]
struct RpcRequest<'a, P: Serialize> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: P,
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
    result: Option<Value>,
    error: Option<RpcErrorObject>,
}

#[derive(Debug, Deserialize)]
struct RpcErrorObject {
    code: i64,
    message: String,
}

impl JsonRpcClient {
    pub(crate) fn new(url: impl Into<String>) -> Self {
        JsonRpcClient {
            http: reqwest::Client::new(),
            url: url.into(),
        }
    }

    /// Perform a JSON-RPC call and deserialize `result` into `R`.
    pub(crate) async fn call<P, R>(&self, method: &str, params: P) -> Result<R, AdapterError>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let request = RpcRequest {
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
        };
        let response: RpcResponse = self
            .http
            .post(&self.url)
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        if let Some(err) = response.error {
            return Err(AdapterError::Rpc {
                code: err.code,
                message: err.message,
            });
        }
        let result = response
            .result
            .ok_or_else(|| AdapterError::parse(format!("{method}: missing result")))?;
        Ok(serde_json::from_value(result)?)
    }
}
