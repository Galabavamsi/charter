import { randomUUID } from 'node:crypto';
import {
  sql,
  withMachineTenant,
  withUserContext,
  withWebhookContext,
  type Database,
  type Kysely,
  type Transaction,
} from '@charter/db';
import { hydrateCheckout, type CheckoutSession, type CheckoutStatus } from '../domain/index.js';
import type { ReconciliationEvidence } from '../domain/reconcile.js';

const providerTransitionRanks: Record<string, number> = {
  failed: 1,
  authorized: 2,
  captured: 3,
  refunded: 4,
};

function expectedCheckoutStatusForProvider(
  incomingProviderStatus: string,
): CheckoutSession['status'] | undefined {
  if (incomingProviderStatus === 'failed') {
    return 'FAILED_PROVISIONAL';
  }
  if (incomingProviderStatus === 'authorized') {
    return 'CAPTURE_PENDING';
  }
  if (incomingProviderStatus === 'captured') {
    return 'SETTLED';
  }
  if (incomingProviderStatus === 'refunded') {
    return 'RECONCILING';
  }
  return undefined;
}

export function shouldApplyProviderTransition(
  currentProviderStatus: string | null,
  incomingProviderStatus: string,
): boolean {
  return (
    (providerTransitionRanks[incomingProviderStatus] ?? 0) >=
    (providerTransitionRanks[currentProviderStatus ?? ''] ?? 0)
  );
}

export async function saveCheckout(
  db: Kysely<Database>,
  tenantId: string,
  session: CheckoutSession,
): Promise<void> {
  if (session.tenantId !== tenantId) {
    throw new Error('CHECKOUT_TENANT_MISMATCH');
  }
  await withMachineTenant(db, tenantId, async (trx) => {
    await trx
      .withSchema('payments')
      .insertInto('checkout_sessions')
      .values({
        id: session.id,
        tenant_id: tenantId,
        quote_id: session.quoteId,
        receipt: session.receipt,
        razorpay_order_id: session.razorpayOrderId,
        amount_minor: session.amountMinor,
        currency: session.currency,
        status: session.status,
        payment_id: session.paymentId,
        provider_status: session.providerStatus,
        copy: session.copy,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('id')
          .doUpdateSet({
            status: session.status,
            payment_id:
              session.paymentId == null
                ? sql<string | null>`checkout_sessions.payment_id`
                : session.paymentId,
            provider_status: session.providerStatus,
            copy: session.copy,
            updated_at: new Date(),
          })
          .where('checkout_sessions.tenant_id', '=', tenantId),
      )
      .execute();
  });
}

export async function loadCheckout(
  db: Kysely<Database>,
  tenantId: string,
  checkoutId: string,
): Promise<CheckoutSession | undefined> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const row = await trx
      .withSchema('payments')
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', checkoutId)
      .executeTakeFirst();
    return row ? hydrateCheckout(fromCheckoutRow(row)) : undefined;
  });
}

export async function loadCheckoutByQuote(
  db: Kysely<Database>,
  tenantId: string,
  quoteId: string,
): Promise<CheckoutSession | undefined> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const row = await trx
      .withSchema('payments')
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('quote_id', '=', quoteId)
      .executeTakeFirst();
    return row ? hydrateCheckout(fromCheckoutRow(row)) : undefined;
  });
}

export async function loadCheckoutByOrderId(
  db: Kysely<Database>,
  tenantId: string,
  orderId: string,
): Promise<CheckoutSession | undefined> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const row = await trx
      .withSchema('payments')
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('razorpay_order_id', '=', orderId)
      .executeTakeFirst();
    return row ? hydrateCheckout(fromCheckoutRow(row)) : undefined;
  });
}

export async function resolveCheckoutByOrderId(
  db: Kysely<Database>,
  orderId: string,
): Promise<{ tenantId: string; session: CheckoutSession } | undefined> {
  const resolution = await withWebhookContext(db, undefined, async (trx) => {
    const result = await sql<{ tenant_id: string; checkout_id: string }>`
      select tenant_id, checkout_id
      from app_private.resolve_webhook_checkout_by_order(${orderId})
    `.execute(trx);
    return result.rows[0];
  });
  if (!resolution) {
    return undefined;
  }
  const session = await loadCheckout(db, resolution.tenant_id, resolution.checkout_id);
  if (!session || session.razorpayOrderId !== orderId) {
    throw new Error('WEBHOOK_CHECKOUT_RESOLUTION_MISMATCH');
  }
  return { tenantId: resolution.tenant_id, session };
}

export async function hydratePayments(
  db: Kysely<Database>,
  tenantId: string,
): Promise<CheckoutSession[]> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const rows = await trx
      .withSchema('payments')
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map((row) => hydrateCheckout(fromCheckoutRow(row)));
  });
}

export async function persistProviderTransition(
  db: Kysely<Database>,
  session: CheckoutSession,
): Promise<CheckoutSession> {
  const incomingProviderStatus = session.providerStatus;
  const expectedCheckoutStatus = expectedCheckoutStatusForProvider(incomingProviderStatus ?? '');
  if (
    !incomingProviderStatus ||
    !expectedCheckoutStatus ||
    session.status !== expectedCheckoutStatus ||
    !session.paymentId
  ) {
    throw new Error('WEBHOOK_TRANSITION_EVIDENCE_INVALID');
  }

  return withMachineTenant(db, session.tenantId, async (trx) => {
    const current = await trx
      .withSchema('payments')
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('tenant_id', '=', session.tenantId)
      .where('id', '=', session.id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) {
      throw new Error('CHECKOUT_NOT_FOUND');
    }
    if (
      current.quote_id !== session.quoteId ||
      current.razorpay_order_id !== session.razorpayOrderId
    ) {
      throw new Error('WEBHOOK_CHECKOUT_IDENTITY_MISMATCH');
    }

    const currentProviderStatus =
      current.status === 'SETTLED'
        ? 'captured'
        : current.status === 'CAPTURE_PENDING'
          ? 'authorized'
          : current.status === 'FAILED_PROVISIONAL'
            ? 'failed'
            : current.provider_status;
    let persisted = current;
    const applyIncoming = incomingProviderStatus === 'refunded' || current.status !== 'SETTLED';
    if (
      applyIncoming &&
      shouldApplyProviderTransition(currentProviderStatus, incomingProviderStatus)
    ) {
      const updated = await trx
        .withSchema('payments')
        .updateTable('checkout_sessions')
        .set({
          status: expectedCheckoutStatus,
          payment_id: session.paymentId,
          provider_status: incomingProviderStatus,
          copy: session.copy,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', session.tenantId)
        .where('id', '=', session.id)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        throw new Error('CHECKOUT_TRANSITION_NOT_PERSISTED');
      }
      persisted = updated;
    }

    if (persisted.status === 'SETTLED') {
      const settledQuote = await trx
        .withSchema('commerce')
        .updateTable('quotes')
        .set({ status: 'SETTLED' })
        .where('tenant_id', '=', persisted.tenant_id)
        .where('id', '=', persisted.quote_id)
        .where('bound_checkout_id', '=', persisted.id)
        .where('status', 'in', ['BOUND', 'SETTLED'])
        .returning('id')
        .executeTakeFirst();
      if (!settledQuote) {
        throw new Error('CHECKOUT_QUOTE_NOT_SETTLED');
      }
      await trx
        .withSchema('ledger')
        .insertInto('ledger_entries')
        .values({
          id: randomUUID(),
          tenant_id: persisted.tenant_id,
          checkout_id: persisted.id,
          quote_id: persisted.quote_id,
          kind: 'capture',
          amount_minor: String(persisted.amount_minor),
          currency: persisted.currency,
          provider_payment_id: persisted.payment_id,
          created_at: new Date(),
        })
        .onConflict((conflict) =>
          conflict.columns(['tenant_id', 'checkout_id', 'kind']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
    }

    if (incomingProviderStatus === 'refunded' && persisted.provider_status === 'refunded') {
      await trx
        .withSchema('commerce')
        .updateTable('quotes')
        .set({ status: 'BOUND' })
        .where('tenant_id', '=', persisted.tenant_id)
        .where('id', '=', persisted.quote_id)
        .where('bound_checkout_id', '=', persisted.id)
        .where('status', '=', 'SETTLED')
        .execute();
      await trx
        .withSchema('ledger')
        .insertInto('ledger_entries')
        .values({
          id: randomUUID(),
          tenant_id: persisted.tenant_id,
          checkout_id: persisted.id,
          quote_id: persisted.quote_id,
          kind: 'refund',
          amount_minor: String(persisted.amount_minor),
          currency: persisted.currency,
          provider_payment_id: persisted.payment_id,
          created_at: new Date(),
        })
        .onConflict((conflict) =>
          conflict.columns(['tenant_id', 'checkout_id', 'kind']).doNothing(),
        )
        .execute();
    }

    await insertPaymentTransition(trx, {
      tenantId: session.tenantId,
      checkoutId: session.id,
      source: 'webhook',
      providerReference: session.paymentId ?? session.razorpayOrderId,
      observedProviderStatus: incomingProviderStatus,
      fromCheckoutStatus: current.status,
      toCheckoutStatus: persisted.status,
      applied:
        persisted.status !== current.status || persisted.provider_status !== currentProviderStatus,
      occurredAt: new Date(),
      correlationId: session.paymentId ?? session.razorpayOrderId,
      evidence: {
        orderId: session.razorpayOrderId,
        paymentId: session.paymentId,
      },
    });

    return hydrateCheckout(fromCheckoutRow(persisted));
  });
}

export type PaymentTransitionRecord = {
  id: string;
  source: string;
  providerReference: string;
  observedProviderStatus: string;
  fromCheckoutStatus: string | null;
  toCheckoutStatus: string;
  applied: boolean;
  occurredAt: string;
  observedAt: string;
  correlationId: string;
};

async function insertPaymentTransition(
  trx: Kysely<Database> | Transaction<Database>,
  input: {
    tenantId: string;
    checkoutId: string;
    source: string;
    providerReference: string;
    observedProviderStatus: string;
    fromCheckoutStatus: string | null;
    toCheckoutStatus: string;
    applied: boolean;
    occurredAt: Date;
    correlationId: string;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    insert into payments.payment_transitions (
      id,
      tenant_id,
      checkout_id,
      source,
      provider_reference,
      observed_provider_status,
      from_checkout_status,
      to_checkout_status,
      applied,
      occurred_at,
      observed_at,
      correlation_id,
      evidence
    )
    values (
      ${randomUUID()}::uuid,
      ${input.tenantId},
      ${input.checkoutId}::uuid,
      ${input.source},
      ${input.providerReference},
      ${input.observedProviderStatus},
      ${input.fromCheckoutStatus},
      ${input.toCheckoutStatus},
      ${input.applied},
      ${input.occurredAt.toISOString()}::timestamptz,
      now(),
      ${input.correlationId},
      ${JSON.stringify(input.evidence)}::jsonb
    )
    on conflict (
      tenant_id,
      checkout_id,
      source,
      provider_reference,
      observed_provider_status
    )
    do nothing
  `.execute(trx);
}

export async function recordReconciliation(
  db: Kysely<Database>,
  session: CheckoutSession,
  evidence: ReconciliationEvidence,
): Promise<void> {
  await withMachineTenant(db, session.tenantId, async (trx) => {
    const current = await trx
      .withSchema('payments')
      .selectFrom('checkout_sessions')
      .select(['status'])
      .where('tenant_id', '=', session.tenantId)
      .where('id', '=', session.id)
      .executeTakeFirst();
    await sql`
      insert into payments.reconciliation_snapshots (
        tenant_id,
        checkout_id,
        quote_id,
        order_id,
        order_status,
        outcome,
        payment_attempts,
        reconciled_at,
        correlation_id
      )
      values (
        ${session.tenantId},
        ${session.id}::uuid,
        ${session.quoteId}::uuid,
        ${evidence.orderId},
        ${evidence.orderStatus},
        ${evidence.outcome},
        ${JSON.stringify(evidence.paymentAttempts)}::jsonb,
        ${evidence.reconciledAt}::timestamptz,
        ${session.razorpayOrderId}
      )
      on conflict (tenant_id, checkout_id)
      do update set
        quote_id = excluded.quote_id,
        order_id = excluded.order_id,
        order_status = excluded.order_status,
        outcome = excluded.outcome,
        payment_attempts = excluded.payment_attempts,
        reconciled_at = excluded.reconciled_at,
        correlation_id = excluded.correlation_id,
        updated_at = now()
    `.execute(trx);
    await insertPaymentTransition(trx, {
      tenantId: session.tenantId,
      checkoutId: session.id,
      source: 'provider_read',
      providerReference: `${evidence.orderId}:${evidence.outcome}`,
      observedProviderStatus: evidence.outcome,
      fromCheckoutStatus: current?.status ?? session.status,
      toCheckoutStatus: session.status,
      applied: true,
      occurredAt: new Date(evidence.reconciledAt),
      correlationId: session.razorpayOrderId,
      evidence: {
        orderId: evidence.orderId,
        orderStatus: evidence.orderStatus,
        outcome: evidence.outcome,
        attemptCount: evidence.paymentAttempts.length,
      },
    });
  });
}

export async function listPaymentTransitions(
  db: Kysely<Database>,
  tenantId: string,
  checkoutId: string,
): Promise<PaymentTransitionRecord[]> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const result = await sql<{
      id: string;
      source: string;
      provider_reference: string;
      observed_provider_status: string;
      from_checkout_status: string | null;
      to_checkout_status: string;
      applied: boolean;
      occurred_at: Date;
      observed_at: Date;
      correlation_id: string;
    }>`
      select id,
             source,
             provider_reference,
             observed_provider_status,
             from_checkout_status,
             to_checkout_status,
             applied,
             occurred_at,
             observed_at,
             correlation_id
      from payments.payment_transitions
      where tenant_id = ${tenantId}
        and checkout_id = ${checkoutId}::uuid
      order by observed_at, id
    `.execute(trx);
    return result.rows.map((row) => ({
      id: row.id,
      source: row.source,
      providerReference: row.provider_reference,
      observedProviderStatus: row.observed_provider_status,
      fromCheckoutStatus: row.from_checkout_status,
      toCheckoutStatus: row.to_checkout_status,
      applied: row.applied,
      occurredAt: row.occurred_at.toISOString(),
      observedAt: row.observed_at.toISOString(),
      correlationId: row.correlation_id,
    }));
  });
}

export async function recordWebhookIntake(
  db: Kysely<Database>,
  input: {
    provider: string;
    eventId: string;
    eventType: string;
    payload: unknown;
  },
): Promise<'new' | 'duplicate'> {
  return withWebhookContext(db, undefined, async (trx) => {
    const result = await trx
      .withSchema('integration')
      .insertInto('inbox_events')
      .values({
        tenant_id: null,
        provider: input.provider,
        event_id: input.eventId,
        event_type: input.eventType,
        payload: JSON.stringify(input.payload),
        state: 'unresolved',
        order_id: null,
        quarantine_reason: null,
        resolved_at: null,
        received_at: new Date(),
      })
      .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
      .returning('event_id')
      .execute();
    return result.length > 0 ? 'new' : 'duplicate';
  });
}

export async function attributeWebhookEvent(
  db: Kysely<Database>,
  input: { provider: string; eventId: string; tenantId: string; orderId: string },
): Promise<void> {
  await withWebhookContext(db, input.tenantId, async (trx) => {
    const result = await trx
      .withSchema('integration')
      .updateTable('inbox_events')
      .set({
        tenant_id: input.tenantId,
        state: 'attributed',
        order_id: input.orderId,
        quarantine_reason: null,
        resolved_at: new Date(),
      })
      .where('provider', '=', input.provider)
      .where('event_id', '=', input.eventId)
      .where((expression) =>
        expression.or([
          expression('tenant_id', 'is', null),
          expression('tenant_id', '=', input.tenantId),
        ]),
      )
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new Error('WEBHOOK_EVENT_TENANT_CONFLICT');
    }
  });
}

export async function quarantineWebhookEvent(
  db: Kysely<Database>,
  input: { provider: string; eventId: string; orderId?: string; reason: string },
): Promise<void> {
  await withWebhookContext(db, undefined, async (trx) => {
    await trx
      .withSchema('integration')
      .updateTable('inbox_events')
      .set({
        tenant_id: null,
        state: 'quarantined',
        order_id: input.orderId ?? null,
        quarantine_reason: input.reason,
        resolved_at: new Date(),
      })
      .where('provider', '=', input.provider)
      .where('event_id', '=', input.eventId)
      .where('tenant_id', 'is', null)
      .execute();
  });
}

export type InboxSummary = {
  provider: string;
  eventId: string;
  eventType: string;
  state: 'unresolved' | 'attributed' | 'quarantined';
  orderId: string | null;
  quarantineReason: string | null;
  receivedAt: string;
};

export async function listInboxEvents(
  db: Kysely<Database>,
  tenantId: string,
  limit = 20,
): Promise<InboxSummary[]> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const rows = await trx
      .withSchema('integration')
      .selectFrom('inbox_events')
      .select([
        'provider',
        'event_id',
        'event_type',
        'state',
        'order_id',
        'quarantine_reason',
        'received_at',
      ])
      .where('tenant_id', '=', tenantId)
      .orderBy('received_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      provider: row.provider,
      eventId: row.event_id,
      eventType: row.event_type,
      state: row.state,
      orderId: row.order_id,
      quarantineReason: row.quarantine_reason,
      receivedAt: row.received_at.toISOString(),
    }));
  });
}

export async function listGlobalInboxEvents(
  db: Kysely<Database>,
  userId: string,
  limit = 50,
): Promise<InboxSummary[]> {
  return withUserContext(db, { userId }, async (trx) => {
    const rows = await trx
      .withSchema('integration')
      .selectFrom('inbox_events')
      .select([
        'provider',
        'event_id',
        'event_type',
        'state',
        'order_id',
        'quarantine_reason',
        'received_at',
      ])
      .orderBy('received_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      provider: row.provider,
      eventId: row.event_id,
      eventType: row.event_type,
      state: row.state,
      orderId: row.order_id,
      quarantineReason: row.quarantine_reason,
      receivedAt: row.received_at.toISOString(),
    }));
  });
}

function fromCheckoutRow(row: {
  id: string;
  tenant_id: string;
  quote_id: string;
  receipt: string;
  razorpay_order_id: string;
  amount_minor: string | number;
  currency: string;
  status: string;
  payment_id: string | null;
  provider_status: string | null;
  copy: string;
}): CheckoutSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    quoteId: row.quote_id,
    receipt: row.receipt,
    razorpayOrderId: row.razorpay_order_id,
    amountMinor: paymentAmountMinor(row.amount_minor),
    currency: 'INR',
    status: row.status as CheckoutStatus,
    paymentId: row.payment_id,
    providerStatus: row.provider_status,
    copy: row.copy,
  };
}

export function paymentAmountMinor(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('PAYMENT_AMOUNT_MINOR_UNSAFE');
    }
    return value;
  }

  let amount: bigint;
  try {
    amount = BigInt(value);
  } catch {
    throw new Error('PAYMENT_AMOUNT_MINOR_INVALID');
  }
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('PAYMENT_AMOUNT_MINOR_UNSAFE');
  }
  return Number(amount);
}
