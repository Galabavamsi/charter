// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../account';
import type { ApiClient } from '../api';
import type { MerchantRules, MerchantRulesPreview } from '../merchant-api';
import { MerchantRulesPage } from './merchant-rules';

vi.mock('../merchant-context', () => ({
  useMerchantShop: () => ({
    tenantId: 'northstar-demo-in',
    slug: 'northstar',
    name: 'Northstar',
    label: 'Northstar',
    blurb: 'Trail coffee.',
    currency: 'INR' as const,
    status: 'published' as const,
    synthetic: true,
    role: 'owner' as const,
  }),
}));

const rules: MerchantRules = {
  version: 3,
  hardCapMinor: '300000',
  hardCapDisplay: '₹3,000.00',
  autonomousCapMinor: '200000',
  autonomousCapDisplay: '₹2,000.00',
  forbiddenMaterials: ['glass'],
  offers: [
    {
      id: 'kit.travel',
      discountMinor: '10000',
      discountDisplay: '₹100.00',
      requiredSkuGroups: [['brewer.trailpress-steel-750', 'grinder.pocket-lite']],
      stackable: false,
      marginFloorMinor: '180000',
      budgetRemainingMinor: '40000',
      maxRedemptions: 5,
      redemptions: 2,
      expiresAt: '2099-12-31T00:00:00.000Z',
    },
  ],
};

const preview: MerchantRulesPreview = { version: 3, items: [] };

afterEach(() => {
  cleanup();
});

describe('Merchant rules offer authoring', () => {
  it('lets an evaluator set stack, margin, budget, frequency, and expiry and republishes them', async () => {
    const user = userEvent.setup();
    let published: Record<string, unknown> | undefined;
    const api: ApiClient = vi.fn(async (path, init) => {
      if (path.endsWith('/rules/preview')) {
        return preview as never;
      }
      if (init?.method === 'PUT') {
        published = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { ...rules, version: 4 } as never;
      }
      return rules as never;
    });

    render(
      <ApiProvider client={api}>
        <MerchantRulesPage />
      </ApiProvider>,
    );

    const stackable = await screen.findByRole('checkbox', { name: /stackable/i });
    const margin = screen.getByLabelText(/margin floor in inr/i);
    const budget = screen.getByLabelText(/budget remaining in inr/i);
    const frequency = screen.getByLabelText(/max redemptions/i);
    const expiry = screen.getByLabelText(/expires at/i);

    expect(stackable).not.toBeChecked();
    expect(margin).toHaveValue('1800.00');
    expect(budget).toHaveValue('400.00');
    expect(frequency).toHaveValue(5);
    expect(expiry).toHaveValue('2099-12-31T00:00:00.000Z');

    await user.click(stackable);
    await user.clear(margin);
    await user.type(margin, '1500.00');
    await user.clear(budget);
    await user.type(budget, '250.50');
    await user.clear(frequency);
    await user.type(frequency, '8');
    await user.clear(expiry);
    await user.type(expiry, '2099-06-01T00:00:00.000Z');
    await user.click(screen.getByRole('button', { name: /publish rules/i }));

    await waitFor(() => {
      expect(published).toBeDefined();
    });
    expect(published).toMatchObject({
      expectedVersion: 3,
      offers: [
        {
          id: 'kit.travel',
          discount: '100.00',
          requiredSkuGroups: [['brewer.trailpress-steel-750', 'grinder.pocket-lite']],
          stackable: true,
          marginFloorMinor: '150000',
          budgetRemainingMinor: '25050',
          maxRedemptions: 8,
          redemptions: 2,
          expiresAt: '2099-06-01T00:00:00.000Z',
        },
      ],
    });
  });
});
