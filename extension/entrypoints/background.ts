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

import { CHAINS, type Chain } from '@/src/lib/chains';
import {
  MessageType,
  PRIVILEGED_MESSAGE_TYPES,
  RPC_ERRORS,
  isBackgroundMessage,
  type BackgroundMessage,
  type BgResolveApproval,
  type BgRpcRequest,
  type BgVaultCreate,
  type BgVaultDeriveAccount,
  type BgVaultSignMessage,
  type BgVaultSignTransaction,
  type BgVaultUnlock,
  type Json,
  type PendingSignRequest,
  type PublicAccount,
  type RpcOutcome,
  type SessionState,
  type VaultResult,
} from '@/src/lib/messaging';
import {
  readEncryptedVault,
  readPublicAccounts,
  writeEncryptedVault,
  writePublicAccounts,
} from '@/src/lib/vault-storage';
import { loadWalletCoreWasm, toWasmError } from '@/src/wasm';

const MOCK_CHAIN_ID_HEX = '0x1'; // Ethereum mainnet (мок; буде перемикання мереж)
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
  let session: SessionState = { unlocked: false, address: null, autoLockAt: null, accounts: [] };
  let sessionMnemonic: string | null = null;
  let autoLockTimer: ReturnType<typeof setTimeout> | undefined;

  function lockSession(): void {
    session = { unlocked: false, address: null, autoLockAt: null, accounts: [] };
    // JS не дає гарантованого zeroize рядків; всередині WASM-ядра секрети
    // затираються (Zeroizing), тут — прибираємо посилання.
    sessionMnemonic = null;
    if (autoLockTimer !== undefined) clearTimeout(autoLockTimer);
    autoLockTimer = undefined;
  }

  function touchAutoLock(): void {
    if (!session.unlocked) return;
    if (autoLockTimer !== undefined) clearTimeout(autoLockTimer);
    session.autoLockAt = Date.now() + AUTO_LOCK_MS;
    autoLockTimer = setTimeout(lockSession, AUTO_LOCK_MS);
  }

  function unlockSession(mnemonic: string, accounts: PublicAccount[]): void {
    sessionMnemonic = mnemonic;
    session = {
      unlocked: true,
      address: accounts[0]?.addresses.evm ?? null,
      autoLockAt: Date.now() + AUTO_LOCK_MS,
      accounts,
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
      await writeEncryptedVault(encryptedVault);
      await writePublicAccounts([account]);
      unlockSession(message.mnemonic, [account]);
      return { ok: true, value: account };
    } catch (error) {
      return vaultError(error);
    }
  }

  async function vaultUnlock(message: BgVaultUnlock): Promise<VaultResult<PublicAccount[]>> {
    const encryptedVault = await readEncryptedVault();
    if (encryptedVault === null) return { ok: false, error: 'Гаманець не створено.' };
    try {
      const wasm = await loadWalletCoreWasm();
      const data = JSON.parse(wasm.unlockVault(encryptedVault, message.password)) as WasmVaultData;
      // Публічний список акаунтів (включно з деривованими після створення
      // vault) — з storage; fallback: акаунти з розшифрованого vault.
      const stored = await readPublicAccounts();
      const accounts: PublicAccount[] =
        stored.length > 0
          ? stored
          : data.accounts.map((a) => ({
              index: a.index,
              name: a.name,
              addresses: { evm: a.evm_address, solana: a.solana_address, bitcoin: a.bitcoin_address },
            }));
      unlockSession(data.mnemonic, accounts);
      return { ok: true, value: accounts };
    } catch {
      // WASM-ядро повертає одну помилку і на невірний пароль, і на битий vault.
      return { ok: false, error: 'Невірний пароль.' };
    }
  }

  async function vaultDeriveAccount(
    message: BgVaultDeriveAccount,
  ): Promise<VaultResult<PublicAccount>> {
    if (sessionMnemonic === null) return { ok: false, error: 'Гаманець заблоковано.' };
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
      await writePublicAccounts(accounts);
      touchAutoLock();
      return { ok: true, value: account };
    } catch (error) {
      return vaultError(error);
    }
  }

  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Підпис довільного payload ключем активної сесії.
   *
   * РЕАЛЬНО: деривація ключа + підпис (secp256k1/ed25519) у WASM-ядрі.
   * ЗАМОКАНО (MVP): для EVM підписується SHA-256-дайджест payload замість
   * канонічного keccak256(EIP-191/RLP) — збірка EVM-транзакцій і keccak у JS
   * прийдуть разом із chain-adapters. Bitcoin PSBT-підпис — TODO (ядро поки
   * експортує xprv/WIF для BDK).
   */
  async function signWithSession(
    chain: Chain,
    payload: string,
    accountIndex: number,
  ): Promise<VaultResult<string>> {
    if (sessionMnemonic === null) return { ok: false, error: 'Гаманець заблоковано.' };
    try {
      const wasm = await loadWalletCoreWasm();
      touchAutoLock();
      switch (CHAINS[chain].kind) {
        case 'evm': {
          // TODO: keccak256 (EIP-191 / RLP tx hash) замість SHA-256-плейсхолдера.
          const digest = await sha256Hex(payload);
          const signature = wasm.signEvmHash(sessionMnemonic, accountIndex, digest);
          return { ok: true, value: `0x${signature}` };
        }
        case 'solana': {
          // Реальний ed25519-підпис байтів повідомлення, base58.
          const signature = wasm.signSolanaMessage(
            sessionMnemonic,
            accountIndex,
            new TextEncoder().encode(payload),
          );
          return { ok: true, value: signature };
        }
        case 'bitcoin':
          return {
            ok: false,
            error: 'Підпис Bitcoin-транзакцій буде доступний після інтеграції PSBT (BDK).',
          };
      }
    } catch (error) {
      return vaultError(error);
    }
  }

  const vaultSignTransaction = (m: BgVaultSignTransaction): Promise<VaultResult<string>> =>
    signWithSession(m.chain, m.payload, m.accountIndex);
  const vaultSignMessage = (m: BgVaultSignMessage): Promise<VaultResult<string>> =>
    signWithSession(m.chain, m.message, m.accountIndex);

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

  /**
   * Результат для схваленого користувачем запиту.
   * Підпис іде через WASM-ядро (реальний secp256k1); для eth_sendTransaction
   * повертається мок tx-хеш (без RLP-збірки та броадкасту — це chain-adapters).
   */
  async function approvedOutcome(request: PendingSignRequest): Promise<RpcOutcome> {
    if (!session.unlocked) return { ok: false, error: RPC_ERRORS.unauthorized };
    switch (request.method) {
      case 'eth_requestAccounts':
        return { ok: true, result: session.address !== null ? [session.address] : [] };
      case 'eth_sendTransaction': {
        // РЕАЛЬНО підписуємо дайджест запиту ключем m/44'/60'/0'/0/0 у WASM,
        // але транзакція не збирається і не броадкаститься (мок tx-хешу).
        const signed = await signWithSession('ethereum', JSON.stringify(request.params), 0);
        if (!signed.ok) return { ok: false, error: RPC_ERRORS.internal };
        return { ok: true, result: `0x${await sha256Hex(signed.value)}` };
      }
      case 'personal_sign': {
        const message = typeof request.params[0] === 'string' ? request.params[0] : '';
        const signed = await signWithSession('ethereum', message, 0);
        return signed.ok
          ? { ok: true, result: signed.value }
          : { ok: false, error: RPC_ERRORS.internal };
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
        return { ok: true, result: MOCK_CHAIN_ID_HEX };

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
