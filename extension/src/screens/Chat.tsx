/**
 * AI-чат (F7.1–F7.4): стрімінг відповіді через SSE з POST /v1/chat
 * (fetch + ReadableStream, парсер у src/lib/sse.ts; fallback — мок-стрім).
 * Чат не має інструментів для підпису/надсилання (F7.4).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AiOffNote, useAiAllowed } from '@/src/components/consent';
import { IconSend, IconSparkle } from '@/src/components/icons';
import { Eyebrow, ScreenTitle } from '@/src/components/ui';
import { streamChat } from '@/src/lib/api';
import type { ChatMessage } from '@/src/lib/api-types';
import { useWalletStore } from '@/src/store/wallet';

/** i18n-ключі підказок для порожнього чату. */
const SUGGESTION_KEYS = ['chat.suggestion1', 'chat.suggestion2', 'chat.suggestion3'];

export default function Chat() {
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  // AI-функції — opt-in (src/lib/consent.ts). Вимкнено → екран не шле ЖОДНОГО
  // запиту: ані форми, ані підказок. Гейт продубльовано в streamChat.
  const aiAllowed = useAiAllowed();
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
          // Усі публічні адреси акаунта — щоб AI бачив і Solana/Bitcoin/TRON.
          addresses:
            account !== null
              ? [
                  account.addresses.evm,
                  account.addresses.solana,
                  account.addresses.bitcoin,
                  account.addresses.tron,
                ].filter((a) => a !== '')
              : [],
        },
        controller.signal,
      );
      for await (const delta of stream) {
        answer += delta;
        setMessages([...history, { role: 'assistant', content: answer }]);
      }
    } catch (error) {
      console.warn('[aiwallet] Chat stream interrupted:', error);
      setMessages([
        ...history,
        {
          role: 'assistant',
          content: answer || t('chat.streamInterrupted'),
        },
      ]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const header = (
    <div className="border-b border-hairline p-5 pb-4">
      <Eyebrow className="mb-1">{t('chat.eyebrow')}</Eyebrow>
      <ScreenTitle>{t('chat.title')}</ScreenTitle>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{t('chat.disclaimer')}</p>
    </div>
  );

  if (!aiAllowed) {
    return (
      <div className="screen-in flex h-full flex-col pb-14">
        {header}
        <div className="flex flex-1 items-center p-5">
          <AiOffNote />
        </div>
      </div>
    );
  }

  return (
    <div className="screen-in flex h-full flex-col pb-14">
      {header}

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
        {messages.length === 0 && (
          <div className="my-auto flex flex-col items-center gap-3">
            <IconSparkle size={22} className="text-accent" />
            <Eyebrow>{t('chat.tryAsking')}</Eyebrow>
            <div className="stagger-rise flex w-full flex-col gap-2">
              {SUGGESTION_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => void send(t(key))}
                  className="rounded-xl border border-hairline bg-surface px-3.5 py-2.5 text-start text-sm text-ink transition-[border-color,transform] duration-100 hover:border-accent/50 active:scale-[0.99]"
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={index}
            className={`animate-rise max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
              message.role === 'user'
                ? 'self-end rounded-ee-md border border-accent/25 bg-accent/10 text-ink'
                : 'self-start rounded-es-md border border-hairline bg-surface text-ink'
            }`}
          >
            {message.content.length === 0 && streaming ? (
              <span className="typing-dots" role="status" aria-label={t('chat.thinking')}>
                <span />
                <span />
                <span />
              </span>
            ) : (
              message.content
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2 border-t border-hairline p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('chat.placeholder')}
          className="flex-1 rounded-xl border border-hairline bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/50 focus:border-accent"
        />
        <button
          type="submit"
          disabled={streaming || input.trim().length === 0}
          aria-label={t('chat.sendAria')}
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-bg transition-[background-color,transform] duration-100 hover:bg-accent-bright active:scale-95 disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted/60 disabled:active:scale-100"
        >
          <IconSend size={17} />
        </button>
      </form>
    </div>
  );
}
