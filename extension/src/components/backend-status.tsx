/**
 * Стан «сервер прокидається» — чесна заміна голому спінеру на ХОЛОДНОМУ СТАРТІ.
 *
 * Бекенд живе на безкоштовному хостингу (Render free tier): інстанс засинає
 * після ~15 хв простою, і перший запит після сну чекає 30–60 с, поки процес
 * підніметься (див. блок про таймаути у src/lib/api.ts). Мовчазний спінер
 * такої довжини читається як «зависло», а помилка — як «зламано». Тому: після
 * COLD_START_HINT_MS очікування екран прямо каже, ЩО відбувається і скільки це
 * триватиме.
 *
 * ОДИН компонент на всі екрани, де є завантаження (Home, Activity, Analytics,
 * Send, Approve) — таймер і текст не дублюються п'ять разів. Поки запит іде
 * швидше за поріг, компонент не рендерить нічого: на прогрітому бекенді
 * користувач цієї ноти не побачить узагалі.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/src/components/ui';
import { COLD_START_HINT_MS } from '@/src/lib/api';

/**
 * true, якщо `pending` тримається довше за `delayMs`. Таймер перезапускається
 * на кожну нову операцію і гаситься, щойно вона завершилась (успіхом чи
 * помилкою), тож нота не «залипає» між запитами.
 */
export function useSlowPending(pending: boolean, delayMs: number = COLD_START_HINT_MS): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(timer);
  }, [pending, delayMs]);

  return slow;
}

/**
 * Нота «сервер прокидається». Рендериться ПОРЯД зі скелетонами/спінером
 * екрана, а не замість них: рух на місці даних лишається, з'являється лише
 * пояснення затримки.
 */
export function BackendWakingNote({
  pending,
  className = '',
}: {
  pending: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const slow = useSlowPending(pending);

  if (!slow) return null;

  return (
    <div
      role="status"
      className={`animate-rise flex items-start gap-3 rounded-[10px] border border-accent/40 bg-accent/5 p-3.5 ${className}`}
    >
      <span className="mt-0.5 shrink-0">
        <Spinner />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{t('backend.wakingTitle')}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted">
          {t('backend.wakingHint')}
        </span>
      </span>
    </div>
  );
}
