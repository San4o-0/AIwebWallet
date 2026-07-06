/**
 * AI-чат (F7.1–F7.4): стрімінг відповіді через SSE з POST /v1/chat
 * (fetch + ReadableStream, парсер у src/lib/sse.ts; fallback — мок-стрім).
 * Чат не має інструментів для підпису/надсилання (F7.4).
 */
import { useEffect, useRef, useState } from 'react';

import { Button, ScreenTitle } from '@/src/components/ui';
import { streamChat } from '@/src/lib/api';
import type { ChatMessage } from '@/src/lib/api-types';
import { useWalletStore } from '@/src/store/wallet';

const SUGGESTIONS = [
  'Скільки я витратив на комісії за місяць?',
  'Які в мене активні approve?',
  'Що таке газ?',
];

export default function Chat() {
  const account = useWalletStore((s) => s.account);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (text: string) => {
    const content = text.trim();
    if (content.length === 0 || streaming) return;

    const userMessage: ChatMessage = { role: 'user', content };
    const history = [...messages, userMessage];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let answer = '';
    try {
      const stream = streamChat(
        {
          messages: history,
          addresses: account !== null ? [account.addresses.evm] : [],
        },
        controller.signal,
      );
      for await (const delta of stream) {
        answer += delta;
        setMessages([...history, { role: 'assistant', content: answer }]);
      }
    } catch (error) {
      console.warn('[aiwallet] Стрім чату перервано:', error);
      setMessages([
        ...history,
        { role: 'assistant', content: answer || 'Вибачте, сталася помилка. Спробуйте ще раз.' },
      ]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="border-b border-zinc-800/80 p-4 pb-3">
        <ScreenTitle>AI-помічник</ScreenTitle>
        <p className="text-xs text-zinc-500">
          Відповідає на питання про вашу активність. Не може підписувати транзакції.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="my-auto flex flex-col gap-2">
            <p className="mb-1 text-center text-sm text-zinc-500">Спробуйте запитати:</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-left text-sm text-zinc-300 transition-colors hover:border-emerald-500/40 hover:text-zinc-100"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={index}
            className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
              message.role === 'user'
                ? 'self-end bg-emerald-500/15 text-emerald-50'
                : 'self-start border border-zinc-800/70 bg-zinc-900/70 text-zinc-200'
            }`}
          >
            {message.content.length === 0 && streaming ? (
              <span className="animate-pulse text-zinc-500">думаю…</span>
            ) : (
              message.content
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2 border-t border-zinc-800/80 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Запитайте про свої фінанси…"
          className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-emerald-500/70"
        />
        <Button type="submit" disabled={streaming || input.trim().length === 0}>
          ↑
        </Button>
      </form>
    </div>
  );
}
