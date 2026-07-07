//! Реєстр chain-adapters: по одному адаптеру на кожну з 7 мереж (ТЗ §F2.2).
//!
//! Тут же — статичні метадані, потрібні для збагачення відповідей API:
//! списки відомих ERC-20 токенів (без індексера токени задаються конфігом),
//! CoinGecko-ідентифікатори нативних монет і людські назви активів.

use std::collections::HashMap;
use std::sync::Arc;

use chain_adapters::{
    BitcoinAdapter, ChainAdapter, ChainId, EvmAdapter, SolanaAdapter, TokenConfig, TronAdapter,
};

use crate::config::RpcConfig;

/// EVM-мережі MVP (порядок стабільний для відповідей API).
pub const EVM_CHAINS: [ChainId; 5] = [
    ChainId::Ethereum,
    ChainId::Polygon,
    ChainId::Bsc,
    ChainId::Arbitrum,
    ChainId::Base,
];

/// Реєстр адаптерів усіх мереж.
pub type AdapterRegistry = HashMap<ChainId, Arc<dyn ChainAdapter>>;

/// Створює адаптери для всіх 8 мереж за конфігурацією RPC.
/// `trongrid_api_key` — опційний ключ TronGrid (вищі rate-limit'и).
pub fn build_registry(rpc: &RpcConfig, trongrid_api_key: Option<&str>) -> AdapterRegistry {
    let mut registry: AdapterRegistry = HashMap::new();

    let evm_urls: [(ChainId, &str); 5] = [
        (ChainId::Ethereum, rpc.ethereum.as_str()),
        (ChainId::Polygon, rpc.polygon.as_str()),
        (ChainId::Bsc, rpc.bsc.as_str()),
        (ChainId::Arbitrum, rpc.arbitrum.as_str()),
        (ChainId::Base, rpc.base.as_str()),
    ];
    for (chain, url) in evm_urls {
        let adapter = EvmAdapter::with_tokens(chain, url, known_tokens(chain))
            .expect("EVM_CHAINS містить лише EVM-мережі");
        registry.insert(chain, Arc::new(adapter));
    }
    registry.insert(
        ChainId::Solana,
        Arc::new(SolanaAdapter::new(rpc.solana.clone())),
    );
    registry.insert(
        ChainId::Bitcoin,
        Arc::new(BitcoinAdapter::with_base_url(rpc.mempool_space.clone())),
    );
    registry.insert(
        ChainId::Tron,
        Arc::new(
            TronAdapter::new(rpc.tron.clone())
                .with_api_key(trongrid_api_key.map(str::to_string)),
        ),
    );
    registry
}

/// Відомі ERC-20 токени, які опитуємо без індексера (стейблкоїни MVP).
/// TODO(indexer): автовиявлення токенів (ТЗ §F2.3) замінить цей список.
pub fn known_tokens(chain: ChainId) -> Vec<TokenConfig> {
    let t = |address: &str, symbol: &str, decimals: u8| TokenConfig {
        address: address.to_string(),
        symbol: symbol.to_string(),
        decimals,
    };
    match chain {
        ChainId::Ethereum => vec![
            t("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDC", 6),
            t("0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT", 6),
            t("0x6b175474e89094c44da98b954eedeac495271d0f", "DAI", 18),
        ],
        ChainId::Polygon => vec![
            t("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "USDC", 6),
            t("0xc2132d05d31c914a87c6611c10748aeb04b58e8f", "USDT", 6),
        ],
        ChainId::Bsc => vec![
            t("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "USDC", 18),
            t("0x55d398326f99059ff775485246999027b3197955", "USDT", 18),
        ],
        ChainId::Arbitrum => vec![
            t("0xaf88d065e77c8cc2239327c5edb3a432268e5831", "USDC", 6),
            t("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT", 6),
        ],
        ChainId::Base => vec![
            t("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USDC", 6),
        ],
        // TRC-20 (TRON) обслуговує TronAdapter власним списком, не EVM-конфігом.
        ChainId::Solana | ChainId::Bitcoin | ChainId::Tron => Vec::new(),
    }
}

/// CoinGecko id нативної монети мережі (ETH для Ethereum/Arbitrum/Base).
///
/// Polygon: після міграції MATIC→POL старий id `matic-network` більше не
/// повертає ціну — актуальний id `polygon-ecosystem-token` (перевірено live).
pub fn native_coingecko_id(chain: ChainId) -> &'static str {
    match chain {
        ChainId::Ethereum | ChainId::Arbitrum | ChainId::Base => "ethereum",
        ChainId::Polygon => "polygon-ecosystem-token",
        ChainId::Bsc => "binancecoin",
        ChainId::Solana => "solana",
        ChainId::Bitcoin => "bitcoin",
        ChainId::Tron => "tron",
    }
}

/// CoinGecko id токена за тикером (лише відомі стейблкоїни MVP).
pub fn token_coingecko_id(symbol: &str) -> Option<&'static str> {
    match symbol {
        "USDC" => Some("usd-coin"),
        "USDT" => Some("tether"),
        "DAI" => Some("dai"),
        _ => None,
    }
}

/// Людська назва нативної монети.
pub fn native_name(chain: ChainId) -> &'static str {
    match chain {
        ChainId::Ethereum | ChainId::Arbitrum | ChainId::Base => "Ether",
        ChainId::Polygon => "Polygon Ecosystem Token",
        ChainId::Bsc => "BNB",
        ChainId::Solana => "Solana",
        ChainId::Bitcoin => "Bitcoin",
        ChainId::Tron => "TRON",
    }
}

/// Людська назва токена за тикером (fallback — сам тикер).
pub fn token_name(symbol: &str) -> &'static str {
    match symbol {
        "USDC" => "USD Coin",
        "USDT" => "Tether USD",
        "DAI" => "Dai Stablecoin",
        "SPL" => "SPL Token",
        _ => "Token",
    }
}

/// Форматує суму в мінімальних одиницях у людський десятковий рядок
/// без втрати точності (u128-арифметика, обрізає хвостові нулі).
pub fn format_base_units(amount: u128, decimals: u8) -> String {
    let scale = 10u128.checked_pow(decimals as u32);
    let Some(scale) = scale else {
        return amount.to_string();
    };
    let whole = amount / scale;
    let frac = amount % scale;
    if frac == 0 {
        return whole.to_string();
    }
    let frac_str = format!("{frac:0>width$}", width = decimals as usize);
    format!("{whole}.{}", frac_str.trim_end_matches('0'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_all_chains() {
        let registry = build_registry(&RpcConfig::default(), None);
        assert_eq!(registry.len(), 8);
        for chain in ChainId::ALL {
            let adapter = registry.get(&chain).expect("адаптер для кожної мережі");
            assert_eq!(adapter.chain(), chain);
        }
    }

    #[test]
    fn coingecko_ids_map_l2_to_ethereum() {
        assert_eq!(native_coingecko_id(ChainId::Arbitrum), "ethereum");
        assert_eq!(native_coingecko_id(ChainId::Base), "ethereum");
        assert_eq!(native_coingecko_id(ChainId::Polygon), "polygon-ecosystem-token");
        assert_eq!(native_coingecko_id(ChainId::Bsc), "binancecoin");
        assert_eq!(token_coingecko_id("USDC"), Some("usd-coin"));
        assert_eq!(token_coingecko_id("WIF"), None);
    }

    #[test]
    fn format_base_units_is_exact() {
        assert_eq!(format_base_units(0, 18), "0");
        assert_eq!(format_base_units(1_250_000_000_000_000_000, 18), "1.25");
        assert_eq!(format_base_units(1, 18), "0.000000000000000001");
        assert_eq!(format_base_units(2_500_000, 8), "0.025");
        assert_eq!(format_base_units(12_345_678, 6), "12.345678");
        assert_eq!(format_base_units(42, 0), "42");
    }
}
