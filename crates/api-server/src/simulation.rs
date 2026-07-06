//! Реальна симуляція транзакцій (F4.3) — POST /v1/tx/simulate.
//!
//! Стратегія за мережами:
//!
//! - **EVM** — без платних API: детермінована симуляція простих випадків.
//!   Нативний переказ: `after = before − value − fee`; ERC-20
//!   `transfer`/`approve`: decode calldata → зміни балансу токена (поточний
//!   баланс через `eth_call balanceOf`). Додатково `eth_call` самої
//!   транзакції перевіряє, що виклик не revert-иться (revert →
//!   `will_revert: true` + причина). Якщо задано `ALCHEMY_API_KEY`,
//!   використовується `alchemy_simulateAssetChanges` (покриває і невідомі
//!   методи); без ключа невідомі методи повертають `simulated: false`
//!   з поясненням у `warnings`.
//! - **Solana** — реальний `simulateTransaction` через RPC
//!   (`sigVerify: false`, `replaceRecentBlockhash: true`), якщо в
//!   `tx_request.data` передано серіалізовану транзакцію (base64/hex).
//! - **Bitcoin** — детерміновано: UTXO-переказ, `after = before − сума −
//!   комісія` (стандартний тариф sat/vB × ~141 vB для 1-in/2-out P2WPKH).
//!
//! Фейли мережі не валять відповідь (fail-safe, ТЗ §1.2): симулятор
//! деградує до `simulated: false` з поясненням у `warnings`.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use serde_json::json;

use chain_adapters::solana::BASE_FEE_LAMPORTS;
use chain_adapters::{
    AdapterError, Address, BitcoinAdapter, ChainAdapter, ChainId, EvmAdapter, FeeRate,
    SolanaAdapter,
};

use crate::chains::{
    format_base_units, known_tokens, native_coingecko_id, native_name, token_coingecko_id,
    token_name, EVM_CHAINS,
};
use crate::config::Config;
use crate::dto::{BalanceChange, SimulateRequest, SimulateResponse, TxRequest};
use crate::handlers::ApiError;
use crate::pricing::PriceService;
use crate::risk::parse_approve_calldata;

/// Типовий розмір BTC-переказу (1 вхід P2WPKH + 2 виходи) у vbytes.
const BTC_TYPICAL_VSIZE: u64 = 141;
/// Дефолтний газ нативного переказу EVM.
const NATIVE_TRANSFER_GAS: u128 = 21_000;
/// Таймаут на запит до Alchemy.
const ALCHEMY_TIMEOUT: Duration = Duration::from_secs(8);

/// Сервіс симуляції: тримає конкретні адаптери (не `dyn ChainAdapter`,
/// бо потрібні спеціалізовані методи `eth_call` / `simulateTransaction`).
pub struct Simulator {
    evm: HashMap<ChainId, EvmAdapter>,
    solana: SolanaAdapter,
    bitcoin: BitcoinAdapter,
    alchemy_api_key: Option<String>,
    http: reqwest::Client,
}

impl Simulator {
    pub fn new(config: &Config) -> Self {
        let rpc = &config.rpc;
        let urls: [(ChainId, &str); 5] = [
            (ChainId::Ethereum, rpc.ethereum.as_str()),
            (ChainId::Polygon, rpc.polygon.as_str()),
            (ChainId::Bsc, rpc.bsc.as_str()),
            (ChainId::Arbitrum, rpc.arbitrum.as_str()),
            (ChainId::Base, rpc.base.as_str()),
        ];
        let evm = urls
            .into_iter()
            .map(|(chain, url)| {
                (
                    chain,
                    EvmAdapter::new(chain, url).expect("EVM_CHAINS містить лише EVM-мережі"),
                )
            })
            .collect();
        Simulator {
            evm,
            solana: SolanaAdapter::new(rpc.solana.clone()),
            bitcoin: BitcoinAdapter::with_base_url(rpc.mempool_space.clone()),
            alchemy_api_key: config.alchemy_api_key.clone(),
            http: reqwest::Client::new(),
        }
    }

    /// Точка входу симуляції для всіх мереж.
    pub async fn simulate(
        &self,
        req: &SimulateRequest,
        prices: &PriceService,
    ) -> Result<SimulateResponse, ApiError> {
        let chain: ChainId = req
            .chain
            .parse()
            .map_err(|_| ApiError::bad_request(format!("невідома мережа: {}", req.chain)))?;

        match chain {
            c if c.is_evm() => self.simulate_evm(c, req, prices).await,
            ChainId::Solana => self.simulate_solana(req, prices).await,
            ChainId::Bitcoin => self.simulate_bitcoin(req, prices).await,
            _ => unreachable!("усі мережі покриті вище"),
        }
    }

    // -----------------------------------------------------------------------
    // EVM
    // -----------------------------------------------------------------------

    async fn simulate_evm(
        &self,
        chain: ChainId,
        req: &SimulateRequest,
        prices: &PriceService,
    ) -> Result<SimulateResponse, ApiError> {
        let signer = Address::new(chain, req.signer.clone()).map_err(ApiError::from)?;
        let tx = &req.tx_request;
        let from = tx.from.clone().unwrap_or_else(|| signer.as_str().to_string());
        let value = match tx.value.as_deref() {
            Some(v) => parse_amount(v)
                .ok_or_else(|| ApiError::bad_request(format!("некоректне value: {v}")))?,
            None => 0,
        };
        let data = normalize_calldata(tx.data.as_deref());
        let action = classify_evm_calldata(data.as_deref());

        let Some(to) = tx.to.clone() else {
            // Деплой контракту — поза детермінованими кейсами MVP.
            return Ok(SimulateResponse {
                success: true,
                simulated: false,
                warnings: vec![
                    "Транзакція без адреси одержувача (деплой контракту) — симуляція змін \
                     балансів недоступна"
                        .into(),
                ],
                ..Default::default()
            });
        };

        // Alchemy simulateAssetChanges (опційно, якщо є ключ) — покриває
        // і невідомі методи. Фейл Alchemy не валить запит: деградація до
        // детермінованої симуляції.
        if let Some(key) = &self.alchemy_api_key {
            match self
                .alchemy_asset_changes(chain, key, &from, &to, value, data.as_deref(), prices)
                .await
            {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    tracing::warn!("alchemy_simulateAssetChanges недоступний: {e}; \
                                    переходжу на детерміновану симуляцію");
                }
            }
        }

        let adapter = self.evm.get(&chain).expect("Simulator покриває всі EVM-мережі");
        let mut warnings: Vec<String> = Vec::new();

        // 1. eth_call: перевірка, що виклик не revert-иться (лише для
        //    транзакцій з calldata — переказ на EOA викликати нема сенсу).
        let mut will_revert = false;
        let mut revert_reason: Option<String> = None;
        if data.is_some() {
            match adapter
                .eth_call(Some(&from), &to, Some(value), data.as_deref())
                .await
            {
                Ok(_) => {}
                Err(AdapterError::Rpc { message, .. }) => {
                    will_revert = true;
                    revert_reason = Some(message);
                }
                Err(e) => warnings.push(format!(
                    "Не вдалося перевірити виклик через eth_call: {e}"
                )),
            }
        }

        // 2. Газ: eth_estimateGas → фолбек на типові значення.
        let gas_limit = match tx.gas.as_deref().and_then(parse_amount) {
            Some(g) => g,
            None if will_revert => NATIVE_TRANSFER_GAS,
            None => match adapter
                .estimate_gas(Some(&from), &to, Some(value), data.as_deref())
                .await
            {
                Ok(g) => g,
                Err(_) if data.is_none() => NATIVE_TRANSFER_GAS,
                Err(e) => {
                    warnings.push(format!("eth_estimateGas не вдалося: {e}; беру 100000"));
                    100_000
                }
            },
        };

        // 3. Ціна газу: з tx_request або зі стандартного тарифу мережі.
        let gas_price = match tx.max_fee_per_gas.as_deref().and_then(parse_amount) {
            Some(p) => p,
            None => match adapter.estimate_fees().await {
                Ok(est) => match est.standard {
                    FeeRate::Eip1559 { max_fee_per_gas, .. } => max_fee_per_gas,
                    _ => 0,
                },
                Err(e) => {
                    warnings.push(format!("Не вдалося оцінити комісію мережі: {e}"));
                    0
                }
            },
        };
        let fee_wei = gas_limit.saturating_mul(gas_price);

        // 4. Ціни в USD (нативна монета + токен, якщо відомий).
        let native_id = native_coingecko_id(chain).to_string();
        let known = known_tokens(chain);
        let token_cfg = match &action {
            EvmAction::Erc20Transfer { .. } | EvmAction::Approve { .. } => known
                .iter()
                .find(|t| t.address.eq_ignore_ascii_case(&to)),
            _ => None,
        };
        let mut ids = vec![native_id.clone()];
        if let Some(id) = token_cfg.and_then(|t| token_coingecko_id(&t.symbol)) {
            ids.push(id.to_string());
        }
        let (price_map, _) = prices.get_prices(&ids).await;
        let native_usd = price_map.get(&native_id).map(|p| p.usd).unwrap_or(0.0);

        let decimals = chain.native_decimals();
        let gas_cost_usd = (fee_wei as f64 / 10f64.powi(decimals as i32)) * native_usd;

        if will_revert {
            return Ok(SimulateResponse {
                success: false,
                simulated: true,
                will_revert: true,
                balance_changes: Vec::new(),
                warnings,
                gas_used: Some(gas_limit.to_string()),
                gas_cost_usd: Some(gas_cost_usd),
                revert_reason,
            });
        }

        // 5. Детерміновані зміни балансів за типом дії.
        let mut balance_changes: Vec<BalanceChange> = Vec::new();
        let mut simulated = true;

        match action {
            EvmAction::NativeTransfer => {
                let before = self.evm_native_balance(adapter, &signer, &mut warnings).await;
                if let Some(before) = before {
                    let delta = -((value.saturating_add(fee_wei)) as i128);
                    balance_changes.push(make_change(
                        signer.as_str(),
                        native_name(chain),
                        chain.native_symbol(),
                        None,
                        before,
                        delta,
                        decimals,
                        native_usd,
                        &mut warnings,
                    ));
                } else {
                    simulated = false;
                }
            }
            EvmAction::Erc20Transfer { amount, .. } => {
                let (symbol, token_decimals) = match token_cfg {
                    Some(t) => (t.symbol.clone(), t.decimals),
                    None => self.resolve_token_meta(adapter, &to, &mut warnings).await,
                };
                let token_usd = token_coingecko_id(&symbol)
                    .and_then(|id| price_map.get(id))
                    .map(|p| p.usd)
                    .unwrap_or(0.0);

                match adapter.erc20_balance(&to, signer.as_str()).await {
                    Ok(before) => {
                        let Some(amount) = amount else {
                            warnings.push(
                                "Сума transfer перевищує u128 — точна симуляція неможлива".into(),
                            );
                            return Ok(SimulateResponse {
                                success: true,
                                simulated: false,
                                warnings,
                                gas_used: Some(gas_limit.to_string()),
                                gas_cost_usd: Some(gas_cost_usd),
                                ..Default::default()
                            });
                        };
                        balance_changes.push(make_change(
                            signer.as_str(),
                            token_name(&symbol),
                            &symbol,
                            Some(to.clone()),
                            before,
                            -(amount as i128),
                            token_decimals,
                            token_usd,
                            &mut warnings,
                        ));
                    }
                    Err(e) => {
                        warnings.push(format!("Не вдалося отримати баланс токена: {e}"));
                        simulated = false;
                    }
                }
                // Комісія — окремою зміною нативного балансу.
                if let Some(native_before) =
                    self.evm_native_balance(adapter, &signer, &mut warnings).await
                {
                    balance_changes.push(make_change(
                        signer.as_str(),
                        native_name(chain),
                        chain.native_symbol(),
                        None,
                        native_before,
                        -(fee_wei as i128),
                        decimals,
                        native_usd,
                        &mut warnings,
                    ));
                }
            }
            EvmAction::Approve { spender, unlimited } => {
                let (symbol, _) = match token_cfg {
                    Some(t) => (t.symbol.clone(), t.decimals),
                    None => self.resolve_token_meta(adapter, &to, &mut warnings).await,
                };
                warnings.push(format!(
                    "approve не змінює баланси: {spender} отримає дозвіл витрачати {symbol}"
                ));
                if unlimited {
                    warnings.push(format!(
                        "УВАГА: необмежений дозвіл — {spender} зможе витратити ВСІ ваші {symbol}"
                    ));
                }
                if let Some(before) =
                    self.evm_native_balance(adapter, &signer, &mut warnings).await
                {
                    balance_changes.push(make_change(
                        signer.as_str(),
                        native_name(chain),
                        chain.native_symbol(),
                        None,
                        before,
                        -(fee_wei as i128),
                        decimals,
                        native_usd,
                        &mut warnings,
                    ));
                }
            }
            EvmAction::Unknown { selector } => {
                simulated = false;
                warnings.push(format!(
                    "Метод {selector} не розпізнано — детермінована симуляція покриває лише \
                     нативний переказ, ERC-20 transfer і approve. Для повної симуляції \
                     довільних викликів задайте ALCHEMY_API_KEY \
                     (alchemy_simulateAssetChanges). eth_call пройшов без revert."
                ));
            }
        }

        Ok(SimulateResponse {
            success: true,
            simulated,
            will_revert: false,
            balance_changes,
            warnings,
            gas_used: Some(gas_limit.to_string()),
            gas_cost_usd: Some(gas_cost_usd),
            revert_reason: None,
        })
    }

    async fn evm_native_balance(
        &self,
        adapter: &EvmAdapter,
        signer: &Address,
        warnings: &mut Vec<String>,
    ) -> Option<u128> {
        match adapter.get_native_balance(signer).await {
            Ok(b) => Some(b.amount),
            Err(e) => {
                warnings.push(format!("Не вдалося отримати нативний баланс: {e}"));
                None
            }
        }
    }

    /// symbol()/decimals() невідомого токена через RPC; фолбеки — "TOKEN"/18.
    async fn resolve_token_meta(
        &self,
        adapter: &EvmAdapter,
        token: &str,
        warnings: &mut Vec<String>,
    ) -> (String, u8) {
        let symbol = match adapter.erc20_symbol(token).await {
            Ok(Some(s)) => s,
            _ => {
                warnings.push(format!("Не вдалося визначити символ токена {token}"));
                "TOKEN".to_string()
            }
        };
        let decimals = match adapter.erc20_decimals(token).await {
            Ok(d) => d,
            Err(_) => {
                warnings.push(format!("Не вдалося визначити decimals токена {token}; беру 18"));
                18
            }
        };
        (symbol, decimals)
    }

    /// `alchemy_simulateAssetChanges` (потрібен `ALCHEMY_API_KEY`).
    ///
    /// ЗАДОКУМЕНТОВАНО, але покривається live-тестом лише за наявності ключа:
    /// повертає перелік змін активів (NATIVE / ERC20) для довільного виклику;
    /// `before` добирається поточним балансом через адаптер.
    #[allow(clippy::too_many_arguments)]
    async fn alchemy_asset_changes(
        &self,
        chain: ChainId,
        api_key: &str,
        from: &str,
        to: &str,
        value: u128,
        data: Option<&str>,
        prices: &PriceService,
    ) -> Result<SimulateResponse, String> {
        let subdomain = match chain {
            ChainId::Ethereum => "eth-mainnet",
            ChainId::Polygon => "polygon-mainnet",
            ChainId::Bsc => "bnb-mainnet",
            ChainId::Arbitrum => "arb-mainnet",
            ChainId::Base => "base-mainnet",
            _ => return Err("не EVM-мережа".into()),
        };
        let url = format!("https://{subdomain}.g.alchemy.com/v2/{api_key}");
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "alchemy_simulateAssetChanges",
            "params": [{
                "from": from,
                "to": to,
                "value": format!("0x{value:x}"),
                "data": data.unwrap_or("0x"),
            }]
        });
        let resp: serde_json::Value = self
            .http
            .post(&url)
            .json(&body)
            .timeout(ALCHEMY_TIMEOUT)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        if let Some(err) = resp.get("error") {
            return Err(err.to_string());
        }
        let result = resp
            .get("result")
            .ok_or_else(|| "відповідь без result".to_string())?;

        let mut response = SimulateResponse {
            success: true,
            simulated: true,
            ..Default::default()
        };
        if let Some(sim_err) = result.get("error").and_then(|e| e.get("message")) {
            response.success = false;
            response.will_revert = true;
            response.revert_reason = sim_err.as_str().map(str::to_string);
            return Ok(response);
        }
        response.gas_used = result
            .get("gasUsed")
            .and_then(|g| g.as_str())
            .and_then(parse_amount)
            .map(|g| g.to_string());

        let native_id = native_coingecko_id(chain).to_string();
        let (price_map, _) = prices.get_prices(std::slice::from_ref(&native_id)).await;
        let native_usd = price_map.get(&native_id).map(|p| p.usd).unwrap_or(0.0);
        let adapter = self.evm.get(&chain).expect("Simulator покриває всі EVM-мережі");
        let signer_lc = from.to_ascii_lowercase();

        for change in result
            .get("changes")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
        {
            let ch_from = change["from"].as_str().unwrap_or("").to_ascii_lowercase();
            let ch_to = change["to"].as_str().unwrap_or("").to_ascii_lowercase();
            if ch_from != signer_lc && ch_to != signer_lc {
                continue; // зміни чужих балансів не показуємо
            }
            let raw: u128 = change["rawAmount"]
                .as_str()
                .and_then(parse_amount)
                .unwrap_or(0);
            let delta: i128 = if ch_from == signer_lc { -(raw as i128) } else { raw as i128 };
            let symbol = change["symbol"].as_str().unwrap_or("?").to_string();
            let decimals = change["decimals"].as_u64().unwrap_or(18) as u8;
            let contract = change["contractAddress"].as_str().map(str::to_string);
            let is_native = change["assetType"].as_str() == Some("NATIVE");
            let before = if is_native {
                adapter
                    .get_native_balance(
                        &Address::new(chain, signer_lc.clone()).map_err(|e| e.to_string())?,
                    )
                    .await
                    .map(|b| b.amount)
                    .unwrap_or(0)
            } else if let Some(contract) = &contract {
                adapter.erc20_balance(contract, &signer_lc).await.unwrap_or(0)
            } else {
                0
            };
            let usd = if is_native { native_usd } else { 0.0 };
            let mut w = Vec::new();
            response.balance_changes.push(make_change(
                &signer_lc,
                change["name"].as_str().unwrap_or(&symbol),
                &symbol,
                contract,
                before,
                delta,
                decimals,
                usd,
                &mut w,
            ));
            response.warnings.extend(w);
        }
        Ok(response)
    }

    // -----------------------------------------------------------------------
    // Solana
    // -----------------------------------------------------------------------

    async fn simulate_solana(
        &self,
        req: &SimulateRequest,
        prices: &PriceService,
    ) -> Result<SimulateResponse, ApiError> {
        let signer = Address::solana(req.signer.clone()).map_err(ApiError::from)?;
        let tx = &req.tx_request;
        let mut warnings: Vec<String> = Vec::new();
        let mut response = SimulateResponse::default();

        // Реальний simulateTransaction, якщо передано серіалізовану
        // транзакцію (base64 або hex у tx_request.data).
        if let Some(data) = tx.data.as_deref().filter(|d| !d.trim().is_empty()) {
            let bytes = decode_solana_tx(data)
                .map_err(|e| ApiError::bad_request(format!("некоректна транзакція: {e}")))?;
            match self.solana.simulate_transaction(&bytes).await {
                Ok(sim) => {
                    response.simulated = true;
                    response.success = !sim.would_fail();
                    response.will_revert = sim.would_fail();
                    response.revert_reason = sim.error_summary();
                    response.gas_used = sim.units_consumed.map(|u| u.to_string());
                    if sim.would_fail() {
                        // Останні логи допомагають зрозуміти причину фейлу.
                        if let Some(logs) = &sim.logs {
                            warnings.extend(logs.iter().rev().take(3).rev().cloned());
                        }
                    }
                }
                Err(e) => {
                    warnings.push(format!("simulateTransaction не вдалося: {e}"));
                    response.success = true;
                }
            }
        } else {
            response.success = true;
        }

        // Детермінована зміна балансу для простого переказу SOL.
        let value = tx.value.as_deref().and_then(parse_amount);
        let native_id = native_coingecko_id(ChainId::Solana).to_string();
        let (price_map, _) = prices.get_prices(std::slice::from_ref(&native_id)).await;
        let sol_usd = price_map.get(&native_id).map(|p| p.usd).unwrap_or(0.0);
        let fee = BASE_FEE_LAMPORTS as u128;
        response.gas_cost_usd = Some((fee as f64 / 1e9) * sol_usd);

        if let Some(value) = value {
            match self.solana.get_native_balance(&signer).await {
                Ok(balance) => {
                    let delta = -((value.saturating_add(fee)) as i128);
                    response.balance_changes.push(make_change(
                        signer.as_str(),
                        native_name(ChainId::Solana),
                        "SOL",
                        None,
                        balance.amount,
                        delta,
                        9,
                        sol_usd,
                        &mut warnings,
                    ));
                    response.simulated = true;
                }
                Err(e) => warnings.push(format!("Не вдалося отримати баланс SOL: {e}")),
            }
        } else if !response.simulated {
            warnings.push(
                "Не передано ані серіалізовану транзакцію (tx_request.data), ані суму \
                 (tx_request.value) — симулювати нічого"
                    .into(),
            );
        }

        response.warnings = warnings;
        Ok(response)
    }

    // -----------------------------------------------------------------------
    // Bitcoin
    // -----------------------------------------------------------------------

    async fn simulate_bitcoin(
        &self,
        req: &SimulateRequest,
        prices: &PriceService,
    ) -> Result<SimulateResponse, ApiError> {
        let signer = Address::bitcoin(req.signer.clone()).map_err(ApiError::from)?;
        let value = match req.tx_request.value.as_deref() {
            Some(v) => parse_amount(v)
                .ok_or_else(|| ApiError::bad_request(format!("некоректне value: {v}")))?,
            None => {
                return Ok(SimulateResponse {
                    success: true,
                    simulated: false,
                    warnings: vec!["Для Bitcoin потрібна сума переказу (tx_request.value, sats)".into()],
                    ..Default::default()
                });
            }
        };

        let mut warnings: Vec<String> = Vec::new();

        // Комісія: стандартний sat/vB × типовий розмір транзакції.
        let sat_per_vb = match self.bitcoin.estimate_fees().await {
            Ok(est) => match est.standard {
                FeeRate::BitcoinSatPerVb { sat_per_vbyte } => sat_per_vbyte,
                _ => 0,
            },
            Err(e) => {
                warnings.push(format!("Не вдалося оцінити комісію: {e}; беру 2 sat/vB"));
                2
            }
        };
        let fee = (sat_per_vb * BTC_TYPICAL_VSIZE) as u128;

        let native_id = native_coingecko_id(ChainId::Bitcoin).to_string();
        let (price_map, _) = prices.get_prices(std::slice::from_ref(&native_id)).await;
        let btc_usd = price_map.get(&native_id).map(|p| p.usd).unwrap_or(0.0);

        let mut balance_changes = Vec::new();
        let mut simulated = true;
        match self.bitcoin.get_native_balance(&signer).await {
            Ok(balance) => {
                let delta = -((value.saturating_add(fee)) as i128);
                balance_changes.push(make_change(
                    signer.as_str(),
                    native_name(ChainId::Bitcoin),
                    "BTC",
                    None,
                    balance.amount,
                    delta,
                    8,
                    btc_usd,
                    &mut warnings,
                ));
            }
            Err(e) => {
                warnings.push(format!("Не вдалося отримати баланс BTC: {e}"));
                simulated = false;
            }
        }

        Ok(SimulateResponse {
            success: true,
            simulated,
            will_revert: false,
            balance_changes,
            warnings,
            gas_used: None,
            gas_cost_usd: Some((fee as f64 / 1e8) * btc_usd),
            revert_reason: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Чисті функції (юніт-тестуються без мережі)
// ---------------------------------------------------------------------------

/// Розпізнана дія EVM-calldata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EvmAction {
    NativeTransfer,
    /// `transfer(address,uint256)`. `amount = None`, якщо сума > u128.
    Erc20Transfer { to: String, amount: Option<u128> },
    /// `approve(address,uint256)`.
    Approve { spender: String, unlimited: bool },
    Unknown { selector: String },
}

/// Прибирає префікс 0x і повертає `None` для порожньої calldata.
pub(crate) fn normalize_calldata(data: Option<&str>) -> Option<String> {
    let data = data?.trim();
    let hex_body = data.strip_prefix("0x").or_else(|| data.strip_prefix("0X")).unwrap_or(data);
    if hex_body.is_empty() {
        None
    } else {
        Some(format!("0x{hex_body}"))
    }
}

/// Класифікація calldata: нативний переказ / ERC-20 transfer / approve / інше.
pub(crate) fn classify_evm_calldata(data: Option<&str>) -> EvmAction {
    let Some(data) = data else {
        return EvmAction::NativeTransfer;
    };
    let hex_body = data.strip_prefix("0x").unwrap_or(data);
    if hex_body.len() < 8 {
        return EvmAction::Unknown { selector: format!("0x{hex_body}") };
    }
    if hex_body[..8].eq_ignore_ascii_case("a9059cbb") {
        if let Some((to, amount)) = decode_erc20_transfer(hex_body) {
            return EvmAction::Erc20Transfer { to, amount };
        }
    }
    if let Some(approve) = parse_approve_calldata(data) {
        return EvmAction::Approve {
            spender: approve.spender.clone(),
            unlimited: approve.is_effectively_unlimited(),
        };
    }
    EvmAction::Unknown {
        selector: format!("0x{}", &hex_body[..8].to_ascii_lowercase()),
    }
}

/// Decode `transfer(address,uint256)`: (одержувач, сума).
/// Сума `None`, якщо > u128::MAX (нереалістично, але не панікуємо).
pub(crate) fn decode_erc20_transfer(hex_body: &str) -> Option<(String, Option<u128>)> {
    if hex_body.len() < 8 + 64 + 64 {
        return None;
    }
    let to_word = &hex_body[8..72];
    let amount_word = &hex_body[72..136];
    if !to_word[..24].chars().all(|c| c == '0') {
        return None; // адреса має бути вирівняна нулями
    }
    let to = format!("0x{}", &to_word[24..].to_ascii_lowercase());
    let amount = if amount_word[..32].chars().all(|c| c == '0') {
        u128::from_str_radix(&amount_word[32..], 16).ok()
    } else {
        None // сума не влазить в u128
    };
    Some((to, amount))
}

/// Парсер суми: hex з 0x або десятковий рядок → u128.
pub(crate) fn parse_amount(s: &str) -> Option<u128> {
    let s = s.trim();
    if let Some(hex_body) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u128::from_str_radix(hex_body, 16).ok()
    } else {
        s.parse().ok()
    }
}

/// Серіалізована Solana-транзакція: base64 або hex (з/без 0x).
fn decode_solana_tx(data: &str) -> Result<Vec<u8>, String> {
    let trimmed = data.trim();
    if let Some(hex_body) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return hex::decode(hex_body).map_err(|e| e.to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .or_else(|_| hex::decode(trimmed))
        .map_err(|_| "очікується base64 або hex".to_string())
}

/// Формує [`BalanceChange`] з балансу «до» і дельти в базових одиницях.
///
/// Якщо `before + delta < 0` (недостатньо коштів) — `after = 0` і
/// додається попередження.
#[allow(clippy::too_many_arguments)]
pub(crate) fn make_change(
    address: &str,
    asset: &str,
    symbol: &str,
    contract_address: Option<String>,
    before: u128,
    delta: i128,
    decimals: u8,
    price_usd: f64,
    warnings: &mut Vec<String>,
) -> BalanceChange {
    let after_signed = before as i128 + delta;
    let after = if after_signed < 0 {
        warnings.push(format!(
            "Недостатньо коштів: баланс {} {symbol}, потрібно {}",
            format_base_units(before, decimals),
            format_base_units(delta.unsigned_abs(), decimals)
        ));
        0
    } else {
        after_signed as u128
    };
    let delta_str = if delta < 0 {
        format!("-{}", format_base_units(delta.unsigned_abs(), decimals))
    } else {
        format!("+{}", format_base_units(delta.unsigned_abs(), decimals))
    };
    let usd_delta = (delta as f64 / 10f64.powi(decimals as i32)) * price_usd;
    BalanceChange {
        address: address.to_string(),
        asset: asset.to_string(),
        symbol: symbol.to_string(),
        contract_address,
        before: format_base_units(before, decimals),
        after: format_base_units(after, decimals),
        delta: delta_str,
        usd_delta,
    }
}

// Використовується у simulate_evm для довідки; узгоджено з chains::EVM_CHAINS.
const _: () = assert!(EVM_CHAINS.len() == 5);

/// Заглушка типу для документації: симулятор приймає `TxRequest` з dto.
#[allow(dead_code)]
fn _dto_tx_request_marker(_t: &TxRequest) {}

#[cfg(test)]
mod tests {
    use super::*;

    const RECIPIENT: &str = "0xab5801a7d398351b8be11c439e05c5b3259aec9b";

    #[test]
    fn parse_amount_hex_and_decimal() {
        assert_eq!(parse_amount("0xde0b6b3a7640000"), Some(1_000_000_000_000_000_000));
        assert_eq!(parse_amount("150"), Some(150));
        assert_eq!(parse_amount(" 0x0 "), Some(0));
        assert_eq!(parse_amount("нуль"), None);
        assert_eq!(parse_amount("0xzz"), None);
    }

    #[test]
    fn classify_native_transfer() {
        assert_eq!(classify_evm_calldata(None), EvmAction::NativeTransfer);
        assert_eq!(normalize_calldata(Some("0x")), None);
        assert_eq!(normalize_calldata(Some("")), None);
        assert_eq!(normalize_calldata(Some("0xa9059cbb")).as_deref(), Some("0xa9059cbb"));
    }

    #[test]
    fn classify_and_decode_erc20_transfer() {
        // transfer(RECIPIENT, 1_000_000) — 1 USDC (6 decimals).
        let calldata = format!(
            "0xa9059cbb000000000000000000000000{}{:0>64x}",
            &RECIPIENT[2..],
            1_000_000u128
        );
        match classify_evm_calldata(Some(&calldata)) {
            EvmAction::Erc20Transfer { to, amount } => {
                assert_eq!(to, RECIPIENT);
                assert_eq!(amount, Some(1_000_000));
            }
            other => panic!("очікував Erc20Transfer, отримав {other:?}"),
        }
    }

    #[test]
    fn erc20_transfer_amount_above_u128_is_none() {
        let calldata = format!(
            "a9059cbb000000000000000000000000{}{}",
            &RECIPIENT[2..],
            "f".repeat(64)
        );
        let (to, amount) = decode_erc20_transfer(&calldata).unwrap();
        assert_eq!(to, RECIPIENT);
        assert_eq!(amount, None);
    }

    #[test]
    fn classify_approve_unlimited() {
        let calldata = format!(
            "0x095ea7b3000000000000000000000000{}{}",
            "1111111254eeb25477b68fb85ed929f73a960582",
            "f".repeat(64)
        );
        match classify_evm_calldata(Some(&calldata)) {
            EvmAction::Approve { spender, unlimited } => {
                assert_eq!(spender, "0x1111111254eeb25477b68fb85ed929f73a960582");
                assert!(unlimited);
            }
            other => panic!("очікував Approve, отримав {other:?}"),
        }
    }

    #[test]
    fn classify_unknown_selector() {
        // swapExactETHForTokens
        match classify_evm_calldata(Some("0x7ff36ab5deadbeef")) {
            EvmAction::Unknown { selector } => assert_eq!(selector, "0x7ff36ab5"),
            other => panic!("очікував Unknown, отримав {other:?}"),
        }
    }

    #[test]
    fn make_change_native_transfer_math() {
        // Баланс 1.25 ETH, переказ 0.2 ETH, комісія 0.0011 ETH.
        let before = 1_250_000_000_000_000_000u128;
        let value = 200_000_000_000_000_000u128;
        let fee = 1_100_000_000_000_000u128;
        let mut warnings = Vec::new();
        let change = make_change(
            RECIPIENT,
            "Ether",
            "ETH",
            None,
            before,
            -((value + fee) as i128),
            18,
            3500.0,
            &mut warnings,
        );
        assert_eq!(change.before, "1.25");
        assert_eq!(change.after, "1.0489");
        assert_eq!(change.delta, "-0.2011");
        assert!((change.usd_delta - (-0.2011 * 3500.0)).abs() < 1e-6);
        assert!(warnings.is_empty());
    }

    #[test]
    fn make_change_insufficient_funds_warns_and_floors_at_zero() {
        let mut warnings = Vec::new();
        let change = make_change(
            RECIPIENT,
            "USD Coin",
            "USDC",
            Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()),
            5_000_000, // 5 USDC
            -10_000_000, // переказ 10 USDC
            6,
            1.0,
            &mut warnings,
        );
        assert_eq!(change.after, "0");
        assert_eq!(change.delta, "-10");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Недостатньо коштів"));
    }

    #[test]
    fn make_change_incoming_delta_is_positive() {
        let mut warnings = Vec::new();
        let change = make_change(
            RECIPIENT, "USD Coin", "USDC", None, 532_100_000, 698_400_000, 6, 1.0, &mut warnings,
        );
        assert_eq!(change.before, "532.1");
        assert_eq!(change.after, "1230.5");
        assert_eq!(change.delta, "+698.4");
        assert!((change.usd_delta - 698.4).abs() < 1e-9);
    }

    #[test]
    fn decode_solana_tx_accepts_base64_and_hex() {
        assert_eq!(decode_solana_tx("aGVsbG8=").unwrap(), b"hello".to_vec());
        assert_eq!(decode_solana_tx("0x0102").unwrap(), vec![1, 2]);
        assert!(decode_solana_tx("!!!").is_err());
    }
}
