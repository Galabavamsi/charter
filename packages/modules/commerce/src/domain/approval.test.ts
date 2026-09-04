import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateMerchantCache, resetCreatedMerchants } from '@charter/catalog';
import { openApproval, resetApprovals, serializeApproval } from './approval.js';

describe('approval catalog labels', () => {
  beforeEach(() => {
    resetApprovals();
    resetCreatedMerchants();
  });

  it('resolves approval titles from the approval tenant', () => {
    hydrateMerchantCache({
      tenantId: 'approval-tenant-in',
      slug: 'approval-tenant',
      name: 'Approval Tenant',
      label: 'Approval Tenant',
      blurb: '',
      synthetic: true,
      currency: 'INR',
      variants: [
        {
          sku: 'grinder.pocket-lite',
          title: 'Tenant Lite Grinder',
          priceMinor: 10000n,
          stock: 1,
          material: 'steel',
          published: true,
        },
        {
          sku: 'grinder.pocket-pro',
          title: 'Tenant Pro Grinder',
          priceMinor: 20000n,
          stock: 1,
          material: 'steel',
          published: true,
        },
      ],
      authority: {
        hardCapMinor: 50000n,
        autonomousCapMinor: 10000n,
        forbiddenMaterials: [],
      },
      offers: [],
    });

    const approval = openApproval({
      tenantId: 'approval-tenant-in',
      cartId: '84000000-0000-4000-8000-000000000099',
      fromSku: 'grinder.pocket-lite',
      toSku: 'grinder.pocket-pro',
      proposedTotalMinor: 20000n,
      proposedDisplay: '₹200.00',
      decision: {
        outcome: 'require_approval',
        reason: 'AUTHORITY_APPROVAL_REQUIRED',
        message: 'Approval required',
      },
    });

    expect(approval.fromTitle).toBe('Tenant Lite Grinder');
    expect(approval.toTitle).toBe('Tenant Pro Grinder');
    expect(serializeApproval(approval)).toMatchObject({
      kind: 'cart_spend',
      actionHash: approval.actionHash,
    });
  });
});
