import { beforeEach, describe, expect, it } from 'vitest';
import {
  decideTypedApproval,
  openTypedApproval,
  resetApprovals,
  serializeApproval,
} from './approval.js';
import { buildCanonicalKit, getCart, resetKernel } from './kernel.js';

describe('typed approval decisions', () => {
  beforeEach(() => {
    resetKernel();
    resetApprovals();
  });

  it('decides catalog, refund, and campaign kinds without mutating the cart', () => {
    const { cart } = buildCanonicalKit();
    const originalLines = cart.lines.map((line) => ({ ...line }));
    const catalog = openTypedApproval({
      kind: 'catalog_publish',
      tenantId: cart.tenantId,
      resourceId: '94000000-0000-4000-8000-000000000001',
      resourceVersion: 1,
      amountMinor: 0n,
      reason: 'CATALOG_PUBLISH_APPROVAL_REQUIRED',
      requestedBy: '02000000-0000-4000-8000-000000000001',
    });
    const refund = openTypedApproval({
      kind: 'refund',
      tenantId: cart.tenantId,
      resourceId: '92000000-0000-4000-8000-000000000001',
      resourceVersion: 1,
      amountMinor: 99900n,
      reason: 'REFUND_APPROVAL_REQUIRED',
      requestedBy: '02000000-0000-4000-8000-000000000001',
    });
    const campaign = openTypedApproval({
      kind: 'campaign',
      tenantId: cart.tenantId,
      resourceId: 'offer.travel-kit',
      resourceVersion: 2,
      amountMinor: 50000n,
      reason: 'CAMPAIGN_APPROVAL_REQUIRED',
      requestedBy: '02000000-0000-4000-8000-000000000001',
    });

    const decidedCatalog = decideTypedApproval(catalog.id, 'approved', {
      decidedBy: '02000000-0000-4000-8000-000000000002',
      shopRole: 'catalog',
    });
    const decidedRefund = decideTypedApproval(refund.id, 'denied', {
      decidedBy: '02000000-0000-4000-8000-000000000003',
      shopRole: 'finance',
    });
    const decidedCampaign = decideTypedApproval(campaign.id, 'approved', {
      decidedBy: '02000000-0000-4000-8000-000000000002',
      shopRole: 'admin',
    });

    expect(decidedCatalog.status).toBe('approved');
    expect(decidedRefund.status).toBe('denied');
    expect(decidedCampaign.status).toBe('approved');
    expect(getCart(cart.id)?.lines).toEqual(originalLines);
    expect(serializeApproval(decidedRefund)).toMatchObject({
      kind: 'refund',
      resourceId: refund.resourceId,
    });
  });

  it('rejects self-decision, stale hash, amount drift, and cross-kind reuse', () => {
    const approval = openTypedApproval({
      kind: 'catalog_publish',
      tenantId: 'northstar-demo-in',
      resourceId: 'product-1',
      resourceVersion: 1,
      amountMinor: 0n,
      reason: 'CATALOG_PUBLISH_APPROVAL_REQUIRED',
      requestedBy: '02000000-0000-4000-8000-000000000001',
    });
    expect(() =>
      decideTypedApproval(approval.id, 'approved', {
        decidedBy: '02000000-0000-4000-8000-000000000001',
        shopRole: 'catalog',
      }),
    ).toThrow('APPROVAL_SELF_DECISION');

    const stale = openTypedApproval({
      kind: 'refund',
      tenantId: 'northstar-demo-in',
      resourceId: 'order-1',
      resourceVersion: 1,
      amountMinor: 99900n,
      reason: 'REFUND_APPROVAL_REQUIRED',
      requestedBy: '02000000-0000-4000-8000-000000000001',
    });
    stale.resourceId = 'order-changed';
    expect(() =>
      decideTypedApproval(stale.id, 'approved', {
        decidedBy: '02000000-0000-4000-8000-000000000003',
        shopRole: 'finance',
      }),
    ).toThrow('APPROVAL_STALE');

    const drifted = openTypedApproval({
      kind: 'campaign',
      tenantId: 'northstar-demo-in',
      resourceId: 'offer-1',
      resourceVersion: 1,
      amountMinor: 50000n,
      reason: 'CAMPAIGN_APPROVAL_REQUIRED',
      requestedBy: '02000000-0000-4000-8000-000000000001',
    });
    drifted.proposedTotalMinor = 60000n;
    expect(() =>
      decideTypedApproval(drifted.id, 'approved', {
        decidedBy: '02000000-0000-4000-8000-000000000002',
        shopRole: 'admin',
      }),
    ).toThrow('APPROVAL_AMOUNT_CHANGED');

    const catalog = openTypedApproval({
      kind: 'catalog_publish',
      tenantId: 'northstar-demo-in',
      resourceId: 'product-2',
      resourceVersion: 1,
      amountMinor: 0n,
      reason: 'CATALOG_PUBLISH_APPROVAL_REQUIRED',
      requestedBy: '02000000-0000-4000-8000-000000000001',
    });
    expect(() =>
      decideTypedApproval(catalog.id, 'approved', {
        decidedBy: '02000000-0000-4000-8000-000000000003',
        shopRole: 'finance',
        expectedKind: 'refund',
      }),
    ).toThrow('APPROVAL_KIND_MISMATCH');
  });
});
