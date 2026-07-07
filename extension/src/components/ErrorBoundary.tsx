/**
 * ErrorBoundary попапа: React 18 при некритичному винятку в render розмонтовує
 * ВСЕ дерево — на темному тлі попапа це виглядає як «повністю чорний екран»
 * (саме так проявлявся краш у Firefox). Замість цього показуємо текст помилки
 * та stack, щоб причину було видно без відкриття консолі.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[aiwallet] React-краш у попапі:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;

    const stack = [error.stack, componentStack].filter(Boolean).join('\n--- component stack ---');
    return (
      <div className="flex min-h-[600px] flex-1 flex-col gap-3 p-4">
        <h1 className="text-lg font-bold text-red-400">Сталася помилка</h1>
        <p className="text-sm text-zinc-300">
          Інтерфейс гаманця аварійно завершився. Ваші ключі в безпеці — зашифроване сховище не
          зачеплено.
        </p>
        <p className="break-words rounded-lg bg-red-500/10 p-2.5 font-mono text-xs text-red-300">
          {error.message}
        </p>
        {stack.length > 0 && (
          <pre className="max-h-64 overflow-auto rounded-lg bg-zinc-900 p-2.5 text-[10px] leading-relaxed text-zinc-500">
            {stack}
          </pre>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-auto rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"
        >
          Перезавантажити
        </button>
      </div>
    );
  }
}
