//! Minimal JSON-RPC 2.0 client over HTTP, shared by the EVM and Solana adapters.
//!
//! Reliability (retry + concurrency limiting) is **opt-in**: `new` keeps the
//! original, unwrapped behaviour and is the constructor Solana uses, so the
//! Solana code path is entirely unaffected. EVM opts in via `with_reliability`.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AdapterError;
use crate::reliability::{
    handle_json_response, HttpFailure, ReliabilityLayer, RetryPolicy,
};

#[derive(Debug, Clone)]
pub(crate) struct JsonRpcClient {
    http: reqwest::Client,
    url: String,
    /// `None` — plain client (Solana): no retry, no rate limit.
    /// `Some` — reliable client (EVM): retry + per-provider concurrency limit.
    reliability: Option<ReliabilityLayer>,
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
    /// Plain client — **unchanged** behaviour (no retry, no rate limiting).
    /// This is the constructor the Solana adapter uses.
    pub(crate) fn new(url: impl Into<String>) -> Self {
        JsonRpcClient {
            http: reqwest::Client::new(),
            url: url.into(),
            reliability: None,
        }
    }

    /// Reliable client — wraps every call in retry-with-backoff on transient
    /// errors and a per-provider concurrency limit. Used by the EVM adapter.
    pub(crate) fn with_reliability(url: impl Into<String>, policy: RetryPolicy) -> Self {
        JsonRpcClient {
            http: reqwest::Client::new(),
            url: url.into(),
            reliability: Some(ReliabilityLayer::new(
                policy,
                crate::reliability::DEFAULT_CONCURRENCY,
            )),
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
        match &self.reliability {
            // Solana path: identical to the original implementation.
            None => self.call_plain(&request).await,
            // EVM path: retry + rate limit. Serialize the request once so the
            // op closure can be replayed across attempts.
            Some(layer) => {
                let body = serde_json::to_value(&request)?;
                layer
                    .run(|| self.call_once(method, &body))
                    .await
            }
        }
    }

    /// Original, unwrapped call — preserved verbatim for the Solana code path.
    async fn call_plain<P, R>(&self, request: &RpcRequest<'_, P>) -> Result<R, AdapterError>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let response: RpcResponse = self
            .http
            .post(&self.url)
            .json(request)
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
            .ok_or_else(|| AdapterError::parse(format!("{}: missing result", request.method)))?;
        Ok(serde_json::from_value(result)?)
    }

    /// A single reliable attempt: send the pre-serialized body, classify the
    /// outcome for the retry loop. JSON-RPC business errors (e.g. execution
    /// reverted) are permanent; transport/5xx/429 are transient.
    async fn call_once<R>(&self, method: &str, body: &Value) -> Result<R, HttpFailure>
    where
        R: DeserializeOwned,
    {
        let response = self
            .http
            .post(&self.url)
            .json(body)
            .send()
            .await
            .map_err(HttpFailure::from_reqwest)?;

        let rpc: RpcResponse = handle_json_response(response).await?;

        if let Some(err) = rpc.error {
            // A JSON-RPC application error is a business outcome, not a
            // transient transport failure — never retried.
            return Err(HttpFailure::permanent(AdapterError::Rpc {
                code: err.code,
                message: err.message,
            }));
        }
        let result = rpc.result.ok_or_else(|| {
            HttpFailure::permanent(AdapterError::parse(format!("{method}: missing result")))
        })?;
        serde_json::from_value(result)
            .map_err(|e| HttpFailure::permanent(AdapterError::Json(e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_client_has_no_reliability() {
        // The Solana adapter builds its client with `new`; prove that path
        // carries neither retry nor a rate limiter.
        let client = JsonRpcClient::new("http://localhost:8899");
        assert!(client.reliability.is_none());
    }

    #[test]
    fn reliable_client_opts_in() {
        let client = JsonRpcClient::with_reliability("http://localhost:8545", RetryPolicy::default());
        assert!(client.reliability.is_some());
    }
}
