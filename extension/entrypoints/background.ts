/**
 * Background service worker (Manifest V3):
 *  - приймає типізовані повідомлення від content script і popup (src/lib/messaging.ts);
 *  - виконує vault-операції через WASM-ядро (crates/wallet-core): створення,
 *    розблокування (Argon2id + AES-256-GCM), деривація акаунтів, підписи;
 *  - тримає розшифровану seed-фразу ТІЛЬКИ в пам'яті сесії з автолоком —
 *    у chrome.storage.local лежить лише зашифрований vault (vault-storage.ts);
 *  - чергує запити на підпис від dApps і відкриває вікно попапа (екран Approve).
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

import { broadcastTx, fetchTxParams } from '@/src/lib/api';
import { CHAINS, type Chain } from '@/src/lib/chains';
import {
  decodePersonalSignMessage,
  type Eip1559TxParams,
  type SignedEvmTx,
} from '@/src/lib/evm';
import {
  MessageType,
  PRIVILEGED_MESSAGE_TYPES,
  RPC_ERRORS,
  isBackgroundMessage,
  type BackgroundMessage,
  type BgRemoveWallet,
  type BgRenameWallet,
  type BgResolveApproval,
  type BgRestoreVaultPassword,
  type BgRpcRequest,
  type BgSwitchWallet,
  type BgVaultCreate,
  type BgVaultDeriveAccount,
  type BgVaultSignMessage,
  type BgVaultSignTransaction,
  type BgVaultUnlock,
  type Json,
  type PendingSignRequest,
  type PublicAccount,
  type RestoreVaultResult,
  type RpcOutcome,
  type SessionState,
  type VaultResult,
  type WalletsState,
} from '@/src/lib/messaging';
import {
  addVaultRecord,
  getActiveVaultId,
  getActiveVaultRecord,
  listVaultRecords,
  mnemonicOwnsRecord,
  removeVaultRecord,
  renameVaultRecord,
  replaceVaultCiphertext,
  setActiveVaultId,
  updateVaultAccounts,
  type VaultRecord,
} from '@/src/lib/vault-storage';
import { loadWalletCoreWasm, toWasmError } from '@/src/wasm';

/** Мережа для dApp-запитів (eth_chainId → 0x1). TODO: wallet_switchEthereumChain. */
const DAPP_CHAIN: Chain = 'ethereum';
const DAPP_CHAIN_ID_HEX = CHAINS[DAPP_CHAIN].evmChainIdHex ?? '0x1';
const AUTO_LOCK_MS = 5 * 60_000;

/** JSON-форма derivation::Addresses із WASM-ядра. */
interface WasmAddresses {
  index: number;
  evm: string;
  solana: string;
  bitcoin: string;
}

/** JSON-форма vault::VaultData із WASM-ядра (розшифрований vault). */
interface WasmVaultData {
  mnemonic: string;
  accounts: {
    name: string;
    index: number;
    evm_address: string;
    solana_address: string;
    bitcoin_address: string;
  }[];
}

export default defineBackground(() => {
  // -------------------------------------------------------------------------
  // Сесія та автолок.
  // Розшифрована seed-фраза живе лише тут (пам'ять SW) і затирається при
  // lock/автолоку. Коли SW засинає, пам'ять скидається — це «лок за фактом»:
  // після пробудження користувач вводить пароль знову. Секрети НІКОЛИ не
  // пишуться у chrome.storage.
  // -------------------------------------------------------------------------
  const LOCKED_SESSION: SessionState = {
    unlocked: false,
    address: null,
    autoLockAt: null,
    accounts: [],
    walletId: null,
    walletName: null,
  };
  let session: SessionState = LOCKED_SESSION;
  let sessionMnemonic: string | null = null;
  let autoLockTimer: ReturnType<typeof setTimeout> | undefined;

  function lockSession(): void {
    session = LOCKED_SESSION;
    // JS не дає гарантованого zeroize рядків; всередині WASM-ядра секрети
    // затираються (Zeroizing), тут — прибираємо посилання.
    sessionMnemonic = null;
    if (autoLockTimer !== undefined) clearTimeout(autoLockTimer);
    autoLockTimer = undefined;
  }

  function touchAutoLock(): void {
    if (!session.unlocked) return;
    if (autoLockTimer !== undefined) clearTimeout(autoLockTimer);
    session = { ...session, autoLockAt: Date.now() + AUTO_LOCK_MS };
    autoLockTimer = setTimeout(lockSession, AUTO_LOCK_MS);
  }

  function unlockSession(wallet: VaultRecord, mnemonic: string, accounts: PublicAccount[]): void {
    sessionMnemonic = mnemonic;
    session = {
      unlocked: true,
      address: accounts[0]?.addresses.evm ?? null,
      autoLockAt: Date.now() + AUTO_LOCK_MS,
      accounts,
      walletId: wallet.id,
      walletName: wallet.name,
    };
    touchAutoLock();
  }

  // -------------------------------------------------------------------------
  // Vault-операції (WASM-ядро). Кожна повертає VaultResult із текстом помилки
  // для UI замість генеричного "internal error".
  // -------------------------------------------------------------------------

  function vaultError(error: unknown): { ok: false; error: string } {
    return { ok: false, error: toWasmError(error).message };
  }

  async function vaultCreate(message: BgVaultCreate): Promise<VaultResult<PublicAccount>> {
    try {
      const wasm = await loadWalletCoreWasm();
      const accountName = message.accountName;
      // createVault: валідація BIP-39 → деривація адрес акаунта 0 →
      // Argon2id → AES-256-GCM. Повільно у WASM (особливо dev) — це очікувано.
      const encryptedVault = wasm.createVault(message.mnemonic, message.password, accountName);
      const addresses = JSON.parse(wasm.deriveAddresses(message.mnemonic, 0)) as WasmAddresses;
      const account: PublicAccount = {
        index: 0,
        name: accountName,
        addresses: {
          evm: addresses.evm,
          solana: addresses.solana,
          bitcoin: addresses.bitcoin,
        },
      };
      // Секрети попереднього гаманця (якщо був розблокований) затираються
      // ДО перемикання сесії на новий.
      lockSession();
      // ЗАВЖДИ додається новий запис — наявні гаманці не перезаписуються.
      const record = await addVaultRecord({
        vault: encryptedVault,
        accounts: [account],
        name: message.walletName,
      });
      unlockSession(record, message.mnemonic, [account]);
      return { ok: true, value: account };
    } catch (error) {
      return vaultError(error);
    }
  }

  async function vaultUnlock(message: BgVaultUnlock): Promise<VaultResult<PublicAccount[]>> {
    // Розблоковується АКТИВНИЙ гаманець (перемикання — SwitchWallet).
    const record = await getActiveVaultRecord();
    if (record === null) return { ok: false, error: 'Гаманець не створено.' };
    try {
      const wasm = await loadWalletCoreWasm();
      const data = JSON.parse(wasm.unlockVault(record.vault, message.password)) as WasmVaultData;
      // Публічний список акаунтів (включно з деривованими після створення
      // vault) — із запису у сховищі; fallback: акаунти з розшифрованого vault.
      const accounts: PublicAccount[] =
        record.accounts.length > 0
          ? record.accounts
          : data.accounts.map((a) => ({
              index: a.index,
              name: a.name,
              addresses: { evm: a.evm_address, solana: a.solana_address, bitcoin: a.bitcoin_address },
            }));
      unlockSession(record, data.mnemonic, accounts);
      return { ok: true, value: accounts };
    } catch {
      // WASM-ядро повертає одну помилку і на невірний пароль, і на битий vault.
      return { ok: false, error: 'Невірний пароль.' };
    }
  }

  async function vaultDeriveAccount(
    message: BgVaultDeriveAccount,
  ): Promise<VaultResult<PublicAccount>> {
    const sessionWalletId = session.walletId;
    if (sessionMnemonic === null || sessionWalletId === null) {
      return { ok: false, error: 'Гаманець заблоковано.' };
    }
    try {
      const wasm = await loadWalletCoreWasm();
      const addresses = JSON.parse(
        wasm.deriveAddresses(sessionMnemonic, message.index),
      ) as WasmAddresses;
      const account: PublicAccount = {
        index: message.index,
        name: message.name,
        addresses: { evm: addresses.evm, solana: addresses.solana, bitcoin: addresses.bitcoin },
      };
      const accounts = [...session.accounts.filter((a) => a.index !== account.index), account];
      session = { ...session, accounts };
      await updateVaultAccounts(sessionWalletId, accounts);
      touchAutoLock();
      return { ok: true, value: account };
    } catch (error) {
      return vaultError(error);
    }
  }

  /**
   * «Забув пароль» (RestoreVaultPassword, тільки з popup): пароль не
   * відновлюється за дизайном — натомість seed-фраза (головний ключ)
   * доводить володіння гаманцем і задає НОВИЙ пароль:
   *
   *  1. BIP-39-валідація фрази (без Argon2id — швидко);
   *  2. верифікація належності: deriveAddresses(phrase, 0) звіряється з
   *     ПУБЛІЧНИМИ адресами активного VaultRecord (mnemonicOwnsRecord) —
   *     чужа фраза дає типізовану помилку 'wallet-mismatch' і НІЧОГО не змінює;
   *  3. createVault(фраза, новий пароль) → заміна ЛИШЕ шифротексту в тому
   *     самому записі (id/name/createdAt/accounts зберігаються);
   *  4. розблокування сесії новим станом.
   */
  async function restoreVaultPassword(
    message: BgRestoreVaultPassword,
  ): Promise<RestoreVaultResult> {
    const record = await getActiveVaultRecord();
    if (record === null) {
      return { ok: false, code: 'no-wallet', error: 'Гаманець не створено.' };
    }
    if (message.newPassword.length < 8) {
      return {
        ok: false,
        code: 'weak-password',
        error: 'Пароль має містити щонайменше 8 символів.',
      };
    }
    try {
      const wasm = await loadWalletCoreWasm();
      // Нормалізація як в імпорті: зайві пробіли/регістр не мають ламати фразу.
      const phrase = message.phrase.trim().toLowerCase().split(/\s+/).join(' ');
      if (!wasm.validateMnemonic(phrase)) {
        return {
          ok: false,
          code: 'invalid-phrase',
          error:
            'Невірна seed-фраза: слово поза словником BIP-39 або checksum не збігається.',
        };
      }
      const derived = JSON.parse(wasm.deriveAddresses(phrase, 0)) as WasmAddresses;
      if (!mnemonicOwnsRecord(derived, record)) {
        return {
          ok: false,
          code: 'wallet-mismatch',
          error: 'Ця фраза належить іншому гаманцю. Перевірте слова.',
        };
      }
      const accountName = record.accounts[0]?.name ?? 'Акаунт 1';
      // Новий шифротекст: Argon2id → AES-256-GCM з НОВИМ паролем (повільно — ок).
      const encryptedVault = wasm.createVault(phrase, message.newPassword, accountName);
      // Секрети попередньої сесії (якщо була) затираються ДО заміни.
      lockSession();
      const updated = await replaceVaultCiphertext(record.id, encryptedVault);
      const accounts: PublicAccount[] =
        updated.accounts.length > 0
          ? updated.accounts
          : [
              {
                index: 0,
                name: accountName,
                addresses: {
                  evm: derived.evm,
                  solana: derived.solana,
                  bitcoin: derived.bitcoin,
                },
              },
            ];
      unlockSession(updated, phrase, accounts);
      return { ok: true, value: accounts };
    } catch (error) {
      return { ok: false, code: 'internal', error: toWasmError(error).message };
    }
  }

  // -------------------------------------------------------------------------
  // Мульти-гаманець: список / перемикання / перейменування / видалення.
  // Інваріант безпеки: SwitchWallet і RemoveWallet затирають розшифровані
  // секрети поточної сесії (lockSession) — розблокування іншого гаманця
  // вимагає пароль САМЕ того гаманця.
  // -------------------------------------------------------------------------

  async function walletsState(): Promise<WalletsState> {
    const [vaults, activeId] = await Promise.all([listVaultRecords(), getActiveVaultId()]);
    return {
      wallets: vaults.map((record) => ({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        primaryEvmAddress: record.accounts[0]?.addresses.evm ?? null,
      })),
      activeId,
    };
  }

  async function listWallets(): Promise<VaultResult<WalletsState>> {
    try {
      return { ok: true, value: await walletsState() };
    } catch (error) {
      return vaultError(error);
    }
  }

  async function switchWallet(message: BgSwitchWallet): Promise<VaultResult<WalletsState>> {
    try {
      await setActiveVaultId(message.walletId);
      // Секрети попереднього гаманця затираються — потрібен Unlock паролем
      // нового активного гаманця.
      lockSession();
      return { ok: true, value: await walletsState() };
    } catch (error) {
      return vaultError(error);
    }
  }

  async function renameWallet(message: BgRenameWallet): Promise<VaultResult<WalletsState>> {
    try {
      await renameVaultRecord(message.walletId, message.name);
      if (session.walletId === message.walletId) {
        session = { ...session, walletName: message.name.trim() };
      }
      return { ok: true, value: await walletsState() };
    } catch (error) {
      return vaultError(error);
    }
  }

  async function removeWallet(message: BgRemoveWallet): Promise<VaultResult<WalletsState>> {
    try {
      const wasActive = (await getActiveVaultId()) === message.walletId;
      await removeVaultRecord(message.walletId);
      // Якщо видалено активний (або саме розблокований) гаманець — сесія
      // блокується і секрети затираються. Наступним активним сховище вже
      // зробило перший із решти; якщо гаманців не лишилось — стан «немає
      // гаманця» (онбординг).
      if (wasActive || session.walletId === message.walletId) lockSession();
      return { ok: true, value: await walletsState() };
    } catch (error) {
      return vaultError(error);
    }
  }

  /**
   * Підпис EIP-1559 транзакції ключем активної сесії (реальний keccak256 +
   * RLP + secp256k1 у WASM-ядрі). `txParamsJson` — JSON із рядковими числами
   * (див. Eip1559TxParams). Повертає JSON `{"raw_tx":"0x02…","tx_hash":"0x…"}`.
   */
  async function signEvmTransactionWithSession(
    txParamsJson: string,
    accountIndex: number,
  ): Promise<VaultResult<string>> {
    if (sessionMnemonic === null) return { ok: false, error: 'Гаманець заблоковано.' };
    try {
      const wasm = await loadWalletCoreWasm();
      touchAutoLock();
      return { ok: true, value: wasm.signEvmTransaction(sessionMnemonic, accountIndex, txParamsJson) };
    } catch (error) {
      return vaultError(error);
    }
  }

  /**
   * Підпис повідомлення ключем активної сесії:
   *  - EVM — реальний EIP-191 personal_sign (keccak256 + secp256k1, v ∈ {27,28});
   *  - Solana — ed25519-підпис байтів (base58);
   *  - Bitcoin — TODO (PSBT/BIP-322).
   */
  async function signMessageWithSession(
    chain: Chain,
    message: string,
    accountIndex: number,
  ): Promise<VaultResult<string>> {
    if (sessionMnemonic === null) return { ok: false, error: 'Гаманець заблоковано.' };
    try {
      const wasm = await loadWalletCoreWasm();
      touchAutoLock();
      switch (CHAINS[chain].kind) {
        case 'evm': {
          // dApp передає повідомлення hex-рядком (EIP-1193), UI — plain text.
          const signature = wasm.personalSign(
            sessionMnemonic,
            accountIndex,
            decodePersonalSignMessage(message),
          );
          return { ok: true, value: signature };
        }
        case 'solana': {
          const signature = wasm.signSolanaMessage(
            sessionMnemonic,
            accountIndex,
            new TextEncoder().encode(message),
          );
          return { ok: true, value: signature };
        }
        case 'bitcoin':
          return {
            ok: false,
            error: 'Підпис Bitcoin буде доступний після інтеграції PSBT (BDK).',
          };
      }
    } catch (error) {
      return vaultError(error);
    }
  }

  /** VaultSignTransaction: для EVM payload — JSON параметрів EIP-1559 транзакції. */
  function vaultSignTransaction(m: BgVaultSignTransaction): Promise<VaultResult<string>> {
    switch (CHAINS[m.chain].kind) {
      case 'evm':
        return signEvmTransactionWithSession(m.payload, m.accountIndex);
      case 'solana':
        return signMessageWithSession(m.chain, m.payload, m.accountIndex);
      case 'bitcoin':
        return Promise.resolve({
          ok: false,
          error: 'Підпис Bitcoin-транзакцій буде доступний після інтеграції PSBT (BDK).',
        });
    }
  }
  const vaultSignMessage = (m: BgVaultSignMessage): Promise<VaultResult<string>> =>
    signMessageWithSession(m.chain, m.message, m.accountIndex);

  // -------------------------------------------------------------------------
  // Черга запитів на підпис (F3.5, F5.3).
  // -------------------------------------------------------------------------
  interface PendingEntry {
    request: PendingSignRequest;
    resolve: (outcome: RpcOutcome) => void;
  }
  const pendingRequests = new Map<string, PendingEntry>();

  async function openApprovalPopup(): Promise<void> {
    // Окреме вікно з екраном Approve (ТЗ: екран підпису).
    await browser.windows.create({
      url: `${browser.runtime.getURL('/popup.html')}?view=approve`,
      type: 'popup',
      width: 392,
      height: 660,
    });
  }

  function queueApproval(request: PendingSignRequest): Promise<RpcOutcome> {
    return new Promise<RpcOutcome>((resolve) => {
      pendingRequests.set(request.id, { request, resolve });
      openApprovalPopup().catch((error: unknown) => {
        pendingRequests.delete(request.id);
        console.error('[aiwallet] Не вдалося відкрити вікно підтвердження:', error);
        resolve({ ok: false, error: RPC_ERRORS.internal });
      });
    });
  }

  /** Рядкове поле обʼєкта транзакції від dApp (params[0]). */
  function txField(tx: Record<string, unknown>, key: string): string | undefined {
    const value = tx[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /**
   * Повний цикл eth_sendTransaction від dApp (після схвалення користувачем):
   * GET /v1/tx/params (nonce + EIP-1559 комісії з реальної ноди) → збірка
   * type-2 транзакції → keccak256 + secp256k1-підпис у WASM → RLP →
   * POST /v1/tx/broadcast → СПРАВЖНІЙ tx hash від ноди.
   */
  async function sendDappTransaction(request: PendingSignRequest): Promise<RpcOutcome> {
    if (session.address === null) return { ok: false, error: RPC_ERRORS.unauthorized };
    const rawTx = request.params[0];
    if (typeof rawTx !== 'object' || rawTx === null || Array.isArray(rawTx)) {
      return { ok: false, error: { code: -32602, message: 'Некоректні параметри транзакції.' } };
    }
    const tx = rawTx as Record<string, unknown>;
    const data = txField(tx, 'data') ?? txField(tx, 'input');
    const hasData = data !== undefined && data !== '0x';

    try {
      const params = await fetchTxParams(DAPP_CHAIN, session.address, hasData);
      const txParams: Eip1559TxParams = {
        chain_id: String(params.chain_id),
        nonce: String(params.nonce),
        // Тариф standard; вибір slow/fast користувачем — TODO (екран Approve).
        max_priority_fee_per_gas: params.fees.standard.max_priority_fee_per_gas,
        max_fee_per_gas: params.fees.standard.max_fee_per_gas,
        // gas від dApp (hex) або консервативна оцінка бекенду.
        gas_limit: txField(tx, 'gas') ?? params.gas_limit_estimate,
        to: txField(tx, 'to'),
        value: txField(tx, 'value') ?? '0',
        data,
      };
      const signed = await signEvmTransactionWithSession(JSON.stringify(txParams), 0);
      if (!signed.ok) return { ok: false, error: { code: -32603, message: signed.error } };
      const { raw_tx } = JSON.parse(signed.value) as SignedEvmTx;
      const { tx_hash } = await broadcastTx({ chain: DAPP_CHAIN, signed_tx: raw_tx });
      return { ok: true, result: tx_hash };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Внутрішня помилка.';
      return { ok: false, error: { code: -32603, message } };
    }
  }

  /**
   * Результат для схваленого користувачем запиту. Підпис — реальний
   * (keccak256/EIP-191/EIP-1559 у WASM-ядрі), трансляція — через бекенд.
   */
  async function approvedOutcome(request: PendingSignRequest): Promise<RpcOutcome> {
    if (!session.unlocked) return { ok: false, error: RPC_ERRORS.unauthorized };
    switch (request.method) {
      case 'eth_requestAccounts':
        return { ok: true, result: session.address !== null ? [session.address] : [] };
      case 'eth_sendTransaction':
        return sendDappTransaction(request);
      case 'personal_sign': {
        // params: [message, address] (EIP-1193); message — hex або plain text.
        const message = typeof request.params[0] === 'string' ? request.params[0] : '';
        const signed = await signMessageWithSession(DAPP_CHAIN, message, 0);
        return signed.ok
          ? { ok: true, result: signed.value }
          : { ok: false, error: { code: -32603, message: signed.error } };
      }
      case 'eth_accounts':
      case 'eth_chainId':
        return { ok: false, error: RPC_ERRORS.internal };
    }
  }

  // -------------------------------------------------------------------------
  // Обробка RPC-запитів від dApp (через content script).
  // -------------------------------------------------------------------------
  async function handleRpcRequest(message: BgRpcRequest): Promise<RpcOutcome> {
    touchAutoLock();
    const { method, params } = message.payload;

    switch (method) {
      case 'eth_chainId':
        return { ok: true, result: DAPP_CHAIN_ID_HEX };

      case 'eth_accounts': {
        const accounts: Json = session.unlocked && session.address !== null ? [session.address] : [];
        return { ok: true, result: accounts };
      }

      case 'eth_requestAccounts':
      case 'eth_sendTransaction':
      case 'personal_sign': {
        const request: PendingSignRequest = {
          id: crypto.randomUUID(),
          origin: message.origin,
          method,
          params,
          createdAt: Date.now(),
        };
        return queueApproval(request);
      }
    }
  }

  async function resolveApproval(message: BgResolveApproval): Promise<{ ok: boolean }> {
    const entry = pendingRequests.get(message.requestId);
    if (entry === undefined) return { ok: false };
    pendingRequests.delete(message.requestId);
    entry.resolve(
      message.approved
        ? await approvedOutcome(entry.request)
        : { ok: false, error: RPC_ERRORS.userRejected },
    );
    return { ok: true };
  }

  async function handleMessage(message: BackgroundMessage): Promise<unknown> {
    switch (message.type) {
      case MessageType.RpcRequest:
        return handleRpcRequest(message);
      case MessageType.GetSessionState:
        return session;
      case MessageType.LockSession:
        lockSession();
        return session;
      case MessageType.GetPendingRequests:
        return [...pendingRequests.values()]
          .map((entry) => entry.request)
          .sort((a, b) => a.createdAt - b.createdAt);
      case MessageType.ResolveApproval:
        return resolveApproval(message);
      case MessageType.VaultCreate:
        return vaultCreate(message);
      case MessageType.VaultUnlock:
        return vaultUnlock(message);
      case MessageType.VaultDeriveAccount:
        return vaultDeriveAccount(message);
      case MessageType.VaultSignTransaction:
        return vaultSignTransaction(message);
      case MessageType.VaultSignMessage:
        return vaultSignMessage(message);
      case MessageType.ListWallets:
        return listWallets();
      case MessageType.SwitchWallet:
        return switchWallet(message);
      case MessageType.RenameWallet:
        return renameWallet(message);
      case MessageType.RemoveWallet:
        return removeWallet(message);
      case MessageType.RestoreVaultPassword:
        return restoreVaultPassword(message);
    }
  }

  /** Vault-операції приймаємо лише зі сторінок розширення (popup), не з content script. */
  function isTrustedSender(sender: { url?: string }): boolean {
    return sender.url?.startsWith(browser.runtime.getURL('/')) ?? false;
  }

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse: (response: unknown) => void) => {
      if (!isBackgroundMessage(message)) return;
      if (PRIVILEGED_MESSAGE_TYPES.has(message.type) && !isTrustedSender(sender)) {
        console.warn('[aiwallet] Відхилено привілейоване повідомлення від:', sender.url);
        sendResponse({ ok: false, error: 'Недостатньо прав.' });
        return;
      }
      handleMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          console.error('[aiwallet] Помилка обробки повідомлення:', error);
          sendResponse({ ok: false, error: RPC_ERRORS.internal } satisfies RpcOutcome);
        });
      return true; // асинхронна відповідь
    },
  );

  console.log('[aiwallet] background service worker запущено');
});
