/**
 * Типізований протокол повідомлень між шарами розширення (ТЗ §6 п.4):
 *
 *   injected (контекст сторінки) ⇄ content script  — через window.postMessage
 *   content script / popup ⇄ background            — через browser.runtime.sendMessage
 *
 * Файл НЕ імпортує API розширення — він бандлиться і в injected-скрипт,
 * який виконується в контексті сторінки без доступу до chrome.*.
 */
import type { Chain } from './chains';

/** Публічне представлення акаунта — тільки адреси, жодних ключів. */
export interface PublicAccount {
  index: number;
  name: string;
  addresses: {
    evm: string;
    solana: string;
    bitcoin: string;
    /** Порожній рядок у записах, створених до появи TRON, — background
     *  доозначує адресу при першому розблокуванні (міграція). */
    tron: string;
  };
}

/** JSON-сумісне значення. Публічні інтерфейси не використовують `any`. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** Усі типи повідомлень протоколу. */
export enum MessageType {
  /** Запит EIP-1193 від dApp (page → content → background). */
  RpcRequest = 'aiwallet/rpc-request',
  /** Відповідь на RPC-запит (background → content → page). */
  RpcResponse = 'aiwallet/rpc-response',
  /** Подія провайдера accountsChanged/chainChanged/... (background → page). */
  ProviderEvent = 'aiwallet/provider-event',
  /** Popup: отримати стан сесії. */
  GetSessionState = 'aiwallet/get-session-state',
  /** Popup: заблокувати сесію (zeroize seed-фрази в пам'яті background). */
  LockSession = 'aiwallet/lock-session',
  /** Popup → background: створити vault із seed-фрази й пароля (WASM-ядро). */
  VaultCreate = 'aiwallet/vault-create',
  /** Popup → background: розблокувати vault паролем (Argon2id + AES-GCM). */
  VaultUnlock = 'aiwallet/vault-unlock',
  /** Popup → background: деривувати наступний акаунт (потрібна розблокована сесія). */
  VaultDeriveAccount = 'aiwallet/vault-derive-account',
  /** Popup → background: підписати транзакцію ключем із сесії. */
  VaultSignTransaction = 'aiwallet/vault-sign-transaction',
  /** Popup → background: підписати повідомлення ключем із сесії. */
  VaultSignMessage = 'aiwallet/vault-sign-message',
  /** Popup: отримати чергу запитів на підпис. */
  GetPendingRequests = 'aiwallet/get-pending-requests',
  /** Popup: рішення користувача щодо запиту на підпис (F5.3). */
  ResolveApproval = 'aiwallet/resolve-approval',
  /** Popup → background: список гаманців (публічні метадані) + активний id. */
  ListWallets = 'aiwallet/list-wallets',
  /** Popup → background: зробити активним інший гаманець (сесія блокується). */
  SwitchWallet = 'aiwallet/switch-wallet',
  /** Popup → background: перейменувати гаманець. */
  RenameWallet = 'aiwallet/rename-wallet',
  /** Popup → background: видалити гаманець (шифротекст зникає назавжди). */
  RemoveWallet = 'aiwallet/remove-wallet',
  /**
   * Popup → background: «забув пароль» — відновити доступ до АКТИВНОГО
   * гаманця його seed-фразою: верифікація належності фрази (деривація адрес
   * і порівняння з публічними accounts запису) → новий шифротекст із новим
   * паролем у ТОМУ САМОМУ VaultRecord (id/name/accounts зберігаються) →
   * розблокування сесії.
   */
  RestoreVaultPassword = 'aiwallet/restore-vault-password',
  /** Popup → background: показати seed-фразу (пароль перевіряється заново). */
  RevealSeedPhrase = 'aiwallet/reveal-seed-phrase',
  /** Popup → background: список підключених сайтів (дозволи по origin). */
  ListConnectedSites = 'aiwallet/list-connected-sites',
  /** Popup → background: відключити (ревокувати) один origin. */
  DisconnectSite = 'aiwallet/disconnect-site',
  /** Popup → background: відключити всі origin. */
  DisconnectAllSites = 'aiwallet/disconnect-all-sites',
}

// --- Мульти-гаманець: публічні метадані для UI --------------------------------

/** Публічний підсумок гаманця для списків UI (жодних секретів). */
export interface WalletSummary {
  id: string;
  name: string;
  createdAt: number;
  /** EVM-адреса першого акаунта — для скороченого підпису в списку. */
  primaryEvmAddress: string | null;
}

/** Список гаманців + активний id (відповідь List/Switch/Rename/Remove). */
export interface WalletsState {
  wallets: WalletSummary[];
  activeId: string | null;
}

// --- Дозволи по origin: підключені сайти --------------------------------------

/**
 * Сайт, якому користувач явно дозволив доступ до адреси (через Approve на
 * eth_requestAccounts). Тільки публічні дані. Сховище і правила — у
 * src/lib/connections.ts; тип живе тут, бо це частина протоколу popup ⇄ background.
 */
export interface ConnectedSite {
  /** Нормалізований origin: `https://app.uniswap.org`. */
  origin: string;
  /** Unix ms першого підключення. */
  connectedAt: number;
  /** Id гаманця, яким сайт підключено востаннє (null — невідомо). */
  walletId: string | null;
  /** EVM-адреса, яку востаннє віддали цьому сайту (null — невідомо). */
  accountAddress: string | null;
}

/** Підтримувані методи EIP-1193 (MVP-мінімум, ТЗ F3.5). */
export type Eip1193Method =
  | 'eth_requestAccounts'
  | 'eth_accounts'
  | 'eth_chainId'
  | 'eth_sendTransaction'
  | 'personal_sign';

export const SUPPORTED_ETH_METHODS: readonly Eip1193Method[] = [
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'eth_sendTransaction',
  'personal_sign',
];

export function isSupportedEthMethod(method: string): method is Eip1193Method {
  return (SUPPORTED_ETH_METHODS as readonly string[]).includes(method);
}

export interface RpcRequestPayload {
  method: Eip1193Method;
  params: readonly Json[];
}

/** Помилка у форматі EIP-1193 ProviderRpcError. */
export interface RpcError {
  code: number;
  message: string;
}

/**
 * Стандартні коди помилок EIP-1193. Повідомлення — англійською: це
 * dApp-facing API (їх читають розробники сайтів, не користувач гаманця).
 */
export const RPC_ERRORS = {
  userRejected: { code: 4001, message: 'User rejected the request.' },
  unauthorized: { code: 4100, message: 'Unauthorized.' },
  unsupportedMethod: { code: 4200, message: 'Method not supported.' },
  disconnected: { code: 4900, message: 'Provider is disconnected.' },
  internal: { code: -32603, message: 'Internal error.' },
} as const satisfies Record<string, RpcError>;

/** Результат RPC-запиту: discriminated union успіх/помилка. */
export type RpcOutcome =
  | { ok: true; result: Json }
  | { ok: false; error: RpcError };

export type ProviderEventName =
  | 'connect'
  | 'disconnect'
  | 'accountsChanged'
  | 'chainChanged';

// ---------------------------------------------------------------------------
// page ⇄ content (window.postMessage). Кожне повідомлення має target,
// щоб не перетинатися з повідомленнями самої сторінки; origin перевіряється
// обома сторонами (event.source === window).
// ---------------------------------------------------------------------------

export const CONTENT_TARGET = 'aiwallet:content' as const;
export const PAGE_TARGET = 'aiwallet:page' as const;

export interface PageRpcRequest {
  target: typeof CONTENT_TARGET;
  type: MessageType.RpcRequest;
  id: string;
  payload: RpcRequestPayload;
}

export interface PageRpcResponse {
  target: typeof PAGE_TARGET;
  type: MessageType.RpcResponse;
  id: string;
  outcome: RpcOutcome;
}

export interface PageProviderEvent {
  target: typeof PAGE_TARGET;
  type: MessageType.ProviderEvent;
  event: ProviderEventName;
  data: Json;
}

export type PageMessage = PageRpcRequest | PageRpcResponse | PageProviderEvent;

export function isPageRpcRequest(value: unknown): value is PageRpcRequest {
  return (
    isRecord(value) &&
    value['target'] === CONTENT_TARGET &&
    value['type'] === MessageType.RpcRequest &&
    typeof value['id'] === 'string' &&
    isRecord(value['payload']) &&
    typeof (value['payload'] as Record<string, unknown>)['method'] === 'string'
  );
}

export function isPageRpcResponse(value: unknown): value is PageRpcResponse {
  return (
    isRecord(value) &&
    value['target'] === PAGE_TARGET &&
    value['type'] === MessageType.RpcResponse &&
    typeof value['id'] === 'string'
  );
}

export function isPageProviderEvent(value: unknown): value is PageProviderEvent {
  return (
    isRecord(value) &&
    value['target'] === PAGE_TARGET &&
    value['type'] === MessageType.ProviderEvent
  );
}

// ---------------------------------------------------------------------------
// content / popup → background (browser.runtime.sendMessage)
// ---------------------------------------------------------------------------

export interface BgRpcRequest {
  type: MessageType.RpcRequest;
  id: string;
  /** Origin dApp-сторінки — потрібен для ризик-аналізу (POST /v1/tx/risk). */
  origin: string;
  payload: RpcRequestPayload;
}

export interface BgGetSessionState {
  type: MessageType.GetSessionState;
}

export interface BgLockSession {
  type: MessageType.LockSession;
}

// --- Vault-операції (popup → background; виконуються WASM-ядром у SW) ------

export interface BgVaultCreate {
  type: MessageType.VaultCreate;
  /** Seed-фраза (пробіл-розділена). Живе лише в пам'яті popup/SW, не в storage. */
  mnemonic: string;
  password: string;
  accountName: string;
  /**
   * Назва гаманця; порожньо → «Гаманець N». Створення ЗАВЖДИ додає новий
   * запис у `aiwallet:vaults` (наявні гаманці не перезаписуються) і робить
   * його активним.
   */
  walletName?: string;
}

export interface BgVaultUnlock {
  type: MessageType.VaultUnlock;
  password: string;
}

export interface BgVaultDeriveAccount {
  type: MessageType.VaultDeriveAccount;
  index: number;
  name: string;
}

export interface BgVaultSignTransaction {
  type: MessageType.VaultSignTransaction;
  chain: Chain;
  /** Серіалізований запит транзакції (EVM tx request / Solana message / BTC PSBT). */
  payload: string;
  accountIndex: number;
}

export interface BgVaultSignMessage {
  type: MessageType.VaultSignMessage;
  chain: Chain;
  message: string;
  accountIndex: number;
}

/** Результат vault-операції: успіх або текст помилки для UI. */
export type VaultResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// --- Відновлення пароля seed-фразою («забув пароль») ------------------------

export interface BgRestoreVaultPassword {
  type: MessageType.RestoreVaultPassword;
  /** Seed-фраза (пробіл-розділена). Живе лише в пам'яті popup/SW, не в storage. */
  phrase: string;
  newPassword: string;
}

/** Типізовані причини відмови відновлення — UI розрізняє їх по-різному. */
export type RestoreErrorCode =
  /** Фраза не проходить BIP-39 (слово поза словником / checksum). */
  | 'invalid-phrase'
  /** Фраза валідна, але деривовані адреси не збігаються з цим гаманцем. */
  | 'wallet-mismatch'
  /** Активного гаманця немає (сховище порожнє). */
  | 'no-wallet'
  /** Новий пароль не проходить правила (мінімум 8 символів). */
  | 'weak-password'
  /** Інша помилка (WASM/storage). */
  | 'internal';

/** Результат RestoreVaultPassword: успіх (акаунти розблокованої сесії) або типізована помилка. */
export type RestoreVaultResult =
  | { ok: true; value: PublicAccount[] }
  | { ok: false; code: RestoreErrorCode; error: string };

export interface BgGetPendingRequests {
  type: MessageType.GetPendingRequests;
}

export interface BgResolveApproval {
  type: MessageType.ResolveApproval;
  requestId: string;
  approved: boolean;
}

// --- Мульти-гаманець (popup → background) ----------------------------------

export interface BgListWallets {
  type: MessageType.ListWallets;
}

export interface BgSwitchWallet {
  type: MessageType.SwitchWallet;
  walletId: string;
}

export interface BgRenameWallet {
  type: MessageType.RenameWallet;
  walletId: string;
  name: string;
}

export interface BgRemoveWallet {
  type: MessageType.RemoveWallet;
  walletId: string;
}

/**
 * Показ seed-фрази активного гаманця. Пароль перевіряється ЗАВЖДИ заново
 * (Argon2id-розшифрування vault) — розблокованої сесії недостатньо.
 */
export interface BgRevealSeedPhrase {
  type: MessageType.RevealSeedPhrase;
  password: string;
}

// --- Підключені сайти (дозволи по origin; popup → background) ---------------

export interface BgListConnectedSites {
  type: MessageType.ListConnectedSites;
}

export interface BgDisconnectSite {
  type: MessageType.DisconnectSite;
  origin: string;
}

export interface BgDisconnectAllSites {
  type: MessageType.DisconnectAllSites;
}

export type BackgroundMessage =
  | BgRpcRequest
  | BgGetSessionState
  | BgLockSession
  | BgGetPendingRequests
  | BgResolveApproval
  | BgVaultCreate
  | BgVaultUnlock
  | BgVaultDeriveAccount
  | BgVaultSignTransaction
  | BgVaultSignMessage
  | BgListWallets
  | BgSwitchWallet
  | BgRenameWallet
  | BgRemoveWallet
  | BgRestoreVaultPassword
  | BgRevealSeedPhrase
  | BgListConnectedSites
  | BgDisconnectSite
  | BgDisconnectAllSites;

/** Стан сесії у service worker. */
export interface SessionState {
  unlocked: boolean;
  address: string | null;
  /** Unix ms, коли спрацює автолок; null — заблоковано. */
  autoLockAt: number | null;
  /** Публічні акаунти розблокованої сесії (порожньо, коли заблоковано). */
  accounts: PublicAccount[];
  /** Id гаманця розблокованої сесії; null — заблоковано. */
  walletId: string | null;
  /** Назва гаманця розблокованої сесії; null — заблоковано. */
  walletName: string | null;
}

/** Запит на підпис у черзі background (показується на екрані Approve). */
export interface PendingSignRequest {
  id: string;
  origin: string;
  method: Eip1193Method;
  params: readonly Json[];
  createdAt: number;
}

/** Мапа «тип повідомлення → тип відповіді» для типобезпечного sendMessage. */
export interface BackgroundResponseMap {
  [MessageType.RpcRequest]: RpcOutcome;
  [MessageType.GetSessionState]: SessionState;
  [MessageType.LockSession]: SessionState;
  [MessageType.GetPendingRequests]: PendingSignRequest[];
  [MessageType.ResolveApproval]: { ok: boolean };
  [MessageType.VaultCreate]: VaultResult<PublicAccount>;
  [MessageType.VaultUnlock]: VaultResult<PublicAccount[]>;
  [MessageType.VaultDeriveAccount]: VaultResult<PublicAccount>;
  [MessageType.VaultSignTransaction]: VaultResult<string>;
  [MessageType.VaultSignMessage]: VaultResult<string>;
  [MessageType.ListWallets]: VaultResult<WalletsState>;
  [MessageType.SwitchWallet]: VaultResult<WalletsState>;
  [MessageType.RenameWallet]: VaultResult<WalletsState>;
  [MessageType.RemoveWallet]: VaultResult<WalletsState>;
  [MessageType.RestoreVaultPassword]: RestoreVaultResult;
  [MessageType.RevealSeedPhrase]: VaultResult<string>;
  [MessageType.ListConnectedSites]: VaultResult<ConnectedSite[]>;
  [MessageType.DisconnectSite]: VaultResult<ConnectedSite[]>;
  [MessageType.DisconnectAllSites]: VaultResult<ConnectedSite[]>;
}

const BACKGROUND_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  MessageType.RpcRequest,
  MessageType.GetSessionState,
  MessageType.LockSession,
  MessageType.GetPendingRequests,
  MessageType.ResolveApproval,
  MessageType.VaultCreate,
  MessageType.VaultUnlock,
  MessageType.VaultDeriveAccount,
  MessageType.VaultSignTransaction,
  MessageType.VaultSignMessage,
  MessageType.ListWallets,
  MessageType.SwitchWallet,
  MessageType.RenameWallet,
  MessageType.RemoveWallet,
  MessageType.RestoreVaultPassword,
  MessageType.RevealSeedPhrase,
  MessageType.ListConnectedSites,
  MessageType.DisconnectSite,
  MessageType.DisconnectAllSites,
]);

/**
 * Типи повідомлень, що дозволені ЛИШЕ зі сторінок розширення (popup),
 * а не з content script — background перевіряє sender.url (isTrustedSender).
 *
 * Правило: тут має бути ВСЕ, крім RpcRequest — єдиного типу, який містить
 * dApp-контент і навмисно приходить із content script. Зокрема:
 *  - GetSessionState віддає адресу/акаунти/стан локу (не дає це витягти
 *    в обхід моделі дозволів по origin);
 *  - GetPendingRequests віддає чергу запитів на підпис (origin + params
 *    інших dApp);
 *  - Disconnect* — ревокація дозволів, яку сайт не має права робити за
 *    користувача.
 */
export const PRIVILEGED_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  MessageType.GetSessionState,
  MessageType.GetPendingRequests,
  MessageType.LockSession,
  MessageType.ResolveApproval,
  MessageType.VaultCreate,
  MessageType.VaultUnlock,
  MessageType.VaultDeriveAccount,
  MessageType.VaultSignTransaction,
  MessageType.VaultSignMessage,
  MessageType.ListWallets,
  MessageType.SwitchWallet,
  MessageType.RenameWallet,
  MessageType.RemoveWallet,
  MessageType.RestoreVaultPassword,
  MessageType.RevealSeedPhrase,
  MessageType.ListConnectedSites,
  MessageType.DisconnectSite,
  MessageType.DisconnectAllSites,
]);

export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  return (
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    BACKGROUND_MESSAGE_TYPES.has(value['type'])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
