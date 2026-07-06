/**
 * Content script (ізольований світ, ТЗ §6 п.4):
 *  1. інжектить injected.js у контекст сторінки (window.ethereum, EIP-6963);
 *  2. форвардить RPC-запити сторінки в background і повертає відповіді.
 * Повідомлення — тільки типізований postMessage-протокол з перевіркою джерела.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { injectScript } from 'wxt/utils/inject-script';

import {
  MessageType,
  PAGE_TARGET,
  isPageRpcRequest,
  type PageRpcResponse,
  type RpcOutcome,
} from '@/src/lib/messaging';
import { sendToBackground } from '@/src/lib/runtime';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    // Слухач ставимо до інжекту, щоб не загубити ранні запити провайдера.
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      // Приймаємо тільки повідомлення від самої сторінки (same window/origin).
      if (event.source !== window) return;
      const data = event.data;
      if (!isPageRpcRequest(data)) return;

      void (async () => {
        let outcome: RpcOutcome;
        try {
          outcome = await sendToBackground({
            type: MessageType.RpcRequest,
            id: data.id,
            origin: window.location.origin,
            payload: data.payload,
          });
        } catch {
          outcome = {
            ok: false,
            error: { code: -32603, message: 'Гаманець недоступний.' },
          };
        }
        const response: PageRpcResponse = {
          target: PAGE_TARGET,
          type: MessageType.RpcResponse,
          id: data.id,
          outcome,
        };
        window.postMessage(response, window.location.origin);
      })();
    });

    await injectScript('/injected.js', { keepInDom: true });
  },
});
