import { getCart, getQuote, type FrozenQuote } from '@charter/commerce';
import { hydrateCheckout, type CheckoutSession } from '@charter/payments';
import type { MoneyPersist } from '../persist.js';
import type { MemoryTenantRepository } from '../testing/memory-tenant-repository.js';

function upsertMerchantQuote(repository: MemoryTenantRepository, quote: FrozenQuote): void {
  const rows = repository.state.merchantQuotes.get(quote.tenantId) ?? [];
  const next = {
    id: quote.id,
    status: quote.status,
    createdAt: new Date().toISOString(),
    subtotalMinor: quote.subtotalMinor.toString(),
    discountMinor: quote.discountMinor.toString(),
    totalMinor: quote.totalMinor.toString(),
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      unitMinor: line.unitMinor.toString(),
      lineMinor: line.lineMinor.toString(),
    })),
  };
  const index = rows.findIndex((row) => row.id === quote.id);
  if (index >= 0) {
    rows[index] = { ...rows[index], ...next };
  } else {
    rows.push(next);
  }
  repository.state.merchantQuotes.set(quote.tenantId, rows);
}

function upsertMerchantOrder(
  repository: MemoryTenantRepository,
  session: CheckoutSession,
  extra: { capturedAt?: string | null } = {},
): void {
  const now = new Date().toISOString();
  const quote = getQuote(session.quoteId);
  if (quote) {
    upsertMerchantQuote(repository, quote);
  }
  const rows = repository.state.merchantOrders.get(session.tenantId) ?? [];
  const existing = rows.find((row) => row.id === session.id);
  const next = {
    id: session.id,
    quoteId: session.quoteId,
    receipt: session.receipt,
    razorpayOrderId: session.razorpayOrderId,
    amountMinor: String(session.amountMinor),
    status: session.status,
    paymentId: session.paymentId,
    providerStatus: session.providerStatus,
    copy: session.copy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    capturedAt:
      extra.capturedAt !== undefined
        ? extra.capturedAt
        : session.status === 'SETTLED' && session.providerStatus === 'captured'
          ? (existing?.capturedAt ?? now)
          : (existing?.capturedAt ?? null),
    recovered: existing?.recovered ?? false,
    transitions: existing?.transitions ?? [],
  };
  if (existing) {
    Object.assign(existing, next);
  } else {
    rows.push(next);
  }
  repository.state.merchantOrders.set(session.tenantId, rows);
}

export function createHarnessMoneyPersist(repository: MemoryTenantRepository): MoneyPersist {
  const checkouts = new Map<string, CheckoutSession>();
  return {
    async saveCart() {},
    async saveQuote(quote) {
      upsertMerchantQuote(repository, quote);
    },
    async assertQuoteFacts() {},
    async saveCheckout(session) {
      checkouts.set(session.id, { ...session });
      upsertMerchantOrder(repository, session);
    },
    async saveApproval() {},
    async hydrateApprovals() {
      return [];
    },
    async hydrateTenant() {},
    async loadRegisterSnapshot() {
      return {
        quotes: [],
        checkouts: [...checkouts.values()].map((row) => ({ ...row })),
        approvals: [],
      };
    },
    async loadApproval() {
      return undefined;
    },
    async decideApproval() {
      throw new Error('HARNESS_APPROVAL_UNSUPPORTED');
    },
    async loadCart(tenantId, id) {
      const cart = getCart(id);
      return cart?.tenantId === tenantId ? cart : undefined;
    },
    async loadQuote(tenantId, id) {
      const quote = getQuote(id);
      return quote?.tenantId === tenantId ? quote : undefined;
    },
    async loadCheckout(tenantId, id) {
      const session = checkouts.get(id);
      if (!session || session.tenantId !== tenantId) {
        return undefined;
      }
      return hydrateCheckout({ ...session });
    },
    async loadCheckoutByQuote(tenantId, quoteId) {
      const session = [...checkouts.values()].find(
        (row) => row.tenantId === tenantId && row.quoteId === quoteId,
      );
      return session ? hydrateCheckout({ ...session }) : undefined;
    },
    async resolveCheckoutByOrderId() {
      return undefined;
    },
    async recordWebhookIntake() {
      return 'new';
    },
    async attributeWebhook() {},
    async quarantineWebhook() {},
    async persistWebhookTransition(session) {
      checkouts.set(session.id, { ...session });
      upsertMerchantOrder(repository, session);
      return session;
    },
    async recordReconciliation() {},
    async rememberCapture(session) {
      if (session.status !== 'SETTLED') {
        return;
      }
      checkouts.set(session.id, { ...session });
      upsertMerchantOrder(repository, session, { capturedAt: new Date().toISOString() });
    },
    async listCaptures() {
      return [];
    },
    async listInbox() {
      return [];
    },
  };
}
