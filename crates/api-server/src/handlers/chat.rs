//! POST /v1/chat — AI-чат зі стрімінгом через SSE (F7.1–F7.4).
//!
//! З OPENAI_API_KEY: реальний function calling через gpt-4o
//! (див. [`crate::ai::chat`]) — модель викликає інструменти бекенду
//! (get_balances / get_transaction_history / get_fee_estimates / get_prices)
//! над реальними даними AppState, фінальна відповідь стрімиться токенами.
//! Без ключа: мок-стрім із приміткою, що AI вимкнений (fail-safe).
//!
//! Формат подій (стабільний контракт для розширення):
//! - `event: delta`, `data: {"content":"фрагмент"}` — фрагмент тексту;
//! - `event: done`, `data: [DONE]` — кінець стріму.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::dto::ChatRequest;
use crate::state::AppState;

pub async fn chat(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // Генерація йде у фоновій задачі, фрагменти тексту — через канал:
    // SSE-відповідь віддається одразу, токени стрімляться в міру появи.
    let (tx, rx) = mpsc::channel::<String>(32);

    match state.chat_ai.clone() {
        Some(chat_ai) => {
            let state = Arc::clone(&state);
            tokio::spawn(async move { chat_ai.run(state, req, tx).await });
        }
        None => {
            // Без OPENAI_API_KEY — мок-стрім (warn уже залогований при старті).
            tokio::spawn(mock_stream(req, tx));
        }
    }

    let deltas = ReceiverStream::new(rx).map(|content| {
        Ok(Event::default()
            .event("delta")
            .data(serde_json::json!({ "content": content }).to_string()))
    });
    // Канал закривається, коли задача завершилась → після всіх delta йде done.
    let done = futures::stream::once(async { Ok(Event::default().event("done").data("[DONE]")) });

    Sse::new(deltas.chain(done)).keep_alive(KeepAlive::default())
}

/// Мок-відповідь по словах — фронтенд інтегрує SSE без ключа OpenAI.
async fn mock_stream(req: ChatRequest, tx: mpsc::Sender<String>) {
    let last_user_msg = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let answer = format!(
        "(AI вимкнено: OPENAI_API_KEY не задано, це мок-відповідь.) \
         Відповідь AI-помічника на ваше питання «{last_user_msg}». \
         За останні 30 днів ви витратили 12.47 USD на комісії у 23 транзакціях: \
         Ethereum — 9.80 USD, Polygon — 1.12 USD, Solana — 1.55 USD. \
         Найдорожчою була взаємодія з Uniswap 3 дні тому (3.87 USD)."
    );

    // Стрімимо по слову з невеликою затримкою — імітація токен-стріму OpenAI.
    for word in answer.split_inclusive(' ') {
        if tx.send(word.to_string()).await.is_err() {
            return; // клієнт відключився
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
