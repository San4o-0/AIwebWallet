/**
 * Екран підпису (Approve): запит від dApp з AI-поясненням (F4.1),
 * рівнем ризику (шавлія/бурштин/теракота, F5.1) і підтвердженням
 * «Розумію ризик» для високого рівня (F5.3).
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconShield } from '@/src/components/icons';
import { Button, EmptyState, Eyebrow, Field, ScreenTitle, Spinner } from '@/src/components/ui';
import { assessPendingRequest, explainPendingRequest } from '@/src/lib/api';
import type { RiskLevel } from '@/src/lib/api-types';
import {
  MessageType,
  type Json,
  type PendingSignRequest,
} from '@/src/lib/messaging';
import { sendToBackground } from '@/src/lib/runtime';

/** Бейдж ризику: колірна точка + підпис (без емодзі-світлофора). */
const RISK_META: Record<
  RiskLevel,
  { labelKey: string; badge: string; dot: string; card: string }
> = {
  low: {
    labelKey: 'risk.low',
    badge: 'border-positive/40 bg-positive/10 text-positive',
    dot: 'bg-positive',
    card: 'border-hairline',
  },
  medium: {
    labelKey: 'risk.medium',
    badge: 'border-amber/40 bg-amber/10 text-amber',
    dot: 'bg-amber',
    card: 'border-hairline',
  },
  high: {
    labelKey: 'risk.high',
    badge: 'border-danger/50 bg-danger/10 text-danger',
    dot: 'bg-danger',
    card: 'border-danger/60',
  },
};

/** i18n-ключі заголовків за методом запиту. */
const METHOD_TITLE_KEY: Record<PendingSignRequest['method'], string> = {
  eth_requestAccounts: 'approve.method.eth_requestAccounts',
  eth_accounts: 'approve.method.eth_accounts',
  eth_chainId: 'approve.method.eth_chainId',
  eth_sendTransaction: 'approve.method.eth_sendTransaction',
  personal_sign: 'approve.method.personal_sign',
};

export default function Approve() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<PendingSignRequest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const pending = await sendToBackground({ type: MessageType.GetPendingRequests });
        // Черга порожня — чесний порожній стан, без вигаданого запиту.
        setRequest(pending[0] ?? null);
      } catch {
        setRequest(null);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const { data: risk } = useQuery({
    queryKey: ['risk', request?.id],
    queryFn: () => assessPendingRequest(request as PendingSignRequest),
    enabled: request !== null,
  });

  const { data: explanation } = useQuery({
    queryKey: ['explain', request?.id, risk?.level],
    queryFn: () => explainPendingRequest(request as PendingSignRequest, risk ?? null),
    enabled: request !== null && risk !== undefined,
  });

  const decide = async (approved: boolean) => {
    if (request === null) return;
    setBusy(true);
    try {
      await sendToBackground({
        type: MessageType.ResolveApproval,
        requestId: request.id,
        approved,
      });
    } finally {
      window.close();
    }
  };

  if (!loaded) {
    return (
      <div className="flex h-full min-h-[600px] flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // Немає запиту на підпис (вікно відкрито без активного запиту від dApp).
  if (request === null) {
    return (
      <div className="flex h-full min-h-[600px] flex-1 flex-col items-center justify-center gap-5 p-6">
        <EmptyState
          icon={<IconShield size={22} />}
          title={t('approve.noRequestTitle')}
          hint={t('approve.noRequestHint')}
        />
        <Button variant="secondary" onClick={() => window.close()}>
          {t('approve.close')}
        </Button>
      </div>
    );
  }

  // Фраза підтвердження високого ризику — локалізована (F5.3).
  const riskConfirmPhrase = t('approve.confirmPhrase');
  const isHigh = risk?.level === 'high';
  const confirmOk = !isHigh || confirmText.trim() === riskConfirmPhrase;
  const meta = risk !== undefined ? RISK_META[risk.level] : null;

  return (
    <div className="flex h-full min-h-[600px] flex-1 flex-col gap-5 overflow-y-auto p-5">
      <header>
        <Eyebrow className="mb-1">{t('approve.eyebrow')}</Eyebrow>
        <ScreenTitle>{t(METHOD_TITLE_KEY[request.method])}</ScreenTitle>
        <p className="mt-2 text-sm text-muted">
          {t('approve.fromLabel')}{' '}
          <span className="font-mono text-[13px] text-ink" dir="ltr">
            {request.origin}
          </span>
        </p>
      </header>

      {/*
       * Головна картка: AI-пояснення + рівень ризику (F4.1, F5.1).
       * Високий ризик — теракотова рамка всієї картки.
       */}
      <div
        className={`animate-rise rounded-[10px] border bg-surface ${meta?.card ?? 'border-hairline'}`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
          <Eyebrow>{t('approve.whatHappens')}</Eyebrow>
          {meta !== null && (
            <span
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.badge}`}
            >
              <span className={`size-1.5 rounded-full ${meta.dot}`} aria-hidden />
              {t(meta.labelKey)}
            </span>
          )}
        </div>
        <div className="px-4 py-3.5">
          {explanation === undefined ? (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          ) : (
            <p className="text-sm leading-relaxed text-ink">{explanation}</p>
          )}
          {risk !== undefined && risk.reasons.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5 border-t border-hairline pt-3">
              {risk.reasons.map((reason) => (
                <li key={reason} className="flex gap-2 text-xs leading-snug text-muted">
                  <span
                    className={`mt-1.5 size-1 shrink-0 rounded-full ${meta?.dot ?? 'bg-muted'}`}
                    aria-hidden
                  />
                  {reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Технічні деталі запиту */}
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted transition-colors hover:text-ink">
          {t('approve.techDetails')}
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded-xl border border-hairline bg-surface p-3 font-mono text-[11px] leading-relaxed text-muted">
          {JSON.stringify(
            { method: request.method, params: request.params as Json },
            null,
            2,
          )}
        </pre>
      </details>

      <div className="sticky bottom-0 -mx-5 mt-auto flex flex-col gap-3 border-t border-hairline bg-bg px-5 pb-4 pt-3">
        {/* F5.3: для високого ризику — додаткове підтвердження */}
        {isHigh && (
          <div className="rounded-[10px] border border-danger/60 bg-danger/10 p-3.5">
            <p className="mb-2.5 flex items-center gap-2 text-xs font-medium text-ink">
              <IconShield size={15} className="shrink-0 text-danger" />
              {t('approve.confirmPrompt', { phrase: riskConfirmPhrase })}
            </p>
            <Field
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={riskConfirmPhrase}
              aria-label={t('approve.confirmAria', { phrase: riskConfirmPhrase })}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
            {t('approve.reject')}
          </Button>
          <Button
            variant={isHigh ? 'danger' : 'primary'}
            disabled={busy || !confirmOk || risk === undefined}
            onClick={() => void decide(true)}
          >
            {t('approve.sign')}
          </Button>
        </div>
      </div>
    </div>
  );
}
