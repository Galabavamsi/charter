import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCanonicalKit, getQuote, hydrateQuote, resetKernel } from '@charter/commerce';
import { loadConfig } from '@charter/config';
import type { CheckoutSession } from '@charter/payments';
import { createRecoveryRuntime } from './recovery.js';
import { createMemoryTenantRepository } from './testing/memory-tenant-repository.js';

const USER_ID = '86000000-0000-4000-8000-000000000001';
const CHECKOUT_ID = '86000000-0000-4000-8000-000000000002';
const CONSENT_ID = '86000000-0000-4000-8000-000000000003';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused',
  CHARTER_ENV: 'test',
  RAZORPAY_MODE: 'test',
  AGENTMAIL_API_KEY: 'am_test',
  AGENTMAIL_INBOX: 'recovery@example.invalid',
});

function mailFetch(sent: string[], wait?: Promise<void>): typeof fetch {
  return vi.fn(async (_input, init) => {
    if (wait) {
      await wait;
    }
    sent.push(String(init?.body));
    return new Response(JSON.stringify({ message_id: `message-${sent.length}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function failedMailFetch(attempts: string[]): typeof fetch {
  return vi.fn(async (_input, init) => {
    attempts.push(String(init?.body));
    return new Response('provider unavailable', { status: 503 });
  }) as typeof fetch;
}

function allFailedRazorpay(session: CheckoutSession) {
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
          status: 'failed' as const,
        },
      ];
    },
  };
}

function recoveryRuntime(
  fetchImpl: typeof fetch,
  repository: ReturnType<typeof createMemoryTenantRepository>,
  session: CheckoutSession,
) {
  return createRecoveryRuntime(config, fetchImpl, repository, allFailedRazorpay(session));
}

async function durableRecoveryFixture(input?: {
  repository?: ReturnType<typeof createMemoryTenantRepository>;
  tenantId?: string;
  checkoutId?: string;
  consentId?: string;
  userId?: string;
  email?: string;
}) {
  const repository = input?.repository ?? createMemoryTenantRepository();
  const { quote } = buildCanonicalKit();
  const session: CheckoutSession = {
    id: input?.checkoutId ?? CHECKOUT_ID,
    tenantId: input?.tenantId ?? quote.tenantId,
    quoteId: quote.id,
    receipt: 'rcpt_recovery_durable',
    razorpayOrderId: 'order_recovery_durable',
    amountMinor: Number(quote.totalMinor),
    currency: 'INR',
    status: 'FAILED_PROVISIONAL',
    paymentId: 'pay_failed_durable',
    providerStatus: 'failed',
    copy: 'Durable recovery fixture.',
  };
  await repository.saveRecoveryConsent({
    id: input?.consentId ?? CONSENT_ID,
    tenantId: session.tenantId,
    userId: input?.userId ?? USER_ID,
    email: input?.email ?? 'shopper@example.invalid',
    purpose: 'payment_recovery',
    channel: 'email',
    grantedAt: '2026-08-22T12:00:00.000Z',
  });
  await repository.bindRecoveryConsent({
    tenantId: session.tenantId,
    checkoutId: session.id,
    consentId: input?.consentId ?? CONSENT_ID,
    userId: input?.userId ?? USER_ID,
  });
  return { repository, session };
}

describe('durable failed-pay recovery dispatch', () => {
  beforeEach(() => {
    resetKernel();
  });

  it('suppresses a repeat send after runtime and commerce memory restart', async () => {
    const { repository, session } = await durableRecoveryFixture();
    const sent: string[] = [];
    const firstRuntime = recoveryRuntime(mailFetch(sent), repository, session);

    expect(await firstRuntime.afterFailedPay(session)).toMatchObject({ action: 'sent' });
    const frozen = getQuote(session.quoteId);
    resetKernel();
    if (frozen) {
      hydrateQuote(frozen);
    }
    const restartedRuntime = recoveryRuntime(mailFetch(sent), repository, session);
    const duplicate = await restartedRuntime.afterFailedPay(session);

    expect(duplicate).toEqual({ action: 'skipped', reason: 'ALREADY_SENT' });
    expect(sent).toHaveLength(1);
    expect(repository.state.recoveryAttempts).toEqual([
      expect.objectContaining({
        status: 'sent',
        attemptNumber: 1,
        providerMessageId: 'message-1',
        purpose: 'payment_recovery',
        channel: 'email',
      }),
    ]);
  });

  it('atomically reserves one send across concurrent runtime instances', async () => {
    const { repository, session } = await durableRecoveryFixture();
    const sent: string[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstRuntime = recoveryRuntime(mailFetch(sent, wait), repository, session);
    const secondRuntime = recoveryRuntime(mailFetch(sent, wait), repository, session);

    const first = firstRuntime.afterFailedPay(session);
    const second = secondRuntime.afterFailedPay(session);
    await Promise.resolve();
    release();
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => result.action === 'sent')).toHaveLength(1);
    expect(results).toContainEqual({ action: 'skipped', reason: 'ALREADY_PENDING' });
    expect(sent).toHaveLength(1);
    expect(repository.state.recoveryAttempts.map((attempt) => attempt.status)).toEqual(['sent']);
  });

  it('records provider failures and permits only one policy-bounded retry', async () => {
    const { repository, session } = await durableRecoveryFixture();
    const attempts: string[] = [];

    const first = await recoveryRuntime(
      failedMailFetch(attempts),
      repository,
      session,
    ).afterFailedPay(session);
    const retry = await recoveryRuntime(
      failedMailFetch(attempts),
      repository,
      session,
    ).afterFailedPay(session);
    const exhausted = await recoveryRuntime(
      failedMailFetch(attempts),
      repository,
      session,
    ).afterFailedPay(session);

    expect(first).toEqual({ action: 'failed', reason: 'AGENTMAIL_SEND_FAILED:503' });
    expect(retry).toEqual({ action: 'failed', reason: 'AGENTMAIL_SEND_FAILED:503' });
    expect(exhausted).toEqual({ action: 'skipped', reason: 'RETRY_LIMIT_REACHED' });
    expect(attempts).toHaveLength(2);
    expect(repository.state.recoveryAttempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        status: 'failed',
        failureCode: 'AGENTMAIL_SEND_FAILED:503',
      }),
      expect.objectContaining({
        attemptNumber: 2,
        status: 'failed',
        failureCode: 'AGENTMAIL_SEND_FAILED:503',
      }),
    ]);
  });

  it('does not leak a pending attempt when recovery copy validation fails', async () => {
    const { repository, session } = await durableRecoveryFixture();
    const sent: string[] = [];

    const leaked = { ...session, razorpayOrderId: 'rzp_live_must_not_leak' };
    await expect(
      recoveryRuntime(mailFetch(sent), repository, leaked).afterFailedPay(leaked),
    ).rejects.toThrow('RECOVERY_COPY_LEAK');
    expect(repository.state.recoveryAttempts).toEqual([]);
    expect(sent).toEqual([]);

    const failures: string[] = [];
    expect(
      await recoveryRuntime(failedMailFetch(failures), repository, session).afterFailedPay(session),
    ).toEqual({ action: 'failed', reason: 'AGENTMAIL_SEND_FAILED:503' });
    expect(
      await recoveryRuntime(failedMailFetch(failures), repository, session).afterFailedPay(session),
    ).toEqual({ action: 'failed', reason: 'AGENTMAIL_SEND_FAILED:503' });
    expect(
      await recoveryRuntime(failedMailFetch(failures), repository, session).afterFailedPay(session),
    ).toEqual({ action: 'skipped', reason: 'RETRY_LIMIT_REACHED' });
    expect(failures).toHaveLength(2);
  });

  it.each(['global', 'tenant'] as const)(
    'suppresses dispatch from durable %s kill state with a fresh runtime',
    async (scope) => {
      const { repository, session } = await durableRecoveryFixture();
      if (scope === 'global') {
        repository.state.globalKill = true;
      } else {
        repository.state.tenantKills.add(session.tenantId);
      }
      const sent: string[] = [];

      const result = await recoveryRuntime(mailFetch(sent), repository, session).afterFailedPay(
        session,
      );

      expect(result).toEqual({ action: 'skipped', reason: 'CHECKOUT_KILLED' });
      expect(sent).toEqual([]);
      expect(repository.state.recoveryAttempts).toEqual([
        expect.objectContaining({
          tenantId: session.tenantId,
          checkoutId: session.id,
          status: 'suppressed',
          failureCode: 'RECOVERY_CHECKOUT_KILLED',
        }),
      ]);
    },
  );

  it('keeps identical checkout recovery keys isolated by tenant', async () => {
    const repository = createMemoryTenantRepository();
    const first = await durableRecoveryFixture({ repository });
    const second = await durableRecoveryFixture({
      repository,
      tenantId: 'tenant-two',
      consentId: '86000000-0000-4000-8000-000000000004',
      userId: '86000000-0000-4000-8000-000000000005',
      email: 'other-shopper@example.invalid',
    });
    const sent: string[] = [];
    const firstRuntime = recoveryRuntime(mailFetch(sent), repository, first.session);
    const secondRuntime = recoveryRuntime(mailFetch(sent), repository, second.session);

    expect(await firstRuntime.afterFailedPay(first.session)).toMatchObject({ action: 'sent' });
    expect(await secondRuntime.afterFailedPay(second.session)).toMatchObject({ action: 'sent' });

    expect(sent).toHaveLength(2);
    expect(repository.state.recoveryAttempts.map((attempt) => attempt.tenantId)).toEqual([
      first.session.tenantId,
      second.session.tenantId,
    ]);
  });

  it('suppresses a captured checkout before reserving or sending', async () => {
    const { repository, session } = await durableRecoveryFixture();
    const sent: string[] = [];
    const result = await recoveryRuntime(mailFetch(sent), repository, session).afterFailedPay({
      ...session,
      status: 'SETTLED',
    });

    expect(result).toEqual({ action: 'skipped', reason: 'NOT_FAILED_PROVISIONAL' });
    expect(sent).toEqual([]);
    expect(repository.state.recoveryAttempts).toEqual([]);
  });

  it('fails closed when the production provider reader is missing', async () => {
    const { repository, session } = await durableRecoveryFixture();
    const sent: string[] = [];
    const result = await createRecoveryRuntime(config, mailFetch(sent), repository).afterFailedPay(
      session,
    );
    expect(result).toEqual({ action: 'skipped', reason: 'RECONCILIATION_REQUIRED' });
    expect(sent).toEqual([]);
    expect(repository.state.recoveryAttempts).toEqual([]);
  });
});
