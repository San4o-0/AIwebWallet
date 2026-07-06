/**
 * Типізований протокол повідомлень між шарами розширення (ТЗ §6 п.4):
 *
 *   injected (контекст сторінки) ⇄ content script  — через window.postMessage
 *   content script / popup ⇄ background            — через browser.runtime.sendMessage
 *
 * Файл НЕ імпортує API розширення — він бандлиться і в injected-скрипт,
 * який виконується в контексті сторінки без доступу до chrome.*.
 */

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
  /** Popup: позначити сесію розблокованою (після unlock у WASM-ядрі). */
  UnlockSession = 'aiwallet/unlock-session',
  /** Popup: заблокувати сесію. */
  LockSession = 'aiwallet/lock-session',
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

export interface BgUnlockSession {
  type: MessageType.UnlockSession;
  /** Активна EVM-адреса, яку background віддає dApps через eth_accounts. */
  address: string;
}

export interface BgLockSession {
  type: MessageType.LockSession;
}

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
  | BgUnlockSession
  | BgLockSession
  | BgGetPendingRequests
  | BgResolveApproval;

/** Стан сесії у service worker. */
export interface SessionState {
  unlocked: boolean;
  address: string | null;
  /** Unix ms, коли спрацює автолок; null — заблоковано. */
  autoLockAt: number | null;
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
  [MessageType.UnlockSession]: SessionState;
  [MessageType.LockSession]: SessionState;
  [MessageType.GetPendingRequests]: PendingSignRequest[];
  [MessageType.ResolveApproval]: { ok: boolean };
}

const BACKGROUND_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  MessageType.RpcRequest,
  MessageType.GetSessionState,
  MessageType.UnlockSession,
  MessageType.LockSession,
  MessageType.GetPendingRequests,
  MessageType.ResolveApproval,
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
