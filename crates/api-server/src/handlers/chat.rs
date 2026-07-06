//! POST /v1/chat — AI-чат зі стрімінгом через SSE (F7.1–F7.4). МОК-стрім.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;

use crate::dto::ChatRequest;
use crate::state::AppState;

/// Стрімить мок-відповідь по словах, щоб фронтенд міг інтегрувати SSE одразу.
///
/// Формат подій:
/// - `event: delta`, `data: {"content":"слово "}` — фрагмент тексту;
/// - `event: done`, `data: [DONE]` — кінець стріму.
pub async fn chat(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<ChatRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // TODO: ai-service — OpenAI function calling (gpt-4o через async-openai):
    // модель викликає інструменти бекенду get_fee_spending / get_balances /
    // get_approvals / get_tx_history (F7.2) — і НІКОЛИ не вигадує цифри.
    // Захист (F7.4, ТЗ розділ 6 п.5): чат не має інструментів для
    // підпису/надсилання; дані транзакцій подаються як структуровані поля,
    // не як інструкції; rate limit + денний бюджет токенів на користувача.

    let last_user_msg = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let answer = format!(
        "Це мок-відповідь AI-помічника на ваше питання «{last_user_msg}». \
         За останні 30 днів ви витратили 12.47 USD на комісії у 23 транзакціях: \
         Ethereum — 9.80 USD, Polygon — 1.12 USD, Solana — 1.55 USD. \
         Найдорожчою була взаємодія з Uniswap 3 дні тому (3.87 USD)."
    );

    let words: Vec<String> = answer
        .split_inclusive(' ')
        .map(str::to_string)
        .collect();

    let delta_events = words.into_iter().map(|w| {
        Ok(Event::default()
            .event("delta")
            .data(serde_json::json!({ "content": w }).to_string()))
    });
    let done_event = std::iter::once(Ok(Event::default().event("done").data("[DONE]")));

    // Стрімимо по слову з невеликою затримкою — імітація токен-стріму OpenAI.
    let stream = tokio_stream::StreamExt::throttle(
        futures::stream::iter(delta_events.chain(done_event)),
        Duration::from_millis(25),
    );

    Sse::new(stream).keep_alive(KeepAlive::default())
}
