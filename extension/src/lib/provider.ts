/**
 * EIP-1193 провайдер, що виконується в контексті сторінки (injected script).
 * Форвардить запити через window.postMessage → content script → background.
 * НЕ імпортує API розширення — chrome.* тут недоступний.
 */
import {
  CONTENT_TARGET,
  MessageType,
  RPC_ERRORS,
  isPageProviderEvent,
  isPageRpcResponse,
  isSupportedEthMethod,
  type Json,
  type PageRpcRequest,
  type ProviderEventName,
  type RpcError,
} from './messaging';

export interface RequestArguments {
  method: string;
  params?: readonly Json[];
}

export type ProviderListener = (payload: Json) => void;

/** Помилка провайдера у форматі EIP-1193. */
export class ProviderRpcError extends Error {
  readonly code: number;

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'ProviderRpcError';
    this.code = error.code;
  }
}

interface PendingCall {
  resolve: (value: Json) => void;
  reject: (reason: ProviderRpcError) => void;
}

export class AiWalletProvider {
  /** Маркер нашого провайдера (аналог isMetaMask). */
  readonly isAiWallet = true as const;

  #pending = new Map<string, PendingCall>();
  #listeners = new Map<ProviderEventName, Set<ProviderListener>>();

  constructor() {
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.source !== window) return;
      const data = event.data;

      if (isPageRpcResponse(data)) {
        const call = this.#pending.get(data.id);
        if (call === undefined) return;
        this.#pending.delete(data.id);
        if (data.outcome.ok) {
          call.resolve(data.outcome.result);
        } else {
          call.reject(new ProviderRpcError(data.outcome.error));
        }
        return;
      }

      if (isPageProviderEvent(data)) {
        this.#emit(data.event, data.data);
      }
    });
  }

  request(args: RequestArguments): Promise<Json> {
    const { method, params } = args;
    if (!isSupportedEthMethod(method)) {
      return Promise.reject(
        new ProviderRpcError({
          ...RPC_ERRORS.unsupportedMethod,
          message: `Method ${method} is not supported yet (mock).`,
        }),
      );
    }
    const id = crypto.randomUUID();
    const message: PageRpcRequest = {
      target: CONTENT_TARGET,
      type: MessageType.RpcRequest,
      id,
      payload: { method, params: params ?? [] },
    };
    return new Promise<Json>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      window.postMessage(message, window.location.origin);
    });
  }

  on(event: ProviderEventName, listener: ProviderListener): this {
    const set = this.#listeners.get(event) ?? new Set<ProviderListener>();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  removeListener(event: ProviderEventName, listener: ProviderListener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  #emit(event: ProviderEventName, payload: Json): void {
    this.#listeners.get(event)?.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.error('[aiwallet] Provider event handler error:', error);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// EIP-6963: анонс провайдера через події, щоб dApps знаходили гаманець
// без гонок за window.ethereum.
// ---------------------------------------------------------------------------

interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

const PROVIDER_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="8" fill="#0f172a"/>' +
      '<circle cx="16" cy="16" r="9" fill="none" stroke="#34d399" stroke-width="2.5"/>' +
      '<circle cx="16" cy="16" r="3" fill="#34d399"/>' +
      '</svg>',
  );

export function announceEip6963(provider: AiWalletProvider): void {
  const info: Eip6963ProviderInfo = {
    uuid: crypto.randomUUID(),
    name: 'AI Wallet',
    icon: PROVIDER_ICON,
    rdns: 'app.aiwallet',
  };
  const announce = (): void => {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );
  };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}
