import {
  decidePersistedApproval,
  decidePersistedTypedApproval,
  getCart,
  getQuote,
  hydrateApprovals,
  hydrateCommerce,
  hydrateQuote,
  loadApproval,
  loadCart,
  loadQuote,
  saveCart,
  saveApproval,
  saveQuote,
  assertDurableQuoteFacts,
  type Cart,
  type ApprovalRequest,
  type FrozenQuote,
} from '@charter/commerce';
import { type Database, type Kysely } from '@charter/db';
import { listCaptures, type LedgerCapture } from '@charter/ledger';
import {
  attributeWebhookEvent,
  hydratePayments,
  loadCheckout,
  loadCheckoutByQuote,
  listGlobalInboxEvents,
  persistProviderTransition,
  quarantineWebhookEvent,
  recordReconciliation,
  recordWebhookIntake,
  resolveCheckoutByOrderId,
  saveCheckout,
  type CheckoutSession,
  type InboxSummary,
  type ReconciliationEvidence,
} from '@charter/payments';

export type MoneyPersist = {
  saveCart(cart: Cart, userId?: string): Promise<void>;
  saveQuote(quote: FrozenQuote): Promise<void>;
  assertQuoteFacts(quote: FrozenQuote): Promise<void>;
  saveCheckout(session: CheckoutSession): Promise<void>;
  saveApproval(approval: ApprovalRequest, requestedBy: string, decidedBy?: string): Promise<void>;
  hydrateApprovals(tenantId: string): Promise<ApprovalRequest[]>;
  hydrateTenant(tenantId: string): Promise<void>;
  loadRegisterSnapshot(tenantId: string): Promise<{
    quotes: FrozenQuote[];
    checkouts: CheckoutSession[];
    approvals: ApprovalRequest[];
  }>;
  loadApproval(tenantId: string, id: string): Promise<ApprovalRequest | undefined>;
  decideApproval(
    tenantId: string,
    id: string,
    decision: 'approved' | 'denied',
    decidedBy: string,
  ): Promise<{ approval: ApprovalRequest; cart: Cart }>;
  decideTypedApproval?(
    tenantId: string,
    id: string,
    decision: 'approved' | 'denied',
    decidedBy: string,
    kind: ApprovalRequest['kind'],
  ): Promise<{ approval: ApprovalRequest }>;
  loadCart(tenantId: string, id: string): Promise<Cart | undefined>;
  loadQuote(tenantId: string, id: string): Promise<FrozenQuote | undefined>;
  loadCheckout(tenantId: string, id: string): Promise<CheckoutSession | undefined>;
  loadCheckoutByQuote?(tenantId: string, quoteId: string): Promise<CheckoutSession | undefined>;
  resolveCheckoutByOrderId(
    orderId: string,
  ): Promise<
    { tenantId: string; session: CheckoutSession; quote: FrozenQuote; cart: Cart } | undefined
  >;
  recordWebhookIntake(input: {
    eventId: string;
    eventType: string;
    payload: unknown;
  }): Promise<'new' | 'duplicate'>;
  attributeWebhook(input: { eventId: string; tenantId: string; orderId: string }): Promise<void>;
  quarantineWebhook(input: { eventId: string; orderId?: string; reason: string }): Promise<void>;
  persistWebhookTransition(session: CheckoutSession): Promise<CheckoutSession>;
  recordReconciliation(session: CheckoutSession, evidence: ReconciliationEvidence): Promise<void>;
  rememberCapture(session: CheckoutSession): Promise<void>;
  listCaptures(tenantId: string): Promise<LedgerCapture[]>;
  listInbox(userId: string): Promise<InboxSummary[]>;
};

export async function persistReconciledCheckout(
  persist:
    | (Pick<MoneyPersist, 'saveCheckout'> & Partial<Pick<MoneyPersist, 'persistWebhookTransition'>>)
    | undefined,
  session: CheckoutSession,
): Promise<void> {
  if (!persist) {
    return;
  }
  await persist.saveCheckout(session);
  const canWriteProviderTransition =
    Boolean(session.paymentId) &&
    (session.providerStatus === 'refunded' ||
      session.providerStatus === 'authorized' ||
      session.providerStatus === 'captured');
  if (!canWriteProviderTransition || !persist.persistWebhookTransition) {
    return;
  }
  try {
    await persist.persistWebhookTransition(session);
  } catch {
    // Identity is already on the checkout row; ledger/transition write is best-effort here.
  }
}

export async function hydrateBoundCheckout(
  persist: Pick<MoneyPersist, 'loadCheckout' | 'loadCheckoutByQuote'> | undefined,
  tenantId: string,
  quote: { id: string; boundCheckoutId: string | null },
): Promise<void> {
  if (!persist) {
    return;
  }
  if (quote.boundCheckoutId) {
    await persist.loadCheckout(tenantId, quote.boundCheckoutId);
    return;
  }
  await persist.loadCheckoutByQuote?.(tenantId, quote.id);
}

export async function bootPersistence(db: Kysely<Database>): Promise<MoneyPersist> {
  const checkoutChain = async (session: CheckoutSession) => {
    const tenantId = session.tenantId;
    const quote = getQuote(session.quoteId) ?? (await loadQuote(db, tenantId, session.quoteId));
    if (!quote || quote.tenantId !== tenantId) {
      throw new Error('CHECKOUT_CHAIN_INCOMPLETE');
    }
    const cart = getCart(quote.cartId) ?? (await loadCart(db, tenantId, quote.cartId));
    if (!cart || cart.tenantId !== tenantId) {
      throw new Error('CHECKOUT_CHAIN_INCOMPLETE');
    }
    return { quote, cart };
  };

  return {
    saveCart: (cart, userId) => saveCart(db, cart, userId),
    saveQuote: (quote) => saveQuote(db, quote),
    assertQuoteFacts: (quote) => assertDurableQuoteFacts(db, quote),
    saveCheckout: async (session) => {
      const { quote } = await checkoutChain(session);
      await saveQuote(db, quote);
      await saveCheckout(db, session.tenantId, session);
    },
    saveApproval: (approval, requestedBy, decidedBy) =>
      saveApproval(db, approval, requestedBy, decidedBy),
    hydrateApprovals: (tenantId) => hydrateApprovals(db, tenantId),
    hydrateTenant: async (tenantId) => {
      await hydrateCommerce(db, tenantId);
      await hydratePayments(db, tenantId);
    },
    loadRegisterSnapshot: async (tenantId) => {
      const [commerce, checkouts, approvals] = await Promise.all([
        hydrateCommerce(db, tenantId),
        hydratePayments(db, tenantId),
        hydrateApprovals(db, tenantId),
      ]);
      return { quotes: commerce.quotes, checkouts, approvals };
    },
    loadApproval: (tenantId, id) => loadApproval(db, tenantId, id),
    decideApproval: (tenantId, id, decision, decidedBy) =>
      decidePersistedApproval(db, {
        tenantId,
        approvalId: id,
        decision,
        decidedBy,
      }),
    decideTypedApproval: (tenantId, id, decision, decidedBy, kind) =>
      decidePersistedTypedApproval(db, {
        tenantId,
        approvalId: id,
        decision,
        decidedBy,
        kind,
      }),
    loadCart: (tenantId, id) => loadCart(db, tenantId, id),
    loadQuote: (tenantId, id) => loadQuote(db, tenantId, id),
    loadCheckout: (tenantId, id) => loadCheckout(db, tenantId, id),
    loadCheckoutByQuote: (tenantId, quoteId) => loadCheckoutByQuote(db, tenantId, quoteId),
    resolveCheckoutByOrderId: async (orderId) => {
      const resolved = await resolveCheckoutByOrderId(db, orderId);
      if (!resolved) {
        return undefined;
      }
      const { quote, cart } = await checkoutChain(resolved.session);
      return { ...resolved, quote, cart };
    },
    recordWebhookIntake: (input) =>
      recordWebhookIntake(db, {
        provider: 'razorpay',
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload,
      }),
    attributeWebhook: (input) =>
      attributeWebhookEvent(db, {
        provider: 'razorpay',
        eventId: input.eventId,
        tenantId: input.tenantId,
        orderId: input.orderId,
      }),
    quarantineWebhook: (input) =>
      quarantineWebhookEvent(db, {
        provider: 'razorpay',
        eventId: input.eventId,
        ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
        reason: input.reason,
      }),
    persistWebhookTransition: async (session) => {
      const persisted = await persistProviderTransition(db, session);
      const quote = await loadQuote(db, persisted.tenantId, persisted.quoteId);
      if (quote) {
        hydrateQuote(quote);
      }
      return persisted;
    },
    recordReconciliation: (session, evidence) => recordReconciliation(db, session, evidence),
    rememberCapture: async (session) => {
      if (session.status !== 'SETTLED') {
        return;
      }
      await persistProviderTransition(db, session);
    },
    listCaptures: (tenantId) => listCaptures(db, tenantId),
    listInbox: (userId) => listGlobalInboxEvents(db, userId),
  };
}
