/**
 * Екран підпису (Approve): запит від dApp.
 *
 * ПОРЯДОК ВАЖИТЬ. Спершу — ФАКТИ транзакції, виведені локально з тих самих
 * байтів, що підуть у підпис (кому, скільки, яка мережа, яка комісія), і лише
 * ПОТІМ AI-пояснення з рівнем ризику (F4.1, F5.1) — як допоміжна думка.
 * Раніше було навпаки: `to`/`value`/`data` ховались у згорнутому <details> як
 * сирий JSON, а комісії/nonce/chainId не показувались узагалі (їх тягнув
 * background уже ПІСЛЯ схвалення). Тобто рішення ухвалювалось за кольоровим
 * бейджем, а комісія підписувалась наосліп — для гаманця, що продає себе як
 * «попереджаємо про ризики», це неприйнятно.
 *
 * СНАПШОТ КОМІСІЙ. GET /v1/tx/params смикається ТУТ, до показу; показані
 * значення (chain_id + комісії + gas limit) повертаються у background разом із
 * рішенням і саме ними підписується транзакція (FeeSnapshot). Не вдалося
 * отримати параметри → кнопка підпису заблокована і видно причину: чесна
 * відмова замість підпису наосліп.
 *
 * АДРЕСАЦІЯ. Вікно показує САМЕ той запит, чий `requestId` стоїть у URL
 * (`popup.html?view=approve&requestId=…`), а не «перший у черзі».
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BackendWakingNote } from '@/src/components/backend-status';
import { ChainIcon } from '@/src/components/chain-icons';
import { IconCheck, IconCopy, IconShield } from '@/src/components/icons';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Eyebrow,
  Field,
  ScreenTitle,
  Spinner,
} from '@/src/components/ui';
import { localizeError, localizeUnknownError } from '@/src/i18n';
import {
  assessPendingRequest,
  explainPendingRequest,
  fetchPortfolio,
  fetchTxParams,
} from '@/src/lib/api';
import type { RiskLevel } from '@/src/lib/api-types';
import { selectPendingRequest, verifyFeeSnapshot } from '@/src/lib/approval-queue';
import { CHAINS, DAPP_CHAIN } from '@/src/lib/chains';
import {
  decodePersonalSignText,
  decodeTxIntent,
  formatUnits,
  maxFeeWei,
  parseQuantity,
  readDappTx,
  unitsToNumber,
  type TxIntent,
  type TxIntentKind,
} from '@/src/lib/evm';
import { formatUsd } from '@/src/lib/format';
import {
  MessageType,
  type FeeSnapshot,
  type Json,
  type PendingSignRequest,
} from '@/src/lib/messaging';
import { sendToBackground } from '@/src/lib/runtime';

/** Запит, який спричинив саме це вікно (не «перший у черзі»). */
const REQUEST_ID = new URLSearchParams(window.location.search).get('requestId');

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

/** Що робить транзакція — капсула у шапці картки фактів. */
const ACTION_KEY: Record<TxIntentKind, string> = {
  native: 'approve.action.native',
  'erc20-transfer': 'approve.action.tokenTransfer',
  'erc20-approve': 'approve.action.tokenApprove',
  'contract-call': 'approve.action.contractCall',
  'contract-deploy': 'approve.action.deploy',
};

/** Підпис суми: у approve це не «сума переказу», а ліміт витрачання. */
const AMOUNT_LABEL_KEY: Record<TxIntentKind, string> = {
  native: 'approve.amountLabel',
  'erc20-transfer': 'approve.amountLabel',
  'erc20-approve': 'approve.allowanceLabel',
  'contract-call': 'approve.amountLabel',
  'contract-deploy': 'approve.amountLabel',
};

/** Кого показуємо як контрагента: отримувач / spender / контракт. */
const COUNTERPARTY_LABEL_KEY: Record<TxIntentKind, string> = {
  native: 'approve.recipientLabel',
  // Гроші йдуть НЕ на адресу контракту, а на адресу з calldata.
  'erc20-transfer': 'approve.recipientLabel',
  'erc20-approve': 'approve.spenderLabel',
  'contract-call': 'approve.contractLabel',
  'contract-deploy': 'approve.contractLabel',
};

export default function Approve() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<PendingSignRequest | null>(null);
  const [signer, setSigner] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [pending, session] = await Promise.all([
          sendToBackground({ type: MessageType.GetPendingRequests }),
          sendToBackground({ type: MessageType.GetSessionState }),
        ]);
        // Саме той запит, що відкрив це вікно. Немає id / запит зник —
        // чесний порожній стан, без показу чужого запиту з черги.
        setRequest(selectPendingRequest(pending, REQUEST_ID));
        setSigner(session.address);
      } catch {
        setRequest(null);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const isTx = request?.method === 'eth_sendTransaction';

  // Факти рахуємо ЛОКАЛЬНО з params запиту — з тих самих байтів, що підуть у
  // підпис. Бекенд дає ризик і пояснення; кому/скільки — рахує гаманець.
  const dappTx = useMemo(() => (request === null ? null : readDappTx(request.params)), [request]);
  const intent = useMemo<TxIntent | null>(
    () => (isTx && dappTx !== null ? decodeTxIntent(DAPP_CHAIN, dappTx) : null),
    [isTx, dappTx],
  );

  // Комісія — ДО схвалення. Снапшот: staleTime Infinity + без рефетчу, щоб
  // підписати рівно те, що бачив користувач.
  const {
    data: txParams,
    isLoading: feeLoading,
    error: feeQueryError,
    refetch: refetchFee,
  } = useQuery({
    queryKey: ['tx-params', request?.id],
    queryFn: () =>
      fetchTxParams(DAPP_CHAIN, signer as string, dappTx?.data != null && dappTx.data !== '0x'),
    enabled: isTx && signer !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  /**
   * Снапшот комісій, показаний користувачу. gas limit — від dApp (він знає
   * свій виклик) або консервативна оцінка бекенду; решта — тариф standard.
   * Перевіряємо ТУТ тими самими правилами, що й background: якщо dApp прислав
   * абсурдний gas, користувач побачить помилку зараз, а не після підпису.
   */
  const [feeSnapshot, feeSnapshotError] = useMemo<[FeeSnapshot | null, string | null]>(() => {
    if (txParams === undefined || dappTx === null) return [null, null];
    const gas = parseQuantity(dappTx.gas) ?? parseQuantity(txParams.gas_limit_estimate);
    if (gas === null) return [null, t('errors.txParamsInvalid')];
    const snapshot: FeeSnapshot = {
      chainId: txParams.chain_id,
      gasLimit: gas.toString(),
      maxFeePerGas: txParams.fees.standard.max_fee_per_gas,
      maxPriorityFeePerGas: txParams.fees.standard.max_priority_fee_per_gas,
    };
    try {
      verifyFeeSnapshot(DAPP_CHAIN, snapshot);
      return [snapshot, null];
    } catch (error) {
      return [null, localizeUnknownError(error, 'errors.txParamsInvalid')];
    }
  }, [txParams, dappTx, t]);

  /**
   * Чому підпис заблоковано. Показуємо ПРИЧИНУ, а не вічний спінер комісії:
   * «не даємо підписати» без пояснення — це та сама сліпота, тільки з іншого
   * боку. Кнопка підпису disabled рівно тоді, коли тут щось є.
   */
  const blockReason = useMemo<{ text: string; retry: boolean } | null>(() => {
    if (!isTx) return null;
    // params[0] не є обʼєктом транзакції — читати нічого, підписувати теж.
    if (dappTx === null) return { text: t('approve.invalidTxParams'), retry: false };
    // Гаманець заблокований: без адреси не отримати ні комісію, ні підпис.
    if (signer === null) return { text: t('errors.walletLocked'), retry: false };
    if (feeQueryError !== null) {
      return {
        text: t('approve.feeBlocked', {
          detail: localizeUnknownError(feeQueryError, 'errors.api.txParamsFailed'),
        }),
        retry: true,
      };
    }
    if (feeSnapshotError !== null) {
      return { text: t('approve.feeBlocked', { detail: feeSnapshotError }), retry: false };
    }
    return null;
  }, [isTx, dappTx, signer, feeQueryError, feeSnapshotError, t]);

  // Ціни — суто для довідкового «≈ $»: недоступні → показуємо лише монету.
  const { data: portfolio } = useQuery({
    queryKey: ['portfolio', signer],
    queryFn: () =>
      fetchPortfolio({
        addresses: { evm: signer !== null ? [signer] : [], solana: [], bitcoin: [], tron: [] },
      }),
    enabled: signer !== null,
    retry: false,
  });

  const priceOf = (symbol: string | null, native: boolean): number | null => {
    const match = portfolio?.tokens.find(
      (token) =>
        token.chain === DAPP_CHAIN &&
        token.isNative === native &&
        (native || token.symbol === symbol),
    );
    // usdPrice === 0 буває і для «немає ціни», і для нульового балансу —
    // не вигадуємо «$0.00», просто не показуємо оцінку.
    return match !== undefined && match.usdPrice > 0 ? match.usdPrice : null;
  };

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
    // Підпис транзакції без показаної комісії неможливий (background теж
    // відмовить — тут просто не даємо натиснути).
    if (approved && isTx && feeSnapshot === null) return;
    setBusy(true);
    setDecisionError(null);

    if (!approved) {
      try {
        await sendToBackground({
          type: MessageType.ResolveApproval,
          requestId: request.id,
          approved: false,
        });
      } finally {
        window.close();
      }
      return;
    }

    try {
      const result = await sendToBackground({
        type: MessageType.ResolveApproval,
        requestId: request.id,
        approved: true,
        ...(feeSnapshot !== null ? { fee: feeSnapshot } : {}),
      });
      if (result.ok) {
        window.close();
        return;
      }
      // Схвалення не вдалося (бекенд ліг, підпис впав) — вікно НЕ закриваємо:
      // користувач мусить побачити, що транзакція не пішла.
      setDecisionError(
        result.error !== undefined ? localizeError(result.error) : t('errors.approvalFailed'),
      );
    } catch (error) {
      setDecisionError(localizeUnknownError(error, 'errors.approvalFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div className="flex h-full min-h-[600px] flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // Немає запиту на підпис (вікно відкрито без активного запиту від dApp,
  // або запит уже вирішено в іншому вікні).
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
  const signBlocked = isTx && feeSnapshot === null;

  return (
    <div className="screen-in flex h-full min-h-[600px] flex-1 flex-col gap-4 overflow-y-auto p-5">
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

      {/* Холодний старт бекенду: комісія (/tx/params) і саме схвалення
          (/tx/broadcast) можуть чекати підняття інстансу до хвилини. Поки
          користувач дивиться на «Отримуємо комісію…», він має розуміти, чому. */}
      <BackendWakingNote pending={feeLoading || busy} />

      {/* --- ФАКТИ: те, за чим ухвалюється рішення --- */}

      {isTx && intent !== null && (
        <TxFacts
          intent={intent}
          feeSnapshot={feeSnapshot}
          feeLoading={feeLoading}
          blockReason={blockReason}
          onRetryFee={() => void refetchFee()}
          nativePrice={priceOf(null, true)}
          assetPrice={
            intent.kind === 'erc20-transfer' || intent.kind === 'erc20-approve'
              ? priceOf(intent.symbol, false)
              : priceOf(null, true)
          }
        />
      )}

      {/* Транзакція, яку неможливо навіть прочитати (битий params[0]) — фактів
          немає, тож і картки фактів немає: чесна відмова замість порожнього блоку. */}
      {isTx && intent === null && blockReason !== null && (
        <ErrorNote>{blockReason.text}</ErrorNote>
      )}

      {request.method === 'personal_sign' && (
        <MessageFacts request={request} signer={signer} />
      )}

      {request.method === 'eth_requestAccounts' && <ConnectFacts signer={signer} />}

      {/* --- AI-пояснення і рівень ризику: ДОПОМІЖНЕ, під фактами (F4.1, F5.1) --- */}
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
          <p className="mt-3 border-t border-hairline pt-3 text-xs leading-relaxed text-muted/80">
            {t('approve.aiAdvisory')}
          </p>
        </div>
      </div>

      {/* Технічні деталі запиту (сирий JSON) — для тих, хто читає calldata */}
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
        {decisionError !== null && <ErrorNote>{decisionError}</ErrorNote>}

        {/* F5.3: для високого ризику — додаткове підтвердження */}
        {isHigh && (
          <div className="attention-danger animate-rise rounded-[10px] border border-danger/60 bg-danger/10 p-3.5">
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
            disabled={busy || !confirmOk || risk === undefined || signBlocked}
            // Поки комісія не відома (вантажиться або впала) — підпис заблоковано,
            // і підказка називає ПРИЧИНУ, а не просто гасить кнопку.
            title={signBlocked ? (blockReason?.text ?? t('approve.feeLoading')) : undefined}
            onClick={() => void decide(true)}
          >
            {busy ? t('approve.signing') : t('approve.sign')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Факти транзакції
// ---------------------------------------------------------------------------

function TxFacts({
  intent,
  feeSnapshot,
  feeLoading,
  blockReason,
  onRetryFee,
  nativePrice,
  assetPrice,
}: {
  intent: TxIntent;
  feeSnapshot: FeeSnapshot | null;
  feeLoading: boolean;
  blockReason: { text: string; retry: boolean } | null;
  onRetryFee: () => void;
  nativePrice: number | null;
  assetPrice: number | null;
}) {
  const { t } = useTranslation();
  const nativeSymbol = CHAINS[DAPP_CHAIN].symbol;

  // Невідомий токен — суму видно лише «сирою» (без decimals її не можна
  // чесно перерахувати). Мовчки поділити на 10^18 було б брехнею.
  const amountText =
    intent.decimals === null
      ? intent.amount.toString()
      : formatUnits(intent.amount, intent.decimals, 8);
  const amountUsd =
    intent.decimals !== null && assetPrice !== null && intent.amount > 0n && !intent.unlimited
      ? unitsToNumber(intent.amount, intent.decimals) * assetPrice
      : null;

  const feeWei =
    feeSnapshot !== null ? maxFeeWei(feeSnapshot.gasLimit, feeSnapshot.maxFeePerGas) : null;
  const feeUsd = feeWei !== null && nativePrice !== null ? unitsToNumber(feeWei, 18) * nativePrice : null;
  const gwei =
    feeSnapshot !== null ? formatUnits(parseQuantity(feeSnapshot.maxFeePerGas) ?? 0n, 9, 2) : null;

  return (
    <Card className="animate-rise p-0">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <Eyebrow>{t('approve.factsEyebrow')}</Eyebrow>
        <span className="shrink-0 rounded-full border border-hairline bg-raised px-2.5 py-1 text-[11px] font-semibold text-ink">
          {t(ACTION_KEY[intent.kind])}
        </span>
      </div>

      {/* Скільки */}
      <div className="border-b border-hairline px-4 py-3.5">
        <Eyebrow className="mb-1.5">{t(AMOUNT_LABEL_KEY[intent.kind])}</Eyebrow>
        {intent.unlimited ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/50 bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger">
            <span className="size-1.5 rounded-full bg-danger" aria-hidden />
            {t('approve.unlimited', { symbol: intent.symbol ?? t('approve.unknownTokenShort') })}
          </span>
        ) : (
          <p
            className="font-mono text-[19px] font-semibold leading-tight tabular-nums text-ink"
            dir="ltr"
          >
            {amountText} {intent.symbol ?? ''}
          </p>
        )}
        {amountUsd !== null && (
          <p className="mt-1 text-xs text-muted" dir="ltr">
            ≈ {formatUsd(amountUsd)}
          </p>
        )}
        {intent.unlimited && (
          <p className="mt-2.5 text-xs leading-relaxed text-danger">
            {t('approve.unlimitedWarning')}
          </p>
        )}
        {intent.symbol === null &&
          (intent.kind === 'erc20-transfer' || intent.kind === 'erc20-approve') && (
            <p className="mt-2.5 text-xs leading-relaxed text-amber">{t('approve.unknownToken')}</p>
          )}
        {/* Нативна монета, що йде РАЗОМ із викликом контракту, — окремий факт. */}
        {intent.kind !== 'native' &&
          intent.kind !== 'contract-call' &&
          intent.nativeValue > 0n && (
            <p className="mt-2.5 text-xs leading-relaxed text-amber" dir="ltr">
              {t('approve.plusNative', {
                amount: formatUnits(intent.nativeValue, 18, 8),
                symbol: nativeSymbol,
              })}
            </p>
          )}
        {intent.kind === 'contract-call' && intent.selector !== null && (
          <p className="mt-2.5 font-mono text-xs leading-relaxed text-muted" dir="ltr">
            {t('approve.unknownSelector', { selector: intent.selector })}
          </p>
        )}
      </div>

      {/* Куди — справжній отримувач/spender/контракт */}
      <div className="border-b border-hairline px-4 py-3.5">
        {intent.counterparty !== null ? (
          <AddressBlock
            label={t(COUNTERPARTY_LABEL_KEY[intent.kind])}
            address={intent.counterparty}
            danger={intent.kind === 'erc20-approve'}
          />
        ) : (
          <>
            <Eyebrow className="mb-1.5">{t('approve.recipientLabel')}</Eyebrow>
            <p className="text-xs leading-relaxed text-amber">{t('approve.deployWarning')}</p>
          </>
        )}
        {/* Для ERC-20 контракт токена — окремо від отримувача: їх плутають. */}
        {intent.contract !== null && intent.contract !== intent.counterparty && (
          <div className="mt-3.5 border-t border-hairline pt-3.5">
            <AddressBlock label={t('approve.tokenContractLabel')} address={intent.contract} />
          </div>
        )}
      </div>

      {/* Мережа */}
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3.5">
        <Eyebrow>{t('approve.networkLabel')}</Eyebrow>
        <span className="flex items-center gap-2 text-sm text-ink">
          <ChainIcon chain={DAPP_CHAIN} size={18} className="shrink-0" />
          {CHAINS[DAPP_CHAIN].label}
        </span>
      </div>

      {/* Комісія — ДО схвалення (стеля: gas limit × max fee per gas) */}
      <div className="px-4 py-3.5">
        <Eyebrow className="mb-1.5">{t('approve.feeLabel')}</Eyebrow>
        {blockReason !== null ? (
          <ErrorNote onRetry={blockReason.retry ? onRetryFee : undefined}>
            {blockReason.text}
          </ErrorNote>
        ) : feeWei === null || feeSnapshot === null ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            {feeLoading && <Spinner />}
            {t('approve.feeLoading')}
          </div>
        ) : (
          <>
            <p className="font-mono text-sm font-semibold tabular-nums text-ink" dir="ltr">
              {formatUnits(feeWei, 18, 8)} {nativeSymbol}
              {feeUsd !== null && <span className="ms-2 font-sans text-xs font-normal text-muted">≈ {formatUsd(feeUsd)}</span>}
            </p>
            <p className="mt-1 font-mono text-[11px] text-muted" dir="ltr">
              {t('approve.feeFormula', { gas: feeSnapshot.gasLimit, gwei })}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

/** personal_sign: декодоване повідомлення + адреса, якою підписуємо. */
function MessageFacts({
  request,
  signer,
}: {
  request: PendingSignRequest;
  signer: string | null;
}) {
  const { t } = useTranslation();
  const raw = typeof request.params[0] === 'string' ? request.params[0] : '';
  const message = decodePersonalSignText(raw);

  return (
    <Card className="animate-rise p-0">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <Eyebrow>{t('approve.factsEyebrow')}</Eyebrow>
        <span className="shrink-0 rounded-full border border-hairline bg-raised px-2.5 py-1 text-[11px] font-semibold text-ink">
          {t('approve.action.signMessage')}
        </span>
      </div>

      <div className="border-b border-hairline px-4 py-3.5">
        <Eyebrow className="mb-1.5">{t('approve.messageLabel')}</Eyebrow>
        <pre
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-raised p-3 font-mono text-[12px] leading-relaxed text-ink"
          dir="ltr"
        >
          {message.text}
        </pre>
        {!message.isText && (
          <p className="mt-2.5 text-xs leading-relaxed text-amber">{t('approve.messageHexNote')}</p>
        )}
      </div>

      <div className="px-4 py-3.5">
        {signer !== null ? (
          <AddressBlock label={t('approve.signerLabel')} address={signer} />
        ) : (
          <>
            <Eyebrow className="mb-1.5">{t('approve.signerLabel')}</Eyebrow>
            <p className="text-xs text-muted">—</p>
          </>
        )}
      </div>
    </Card>
  );
}

/** eth_requestAccounts: яку саме адресу побачить сайт. */
function ConnectFacts({ signer }: { signer: string | null }) {
  const { t } = useTranslation();
  return (
    <Card className="animate-rise p-0">
      <div className="border-b border-hairline px-4 py-3">
        <Eyebrow>{t('approve.factsEyebrow')}</Eyebrow>
      </div>
      <div className="px-4 py-3.5">
        {signer !== null ? (
          <AddressBlock label={t('approve.shareAddressLabel')} address={signer} />
        ) : (
          <>
            <Eyebrow className="mb-1.5">{t('approve.shareAddressLabel')}</Eyebrow>
            <p className="text-xs text-muted">—</p>
          </>
        )}
        <p className="mt-3 text-xs leading-relaxed text-muted">{t('approve.connectHint')}</p>
      </div>
    </Card>
  );
}

/**
 * ПОВНА адреса моноширинним (не скорочена: підміна середини — класика
 * address-poisoning) + копіювання. Групи по 4 символи чергують колір —
 * так очима звіряється й початок, і кінець (патерн Receive/Settings).
 */
function AddressBlock({
  label,
  address,
  danger = false,
}: {
  label: string;
  address: string;
  danger?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      /* clipboard недоступний — адресу видно й вручну */
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  const groups = address.match(/.{1,4}/g) ?? [address];

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? t('receive.copied') : t('receive.copyAddress')}
          title={copied ? t('receive.copied') : t('receive.copyAddress')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink active:scale-95"
        >
          {copied ? <IconCheck size={14} className="text-positive" /> : <IconCopy size={14} />}
        </button>
      </div>
      <p
        className={`break-all font-mono text-[13px] leading-relaxed ${danger ? 'text-danger' : 'text-ink'}`}
        dir="ltr"
      >
        {groups.map((part, index) => (
          <span key={index} className={index % 2 === 1 ? 'opacity-60' : undefined}>
            {part}
          </span>
        ))}
      </p>
    </div>
  );
}
