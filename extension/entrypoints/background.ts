/**
 * Background service worker (Manifest V3):
 *  - приймає типізовані повідомлення від content script і popup (src/lib/messaging.ts);
 *  - тримає стан сесії + автолок (заглушка з таймером);
 *  - чергує запити на підпис від dApps і відкриває вікно попапа (екран Approve).
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

import {
  MessageType,
  RPC_ERRORS,
  isBackgroundMessage,
  type BackgroundMessage,
  type BgResolveApproval,
  type BgRpcRequest,
  type Json,
  type PendingSignRequest,
  type RpcOutcome,
  type SessionState,
} from '@/src/lib/messaging';

const MOCK_CHAIN_ID_HEX = '0x1'; // Ethereum mainnet (мок; буде перемикання мереж)
const AUTO_LOCK_MS = 5 * 60_000;

export default defineBackground(() => {
  // -------------------------------------------------------------------------
  // Сесія та автолок.
  // ЗАГЛУШКА: стан живе в пам'яті service worker, тож скидається, коли SW
  // засинає. Реальна реалізація: chrome.alarms + зашифрований session key у
  // chrome.storage.session, розблокування ядра — у WASM (crates/wallet-core).
  // -------------------------------------------------------------------------
  let session: SessionState = { unlocked: false, address: null, autoLockAt: null };
  let autoLockTimer: ReturnType<typeof setTimeout> | undefined;

  function lockSession(): void {
    session = { unlocked: false, address: null, autoLockAt: null };
    if (autoLockTimer !== undefined) clearTimeout(autoLockTimer);
    autoLockTimer = undefined;
  }

  function touchAutoLock(): void {
    if (!session.unlocked) return;
    if (autoLockTimer !== undefined) clearTimeout(autoLockTimer);
    session.autoLockAt = Date.now() + AUTO_LOCK_MS;
    autoLockTimer = setTimeout(lockSession, AUTO_LOCK_MS);
  }

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

  function randomHex(bytes: number): string {
    const buf = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Мок-результат для схваленого запиту. Реальний підпис — у WASM-ядрі через popup. */
  function approvedOutcome(request: PendingSignRequest): RpcOutcome {
    switch (request.method) {
      case 'eth_requestAccounts':
        return { ok: true, result: session.address !== null ? [session.address] : [] };
      case 'eth_sendTransaction':
        return { ok: true, result: `0x${randomHex(32)}` };
      case 'personal_sign':
        return { ok: true, result: `0x${randomHex(65)}` };
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

  function resolveApproval(message: BgResolveApproval): { ok: boolean } {
    const entry = pendingRequests.get(message.requestId);
    if (entry === undefined) return { ok: false };
    pendingRequests.delete(message.requestId);
    entry.resolve(
      message.approved
        ? approvedOutcome(entry.request)
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
      case MessageType.UnlockSession:
        session = {
          unlocked: true,
          address: message.address,
          autoLockAt: Date.now() + AUTO_LOCK_MS,
        };
        touchAutoLock();
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
    }
  }

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: unknown) => void) => {
      if (!isBackgroundMessage(message)) return;
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
