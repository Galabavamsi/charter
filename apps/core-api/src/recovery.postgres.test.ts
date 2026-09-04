import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@charter/config';
import { createDb, sql, withMachineTenant, type Database, type Kysely } from '@charter/db';
import type { CheckoutSession } from '@charter/payments';
import { listPaymentTransitions } from '@charter/payments';
import { loadDurableFactPin } from '@charter/commerce';
import { createRecoveryRuntime } from './recovery.js';
import { bootPersistence, type MoneyPersist } from './persist.js';
import { createPostgresTenantRepository } from './tenant/postgres-repository.js';

loadConfig();
if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}
const url = process.env.TEST_DATABASE_URL ?? '';
const rolePassword = process.env.CHARTER_APP_PASSWORD ?? '';
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !url) {
  throw new Error('TEST_DATABASE_URL_REQUIRED_IN_CI');
}
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !rolePassword) {
  throw new Error('CHARTER_APP_PASSWORD_REQUIRED_IN_CI');
}
function applicationRoleUrl(ownerUrl: string, password: string): string {
  const applicationUrl = new URL(ownerUrl);
  applicationUrl.username = 'charter_app';
  applicationUrl.password = password;
  return applicationUrl.toString();
}
const appUrl = url && rolePassword ? applicationRoleUrl(url, rolePassword) : '';
const describeWithPostgres = appUrl ? describe.sequential : describe.skip;

const config = loadConfig({
  DATABASE_URL: appUrl || 'postgres://unused',
  CHARTER_ENV: 'test',
  RAZORPAY_MODE: 'test',
  AGENTMAIL_API_KEY: 'am_test',
  AGENTMAIL_INBOX: 'recovery@example.invalid',
});

function razorpayPayments(
  session: CheckoutSession,
  status: 'failed' | 'captured' | 'refunded' | 'created',
) {
  return {
    async getOrder(orderId: string) {
      return {
        id: orderId,
        amount: session.amountMinor,
        currency: 'INR' as const,
        receipt: session.receipt,
        status: 'attempted',
      };
    },
    async listOrderPayments(orderId: string) {
      return [
        {
          id: session.paymentId ?? `pay_${orderId}`,
          order_id: orderId,
          amount: session.amountMinor,
          currency: 'INR',
          status,
        },
      ];
    },
  };
}

function allFailedRazorpay(session: CheckoutSession) {
  return razorpayPayments(session, 'failed');
}

function pgRuntime(
  fetchImpl: typeof fetch,
  repository: ReturnType<typeof createPostgresTenantRepository>,
  session: CheckoutSession,
  moneyPersist?: MoneyPersist,
) {
  return createRecoveryRuntime(
    config,
    fetchImpl,
    repository,
    allFailedRazorpay(session),
    moneyPersist,
  );
}

describeWithPostgres('Postgres recovery send idempotency', () => {
  let db: Kysely<Database>;
  let appDb: Kysely<Database>;
  let persist: MoneyPersist;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const killSwitchIds: string[] = [];

  beforeAll(async () => {
    db = createDb(url);
    appDb = createDb(appUrl);
    const currentRole = await sql<{ role: string }>`
      select current_user as role
    `.execute(appDb);
    expect(currentRole.rows).toEqual([{ role: 'charter_app' }]);
    persist = await bootPersistence(appDb);
  });

  afterAll(async () => {
    for (const killSwitchId of killSwitchIds) {
      await sql`
        delete from operations.kill_switches
        where id = ${killSwitchId}::uuid
      `.execute(db);
    }
    for (const tenantId of tenantIds) {
      await sql`delete from payments.reconciliation_snapshots where tenant_id = ${tenantId}`.execute(
        db,
      );
      await sql`delete from payments.payment_transitions where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from recovery.attempts where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from recovery.checkout_consents where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from recovery.consents where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from recovery.suppressions where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from ledger.ledger_entries where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from payments.checkout_sessions where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from commerce.quote_lines where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from commerce.quotes where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from commerce.cart_lines where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from commerce.carts where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from policy.shop_policies where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from catalog.shops where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from identity.shop_memberships where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from identity.tenants where id = ${tenantId}`.execute(db);
    }
    for (const userId of userIds) {
      await sql`delete from identity.users where id = ${userId}::uuid`.execute(db);
    }
    await appDb.destroy();
    await db.destroy();
  });

  async function fixture(): Promise<{
    repository: ReturnType<typeof createPostgresTenantRepository>;
    session: CheckoutSession;
    userId: string;
  }> {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenantId = `recovery-${suffix}`;
    const userId = randomUUID();
    const cartId = randomUUID();
    const quoteId = randomUUID();
    const checkoutId = randomUUID();
    const consentId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(userId);

    await db.transaction().execute(async (trx) => {
      await sql`
        insert into identity.users (id, email, status, synthetic)
        values (${userId}::uuid, ${`${suffix}@example.invalid`}, 'active', true)
      `.execute(trx);
      await sql`
        insert into identity.tenants (id, label, status, synthetic)
        values (${tenantId}, ${tenantId}, 'active', true)
      `.execute(trx);
      await sql`
        insert into catalog.shops (
          tenant_id, slug, name, label, blurb, currency, status, synthetic, published_at
        )
        values (
          ${tenantId}, ${tenantId}, ${tenantId}, ${tenantId},
          'Recovery integration fixture.', 'INR', 'published', true, now()
        )
      `.execute(trx);
      await sql`
        insert into policy.shop_policies (
          tenant_id, currency, hard_cap_minor, autonomous_cap_minor, forbidden_materials, rules
        )
        values (
          ${tenantId}, 'INR', 500000, 250000, '{}', '{"offers":[]}'::jsonb
        )
      `.execute(trx);
      await sql`
        insert into commerce.carts (id, tenant_id, user_id, version)
        values (${cartId}::uuid, ${tenantId}, ${userId}::uuid, 1)
      `.execute(trx);
      await sql`
        insert into commerce.quotes (
          id, tenant_id, cart_id, cart_version, status, currency, subtotal_minor,
          discount_minor, total_minor, delivery_by, merchant, fact_hash
        )
        values (
          ${quoteId}::uuid, ${tenantId}, ${cartId}::uuid, 1, 'FROZEN', 'INR',
          10000, 0, 10000, '2026-08-30', 'Recovery integration fixture', ${'0'.repeat(64)}
        )
      `.execute(trx);
      await sql`
        insert into payments.checkout_sessions (
          id, tenant_id, quote_id, receipt, razorpay_order_id, amount_minor,
          currency, status, payment_id, provider_status, copy
        )
        values (
          ${checkoutId}::uuid, ${tenantId}, ${quoteId}::uuid, ${`rcpt_${suffix}`},
          ${`order_${suffix}`}, 10000, 'INR', 'FAILED_PROVISIONAL',
          ${`pay_${suffix}`}, 'failed', 'Recovery integration fixture'
        )
      `.execute(trx);
    });

    const repository = createPostgresTenantRepository(appDb);
    await repository.saveRecoveryConsent({
      id: consentId,
      tenantId,
      userId,
      email: `${suffix}@example.invalid`,
      purpose: 'payment_recovery',
      channel: 'email',
      grantedAt: '2026-08-22T12:00:00.000Z',
    });
    await repository.bindRecoveryConsent({
      tenantId,
      checkoutId,
      consentId,
      userId,
    });
    const pin = await loadDurableFactPin(appDb, tenantId);
    await sql`
      update commerce.quotes
      set fact_hash = ${pin.factHash},
          catalog_version = ${pin.catalogVersion},
          policy_version = ${pin.policyVersion}
      where tenant_id = ${tenantId}
        and id = ${quoteId}::uuid
    `.execute(db);

    return {
      repository,
      userId,
      session: {
        id: checkoutId,
        tenantId,
        quoteId,
        receipt: `rcpt_${suffix}`,
        razorpayOrderId: `order_${suffix}`,
        amountMinor: 10000,
        currency: 'INR',
        status: 'FAILED_PROVISIONAL',
        paymentId: `pay_${suffix}`,
        providerStatus: 'failed',
        copy: 'Recovery integration fixture',
      },
    };
  }

  async function enableDurableKill(input: {
    scope: 'global' | 'tenant';
    tenantId: string;
    changedBy: string;
  }): Promise<string> {
    const id = randomUUID();
    const result =
      input.scope === 'global'
        ? await sql<{ id: string }>`
            insert into operations.kill_switches (
              id, scope, tenant_id, feature, enabled, reason, changed_by
            )
            values (
              ${id}::uuid, 'global', null, 'checkout', true,
              'Recovery integration global kill', ${input.changedBy}::uuid
            )
            on conflict (feature) where scope = 'global'
            do update set
              enabled = true,
              reason = excluded.reason,
              changed_by = excluded.changed_by,
              updated_at = now()
            returning id
          `.execute(db)
        : await sql<{ id: string }>`
            insert into operations.kill_switches (
              id, scope, tenant_id, feature, enabled, reason, changed_by
            )
            values (
              ${id}::uuid, 'tenant', ${input.tenantId}, 'checkout', true,
              'Recovery integration tenant kill', ${input.changedBy}::uuid
            )
            on conflict (tenant_id, feature) where scope = 'tenant'
            do update set
              enabled = true,
              reason = excluded.reason,
              changed_by = excluded.changed_by,
              updated_at = now()
            returning id
          `.execute(db);
    const killSwitchId = result.rows[0]!.id;
    killSwitchIds.push(killSwitchId);
    return killSwitchId;
  }

  it('serializes concurrent runtimes and suppresses a restart after sent', async () => {
    const { repository, session } = await fixture();
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let senderCalls = 0;
    const sender = vi.fn(async () => {
      senderCalls += 1;
      const call = senderCalls;
      if (call === 1) {
        started();
        await wait;
      }
      return new Response(JSON.stringify({ message_id: `postgres-message-${call}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const firstRuntime = pgRuntime(sender, repository, session, persist);
    const secondRuntime = pgRuntime(sender, repository, session, persist);

    const first = firstRuntime.afterFailedPay(session);
    await providerStarted;
    const second = await secondRuntime.afterFailedPay(session);
    release();

    expect(await first).toEqual({ action: 'sent', messageId: 'postgres-message-1' });
    expect(second).toEqual({ action: 'skipped', reason: 'ALREADY_PENDING' });
    expect(
      await pgRuntime(
        sender,
        createPostgresTenantRepository(appDb),
        session,
        persist,
      ).afterFailedPay(session),
    ).toEqual({ action: 'skipped', reason: 'ALREADY_SENT' });
    expect(sender).toHaveBeenCalledTimes(1);

    const attempts = await sql<{ status: string; provider_message_id: string | null }>`
      select status, provider_message_id
      from recovery.attempts
      where tenant_id = ${session.tenantId}
        and checkout_id = ${session.id}::uuid
      order by attempt_number
    `.execute(db);
    expect(attempts.rows).toEqual([{ status: 'sent', provider_message_id: 'postgres-message-1' }]);
  });

  it('persists bounded failures, honors capture state, and enforces cross-tenant RLS', async () => {
    const failed = await fixture();
    const captured = await fixture();
    const isolated = await fixture();
    const providerFailure = vi.fn(
      async () => new Response('provider unavailable', { status: 503 }),
    ) as typeof fetch;

    expect(
      await pgRuntime(providerFailure, failed.repository, failed.session, persist).afterFailedPay(
        failed.session,
      ),
    ).toEqual({ action: 'failed', reason: 'AGENTMAIL_SEND_FAILED:503' });
    expect(
      await pgRuntime(providerFailure, failed.repository, failed.session, persist).afterFailedPay(
        failed.session,
      ),
    ).toEqual({ action: 'failed', reason: 'AGENTMAIL_SEND_FAILED:503' });
    expect(
      await pgRuntime(providerFailure, failed.repository, failed.session, persist).afterFailedPay(
        failed.session,
      ),
    ).toEqual({ action: 'skipped', reason: 'RETRY_LIMIT_REACHED' });

    await sql`
      update payments.checkout_sessions
      set status = 'SETTLED', provider_status = 'captured'
      where tenant_id = ${captured.session.tenantId}
        and id = ${captured.session.id}::uuid
    `.execute(db);
    expect(
      await createRecoveryRuntime(config, providerFailure, captured.repository).afterFailedPay({
        ...captured.session,
        status: 'SETTLED',
        providerStatus: 'captured',
      }),
    ).toEqual({ action: 'skipped', reason: 'NOT_FAILED_PROVISIONAL' });
    expect(providerFailure).toHaveBeenCalledTimes(2);

    const providerSuccess = vi.fn(
      async () =>
        new Response(JSON.stringify({ message_id: 'isolated-message' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    expect(
      await pgRuntime(
        providerSuccess,
        isolated.repository,
        isolated.session,
        persist,
      ).afterFailedPay(isolated.session),
    ).toEqual({ action: 'sent', messageId: 'isolated-message' });
    expect(
      await isolated.repository.reserveRecoveryAttempt({
        tenantId: failed.session.tenantId,
        checkoutId: isolated.session.id,
        purpose: 'payment_recovery',
        channel: 'email',
        maxAttempts: 2,
        evidence: {
          reconciledAt: new Date().toISOString(),
          quoteId: isolated.session.quoteId,
          orderId: isolated.session.razorpayOrderId,
          orderStatus: 'attempted',
          outcome: 'same_order_retry_safe',
          paymentAttempts: [{ paymentId: 'pay_isolated', status: 'failed' }],
        },
      }),
    ).toEqual({ action: 'suppressed', reason: 'NO_CONSENT' });

    const failures = await sql<{
      attempt_number: number;
      status: string;
      failure_code: string | null;
    }>`
      select attempt_number, status, failure_code
      from recovery.attempts
      where tenant_id = ${failed.session.tenantId}
        and checkout_id = ${failed.session.id}::uuid
      order by attempt_number
    `.execute(db);
    expect(failures.rows).toEqual([
      {
        attempt_number: 1,
        status: 'failed',
        failure_code: 'AGENTMAIL_SEND_FAILED:503',
      },
      {
        attempt_number: 2,
        status: 'failed',
        failure_code: 'AGENTMAIL_SEND_FAILED:503',
      },
    ]);
    const appVisibleTenants = await withMachineTenant(appDb, failed.session.tenantId, async (trx) =>
      sql<{ tenant_id: string }>`
          select distinct tenant_id
          from recovery.attempts
          order by tenant_id
        `.execute(trx),
    );
    expect(appVisibleTenants.rows).toEqual([{ tenant_id: failed.session.tenantId }]);

    const counts = await sql<{ tenant_id: string; attempts: number }>`
      select tenant_id, count(*)::int as attempts
      from recovery.attempts
      where tenant_id in (
        ${failed.session.tenantId},
        ${captured.session.tenantId},
        ${isolated.session.tenantId}
      )
      group by tenant_id
    `.execute(db);
    expect(counts.rows).toHaveLength(2);
    expect(counts.rows).toEqual(
      expect.arrayContaining([
        { tenant_id: failed.session.tenantId, attempts: 2 },
        { tenant_id: isolated.session.tenantId, attempts: 1 },
      ]),
    );
  });

  it.each(['global', 'tenant'] as const)(
    'suppresses from durable %s kill state with fresh process memory',
    async (scope) => {
      const { repository, session, userId } = await fixture();
      const killSwitchId = await enableDurableKill({
        scope,
        tenantId: session.tenantId,
        changedBy: userId,
      });
      const sender = vi.fn(
        async () =>
          new Response(JSON.stringify({ message_id: 'must-not-send' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch;

      try {
        expect(
          await pgRuntime(sender, repository, session, persist).afterFailedPay(session),
        ).toEqual({
          action: 'skipped',
          reason: 'CHECKOUT_KILLED',
        });
        expect(sender).not.toHaveBeenCalled();

        const attempts = await sql<{ status: string; failure_code: string | null }>`
          select status, failure_code
          from recovery.attempts
          where tenant_id = ${session.tenantId}
            and checkout_id = ${session.id}::uuid
          order by attempt_number
        `.execute(db);
        expect(attempts.rows).toEqual([
          { status: 'suppressed', failure_code: 'RECOVERY_CHECKOUT_KILLED' },
        ]);
      } finally {
        await sql`
          update operations.kill_switches
          set enabled = false, updated_at = now()
          where id = ${killSwitchId}::uuid
        `.execute(db);
      }
    },
  );

  it('suppresses a durable contact before reserving or sending', async () => {
    const { repository, session, userId } = await fixture();
    await sql`
      insert into recovery.suppressions (
        id, tenant_id, contact_value, purpose, channel, reason, active, created_by
      )
      select
        ${randomUUID()}::uuid,
        consent.tenant_id,
        consent.contact_value,
        consent.purpose,
        consent.channel,
        'Buyer requested no further recovery contact',
        true,
        ${userId}::uuid
      from recovery.consents consent
      where consent.tenant_id = ${session.tenantId}
      limit 1
    `.execute(db);
    const sender = vi.fn(
      async () =>
        new Response(JSON.stringify({ message_id: 'must-not-send' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    expect(await pgRuntime(sender, repository, session, persist).afterFailedPay(session)).toEqual({
      action: 'skipped',
      reason: 'SUPPRESSED',
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it('persists append-only reconciliation evidence as charter_app', async () => {
    const { repository, session } = await fixture();
    const persist = await bootPersistence(appDb);
    const sender = vi.fn(
      async () =>
        new Response(JSON.stringify({ message_id: 'recon-message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    expect(
      await createRecoveryRuntime(
        config,
        sender,
        repository,
        allFailedRazorpay(session),
        persist,
      ).afterFailedPay(session),
    ).toMatchObject({ action: 'sent' });

    const first = await listPaymentTransitions(appDb, session.tenantId, session.id);
    expect(first.map((row) => row.observedProviderStatus)).toContain('same_order_retry_safe');

    expect(
      await createRecoveryRuntime(
        config,
        sender,
        repository,
        allFailedRazorpay(session),
        persist,
      ).afterFailedPay(session),
    ).toEqual({ action: 'skipped', reason: 'ALREADY_SENT' });

    const restart = await listPaymentTransitions(appDb, session.tenantId, session.id);
    expect(
      restart.filter((row) => row.observedProviderStatus === 'same_order_retry_safe'),
    ).toHaveLength(1);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('refuses a recovery reservation unless the stored snapshot is fresh same_order_retry_safe', async () => {
    const { repository, session } = await fixture();
    const reconciledAt = '2026-08-22T12:30:00.000Z';
    await sql`
      insert into payments.reconciliation_snapshots (
        tenant_id, checkout_id, quote_id, order_id, order_status, outcome,
        payment_attempts, reconciled_at, correlation_id
      )
      values (
        ${session.tenantId},
        ${session.id}::uuid,
        ${session.quoteId}::uuid,
        ${session.razorpayOrderId},
        'attempted',
        'same_order_retry_safe',
        ${JSON.stringify([{ paymentId: session.paymentId, status: 'failed' }])}::jsonb,
        ${reconciledAt}::timestamptz,
        'corr-recovery-fresh'
      )
    `.execute(db);
    const stale = await repository.reserveRecoveryAttempt({
      tenantId: session.tenantId,
      checkoutId: session.id,
      purpose: 'payment_recovery',
      channel: 'email',
      maxAttempts: 2,
      evidence: {
        reconciledAt: '2026-08-01T00:00:00.000Z',
        quoteId: session.quoteId,
        orderId: session.razorpayOrderId,
        orderStatus: 'attempted',
        outcome: 'same_order_retry_safe',
        paymentAttempts: [{ paymentId: session.paymentId ?? 'pay', status: 'failed' }],
      },
    });
    expect(stale).toEqual({ action: 'suppressed', reason: 'RECONCILIATION_REQUIRED' });
    const reserved = await repository.reserveRecoveryAttempt({
      tenantId: session.tenantId,
      checkoutId: session.id,
      purpose: 'payment_recovery',
      channel: 'email',
      maxAttempts: 2,
      evidence: {
        reconciledAt,
        quoteId: session.quoteId,
        orderId: session.razorpayOrderId,
        orderStatus: 'attempted',
        outcome: 'same_order_retry_safe',
        paymentAttempts: [{ paymentId: session.paymentId ?? 'pay', status: 'failed' }],
      },
    });
    expect(reserved.action).toBe('reserved');
    const stored = await sql<{
      reconciliation_outcome: string | null;
      reconciliation_correlation_id: string | null;
    }>`
      select reconciliation_outcome, reconciliation_correlation_id
      from recovery.attempts
      where tenant_id = ${session.tenantId}
        and checkout_id = ${session.id}::uuid
        and status = 'pending'
    `.execute(db);
    expect(stored.rows[0]).toEqual({
      reconciliation_outcome: 'same_order_retry_safe',
      reconciliation_correlation_id: 'corr-recovery-fresh',
    });
  });

  it('hydrates the durable checkout before send so a stub cannot overwrite payment_id', async () => {
    const { repository, session } = await fixture();
    const persist = await bootPersistence(appDb);
    const sender = vi.fn(
      async () =>
        new Response(JSON.stringify({ message_id: 'hydrate-message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const stub: CheckoutSession = {
      ...session,
      receipt: '',
      paymentId: null,
    };

    expect(
      await createRecoveryRuntime(
        config,
        sender,
        repository,
        razorpayPayments(session, 'created'),
        persist,
      ).afterFailedPay(stub),
    ).toEqual({ action: 'skipped', reason: 'RECONCILIATION_REQUIRED' });
    expect(sender).not.toHaveBeenCalled();

    const stored = await sql<{
      receipt: string;
      payment_id: string | null;
      status: string;
    }>`
      select receipt, payment_id, status
      from payments.checkout_sessions
      where tenant_id = ${session.tenantId}
        and id = ${session.id}::uuid
    `.execute(db);
    expect(stored.rows[0]).toEqual({
      receipt: session.receipt,
      payment_id: session.paymentId,
      status: 'RECONCILING',
    });
    const snapshot = await sql<{ outcome: string }>`
      select outcome
      from payments.reconciliation_snapshots
      where tenant_id = ${session.tenantId}
        and checkout_id = ${session.id}::uuid
    `.execute(db);
    expect(snapshot.rows[0]?.outcome).toBe('unknown_attempts');
  });

  it('treats capture-then-refund as PAYMENT_REFUNDED, unpaid, and not retry-eligible', async () => {
    const { repository, session, userId } = await fixture();
    await sql`
      insert into identity.shop_memberships (tenant_id, user_id, role, status, joined_at)
      values (${session.tenantId}, ${userId}::uuid, 'owner', 'active', now())
    `.execute(db);
    await sql`
      update commerce.quotes
      set status = 'BOUND', bound_checkout_id = ${session.id}::uuid
      where tenant_id = ${session.tenantId}
        and id = ${session.quoteId}::uuid
    `.execute(db);
    await persist.persistWebhookTransition({
      ...session,
      status: 'SETTLED',
      paymentId: session.paymentId,
      providerStatus: 'captured',
      copy: 'Captured evidence.',
    });
    await persist.persistWebhookTransition({
      ...session,
      status: 'RECONCILING',
      paymentId: session.paymentId,
      providerStatus: 'refunded',
      copy: 'Refund evidence.',
    });

    const quote = await sql<{ status: string }>`
      select status
      from commerce.quotes
      where tenant_id = ${session.tenantId}
        and id = ${session.quoteId}::uuid
    `.execute(db);
    expect(quote.rows).toHaveLength(1);
    expect(quote.rows[0]?.status).not.toBe('SETTLED');
    const ledger = await sql<{ kind: string }>`
      select kind
      from ledger.ledger_entries
      where tenant_id = ${session.tenantId}
        and checkout_id = ${session.id}::uuid
    `.execute(db);
    expect(ledger.rows.some((row) => row.kind === 'capture')).toBe(true);
    expect(
      ledger.rows.some(
        (row) => row.kind === 'refund' || row.kind === 'void' || row.kind === 'capture_reversal',
      ),
    ).toBe(true);
    const order = await repository.getMerchantOrder({
      userId,
      tenantId: session.tenantId,
      orderId: session.id,
    });
    expect(order).toMatchObject({
      paid: false,
      fulfillmentReady: false,
    });
    expect(order?.quote.status).not.toBe('SETTLED');
    const recovery = await repository.getMerchantRecovery({
      userId,
      tenantId: session.tenantId,
      checkoutId: session.id,
    });
    expect(recovery).toMatchObject({
      canSend: false,
      blockedReason: 'PAYMENT_REFUNDED',
    });
    expect(recovery?.reconciliationStatus).not.toBe('captured');
    expect(recovery?.stopStatus).not.toBe('captured');
    expect(
      await createRecoveryRuntime(
        config,
        vi.fn() as typeof fetch,
        repository,
        razorpayPayments(session, 'refunded'),
        persist,
      ).afterFailedPay({ ...session, paymentId: null, receipt: '' }),
    ).toMatchObject({ action: 'skipped' });
  });

  it('persists refund truth when FAILED_PROVISIONAL paymentId is null and provider is refunded', async () => {
    const { repository, session, userId } = await fixture();
    await sql`
      insert into identity.shop_memberships (tenant_id, user_id, role, status, joined_at)
      values (${session.tenantId}, ${userId}::uuid, 'owner', 'active', now())
    `.execute(db);
    await sql`
      update payments.checkout_sessions
      set payment_id = null, provider_status = 'failed', status = 'FAILED_PROVISIONAL'
      where tenant_id = ${session.tenantId}
        and id = ${session.id}::uuid
    `.execute(db);
    await sql`
      update commerce.quotes
      set status = 'BOUND', bound_checkout_id = ${session.id}::uuid
      where tenant_id = ${session.tenantId}
        and id = ${session.quoteId}::uuid
    `.execute(db);

    const result = await createRecoveryRuntime(
      config,
      vi.fn() as typeof fetch,
      repository,
      razorpayPayments({ ...session, paymentId: null }, 'refunded'),
      persist,
    ).afterFailedPay({ ...session, paymentId: null, receipt: '', providerStatus: 'failed' });

    expect(result).toEqual({ action: 'skipped', reason: 'PAYMENT_REFUNDED' });
    const stored = await sql<{
      payment_id: string | null;
      status: string;
      provider_status: string | null;
    }>`
      select payment_id, status, provider_status
      from payments.checkout_sessions
      where tenant_id = ${session.tenantId}
        and id = ${session.id}::uuid
    `.execute(db);
    expect(stored.rows[0]?.payment_id).toBe(`pay_${session.razorpayOrderId}`);
    expect(stored.rows[0]).toMatchObject({
      status: 'RECONCILING',
      provider_status: 'refunded',
    });
    const ledger = await sql<{ kind: string }>`
      select kind
      from ledger.ledger_entries
      where tenant_id = ${session.tenantId}
        and checkout_id = ${session.id}::uuid
    `.execute(db);
    expect(ledger.rows.some((row) => row.kind === 'refund')).toBe(true);
    const order = await repository.getMerchantOrder({
      userId,
      tenantId: session.tenantId,
      orderId: session.id,
    });
    expect(order).toMatchObject({
      paid: false,
      fulfillmentReady: false,
    });
    const recovery = await repository.getMerchantRecovery({
      userId,
      tenantId: session.tenantId,
      checkoutId: session.id,
    });
    expect(recovery).toMatchObject({
      canSend: false,
      blockedReason: 'PAYMENT_REFUNDED',
    });
  });
});
