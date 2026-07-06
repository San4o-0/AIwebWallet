//! HTTP-хендлери ендпоінтів `/v1`.

pub mod analytics;
pub mod balances;
pub mod chat;
pub mod health;
pub mod history;
pub mod prices;
pub mod tx;

/// Поточний unix-час у секундах (для мок-даних і таймстемпів).
pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
