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

/** Стандартні коди помилок EIP-1193. */
export const RPC_ERRORS = {
  userRejected: { code: 4001, message: 'Користувач відхилив запит.' },
  unauthorized: { code: 4100, message: 'Не авторизовано.' },
  unsupportedMethod: { code: 4200, message: 'Метод не підтримується.' },
  disconnected: { code: 4900, message: "Провайдер від'єднано." },
  internal: { code: -32603, message: 'Внутрішня помилка.' },
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

export interface BgGetPendingRequests {
  type: MessageType.GetPendingRequests;
}

export interface BgResolveApproval {
  type: MessageType.ResolveApproval;
  requestId: string;
  approved: boolean;
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
  | BgVaultSignMessage;

/** Стан сесії у service worker. */
export interface SessionState {
  unlocked: boolean;
  address: string | null;
  /** Unix ms, коли спрацює автолок; null — заблоковано. */
  autoLockAt: number | null;
  /** Публічні акаунти розблокованої сесії (порожньо, коли заблоковано). */
  accounts: PublicAccount[];
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
]);

/**
 * Типи повідомлень, що дозволені ЛИШЕ зі сторінок розширення (popup),
 * а не з content script — background перевіряє sender.url.
 */
export const PRIVILEGED_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  MessageType.LockSession,
  MessageType.ResolveApproval,
  MessageType.VaultCreate,
  MessageType.VaultUnlock,
  MessageType.VaultDeriveAccount,
  MessageType.VaultSignTransaction,
  MessageType.VaultSignMessage,
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
