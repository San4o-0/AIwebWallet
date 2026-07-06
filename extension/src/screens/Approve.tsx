/**
 * Екран підпису (Approve): запит від dApp з AI-поясненням (F4.1),
 * рівнем ризику 🟢🟡🔴 з причинами (F5.1) і підтвердженням «Розумію ризик»
 * для червоного рівня (F5.3).
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button, Card, Field, ScreenTitle, Spinner } from '@/src/components/ui';
import { assessPendingRequest, explainPendingRequest } from '@/src/lib/api';
import type { RiskLevel } from '@/src/lib/api-types';
import {
  MessageType,
  type Json,
  type PendingSignRequest,
} from '@/src/lib/messaging';
import { mockPendingRequest } from '@/src/lib/mock-data';
import { sendToBackground } from '@/src/lib/runtime';

const RISK_CONFIRM_PHRASE = 'Розумію ризик';

const RISK_META: Record<RiskLevel, { emoji: string; label: string; classes: string }> = {
  low: { emoji: '🟢', label: 'Низький ризик', classes: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
  medium: { emoji: '🟡', label: 'Середній ризик', classes: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  high: { emoji: '🔴', label: 'Високий ризик', classes: 'border-red-500/50 bg-red-500/10 text-red-300' },
};

const METHOD_TITLE: Record<PendingSignRequest['method'], string> = {
  eth_requestAccounts: 'Запит на підключення',
  eth_accounts: 'Запит адрес',
  eth_chainId: 'Запит мережі',
  eth_sendTransaction: 'Підпис транзакції',
  personal_sign: 'Підпис повідомлення',
};

export default function Approve() {
  const [request, setRequest] = useState<PendingSignRequest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const pending = await sendToBackground({ type: MessageType.GetPendingRequests });
        // Якщо черга порожня (відкрито вручну) — показуємо демо-запит.
        setRequest(pending[0] ?? mockPendingRequest());
      } catch {
        setRequest(mockPendingRequest());
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

  if (!loaded || request === null) {
    return (
      <div className="flex min-h-[600px] flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const isHigh = risk?.level === 'high';
  const confirmOk = !isHigh || confirmText.trim() === RISK_CONFIRM_PHRASE;
  const meta = risk !== undefined ? RISK_META[risk.level] : null;

  return (
    <div className="flex min-h-[600px] flex-1 flex-col gap-4 p-4">
      <header>
        <ScreenTitle>{METHOD_TITLE[request.method]}</ScreenTitle>
        <p className="mt-1 text-sm text-zinc-400">
          Запит від <span className="font-medium text-zinc-200">{request.origin}</span>
        </p>
      </header>

      {/* AI-пояснення простою мовою (F4.1) */}
      <Card>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Що станеться
        </p>
        {explanation === undefined ? (
          <div className="flex justify-center py-2">
            <Spinner />
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-zinc-200">{explanation}</p>
        )}
      </Card>

      {/* Рівень ризику з причинами (F5.1) */}
      {risk !== undefined && meta !== null && (
        <div className={`rounded-2xl border p-4 ${meta.classes}`}>
          <p className="text-sm font-semibold">
            {meta.emoji} {meta.label}
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {risk.reasons.map((reason) => (
              <li key={reason} className="flex gap-2 text-xs leading-snug text-zinc-300">
                <span className="text-zinc-500">•</span>
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Технічні деталі запиту */}
      <details className="group">
        <summary className="cursor-pointer text-xs text-zinc-500 transition-colors hover:text-zinc-300">
          Технічні деталі
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 font-mono text-[11px] leading-relaxed text-zinc-400">
          {JSON.stringify(
            { method: request.method, params: request.params as Json },
            null,
            2,
          )}
        </pre>
      </details>

      <div className="mt-auto flex flex-col gap-3">
        {/* F5.3: для 🔴 — додаткове підтвердження */}
        {isHigh && (
          <Field
            label={`Щоб продовжити, введіть «${RISK_CONFIRM_PHRASE}»`}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={RISK_CONFIRM_PHRASE}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
            Відхилити
          </Button>
          <Button
            variant={isHigh ? 'danger' : 'primary'}
            disabled={busy || !confirmOk || risk === undefined}
            onClick={() => void decide(true)}
          >
            Підписати
          </Button>
        </div>
      </div>
    </div>
  );
}
