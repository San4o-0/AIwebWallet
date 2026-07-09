/**
 * Локальна евристика ризику й пояснення для екрана підпису dApp (Approve).
 *
 * Це НЕ мок-дані рахунку (баланси/історія/аналітика тут відсутні — вони йдуть
 * тільки з бекенду або показують стан помилки). Це degraded-режим безпеки:
 * коли бекенд не має ендпоінта для методу (personal_sign, eth_requestAccounts)
 * або тимчасово недоступний, гаманець усе одно оцінює запит на підпис локально,
 * інакше кнопку підпису неможливо розблокувати. Реальний rule-based скоринг —
 * на бекенді (risk-engine, ТЗ F5.1–F5.5).
 */
import { sharedT as t } from './i18n-bridge';
import type { Json, PendingSignRequest } from './messaging';
import type { RiskResult } from './api-types';

export function mockRiskForRequest(request: PendingSignRequest): RiskResult {
  if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') {
    return {
      level: 'low',
      reasons: [t('mock.risk.connect')],
    };
  }
  if (request.method === 'personal_sign') {
    return {
      level: 'medium',
      reasons: [t('mock.risk.personalSign1'), t('mock.risk.personalSign2')],
    };
  }
  // eth_sendTransaction
  const tx = request.params[0];
  const data =
    typeof tx === 'object' && tx !== null && !Array.isArray(tx)
      ? (tx as Record<string, Json>)['data']
      : undefined;
  if (typeof data === 'string' && data.startsWith('0x095ea7b3')) {
    return {
      level: 'high',
      reasons: [
        t('mock.risk.approveUnlimited1'),
        t('mock.risk.approveUnlimited2'),
        t('mock.risk.approveUnlimited3'),
      ],
    };
  }
  if (typeof data === 'string' && data.length > 2) {
    return {
      level: 'medium',
      reasons: [t('mock.risk.unknownCall1'), t('mock.risk.unknownCall2')],
    };
  }
  return {
    level: 'low',
    reasons: [t('mock.risk.simpleTransfer')],
  };
}

/** Локальне пояснення підпису (реальне — POST /v1/tx/explain). */
export function mockExplainForRequest(request: PendingSignRequest): string {
  switch (request.method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return t('mock.explain.connect', { origin: request.origin });
    case 'personal_sign':
      return t('mock.explain.personalSign', { origin: request.origin });
    case 'eth_sendTransaction': {
      const risk = mockRiskForRequest(request);
      if (risk.level === 'high') {
        return t('mock.explain.approveHigh', { origin: request.origin });
      }
      if (risk.level === 'medium') {
        return t('mock.explain.contractMedium', { origin: request.origin });
      }
      return t('mock.explain.transferLow');
    }
    case 'eth_chainId':
      return t('mock.explain.chainId');
  }
}
