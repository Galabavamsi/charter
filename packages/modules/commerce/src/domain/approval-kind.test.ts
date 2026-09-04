import { describe, expect, it } from 'vitest';
import {
  assertApprovalDecision,
  canDecideApprovalKind,
  cartSpendActionHash,
  typedActionHash,
} from './approval-kind.js';

describe('typed approval authorization', () => {
  const binding = {
    actionHash: 'cart_spend:tenant:cart:from:to:20000:INR',
    liveActionHash: 'cart_spend:tenant:cart:from:to:20000:INR',
    amountMinor: 20000n,
    liveAmountMinor: 20000n,
    currency: 'INR',
    liveCurrency: 'INR',
    decidedBy: '02000000-0000-4000-8000-000000000002',
    requestedBy: '02000000-0000-4000-8000-000000000001',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };

  it.each([
    ['cart_spend', 'owner', true],
    ['cart_spend', 'admin', true],
    ['cart_spend', 'catalog', false],
    ['cart_spend', 'finance', false],
    ['cart_spend', 'viewer', false],
    ['catalog_publish', 'catalog', true],
    ['catalog_publish', 'finance', false],
    ['refund', 'finance', true],
    ['refund', 'catalog', false],
    ['campaign', 'admin', true],
    ['campaign', 'support', false],
    ['platform', 'owner', false],
  ] as const)('maps %s + %s to %s', (kind, shopRole, allowed) => {
    expect(canDecideApprovalKind({ kind, shopRole })).toBe(allowed);
  });

  it('allows platform operators only for platform approvals', () => {
    expect(canDecideApprovalKind({ kind: 'platform', platformRoles: ['operator'] })).toBe(true);
    expect(canDecideApprovalKind({ kind: 'platform', shopRole: 'owner' })).toBe(false);
    expect(canDecideApprovalKind({ kind: 'cart_spend', platformRoles: ['operator'] })).toBe(false);
  });

  it('rejects self-approval, expiry, stale hash, and amount drift', () => {
    expect(() =>
      assertApprovalDecision({
        ...binding,
        kind: 'cart_spend',
        shopRole: 'owner',
        decidedBy: binding.requestedBy!,
      }),
    ).toThrow('APPROVAL_SELF_DECISION');
    expect(() =>
      assertApprovalDecision({
        ...binding,
        kind: 'cart_spend',
        shopRole: 'owner',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    ).toThrow('APPROVAL_EXPIRED');
    expect(() =>
      assertApprovalDecision({
        ...binding,
        kind: 'cart_spend',
        shopRole: 'owner',
        liveActionHash: 'different',
      }),
    ).toThrow('APPROVAL_STALE');
    expect(() =>
      assertApprovalDecision({
        ...binding,
        kind: 'cart_spend',
        shopRole: 'owner',
        liveAmountMinor: 21000n,
      }),
    ).toThrow('APPROVAL_AMOUNT_CHANGED');
    expect(() =>
      assertApprovalDecision({
        ...binding,
        kind: 'refund',
        shopRole: 'catalog',
      }),
    ).toThrow('APPROVAL_ROLE_DENIED');
  });

  it('pins cart spend facts into a deterministic action hash', () => {
    expect(
      cartSpendActionHash({
        tenantId: 'tenant',
        cartId: 'cart',
        fromSku: 'from',
        toSku: 'to',
        amountMinor: 20000n,
        currency: 'INR',
      }),
    ).toBe('cart_spend:tenant:cart:from:to:20000:INR');
  });

  it.each([
    [
      'catalog_publish',
      'catalog_publish:tenant:product-1:3:0:INR',
      { resourceId: 'product-1', resourceVersion: 3, amountMinor: 0n },
    ],
    [
      'refund',
      'refund:tenant:order-1:1:99900:INR',
      { resourceId: 'order-1', resourceVersion: 1, amountMinor: 99900n },
    ],
    [
      'campaign',
      'campaign:tenant:offer-1:2:50000:INR',
      { resourceId: 'offer-1', resourceVersion: 2, amountMinor: 50000n },
    ],
  ] as const)('pins %s facts into a deterministic action hash', (kind, expected, facts) => {
    expect(
      typedActionHash({
        kind,
        tenantId: 'tenant',
        resourceId: facts.resourceId,
        resourceVersion: facts.resourceVersion,
        amountMinor: facts.amountMinor,
        currency: 'INR',
      }),
    ).toBe(expected);
  });
});
