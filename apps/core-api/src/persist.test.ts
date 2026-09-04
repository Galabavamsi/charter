import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDIGO_DESK, NORTHSTAR_TENANT, resetMerchantSeeds } from '@charter/catalog';
import {
  addLine,
  bindQuote,
  buildCanonicalKit,
  createCart,
  decidePersistedApproval,
  freezeQuote,
  getCart,
  getQuote,
  hydrateCommerce,
  loadApproval,
  loadCart,
  loadQuote,
  previewReplace,
  resetKernel,
  saveApproval,
  saveCart,
  saveQuote,
} from '@charter/commerce';
import {
  createDb,
  pingDb,
  seedDatabase,
  sql,
  withMachineTenant,
  withWebhookContext,
  type Database,
  type Kysely,
} from '@charter/db';
import { appendCapture, listCaptures } from '@charter/ledger';
import {
  attributeWebhookEvent,
  hydrateCheckout,
  loadCheckout,
  listPaymentTransitions,
  recordWebhookIntake,
  resetCheckouts,
  saveCheckout,
} from '@charter/payments';
import { getConversation, resetConversations } from '@charter/orchestrator';
import { loadConfig } from '@charter/config';
import { bootPersistence } from './persist.js';
import { registerRazorpayWebhook } from './webhooks.js';
import { buildServer } from './server.js';
import { createPostgresTenantRepository } from './tenant/postgres-repository.js';

loadConfig();
if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}
const ownerUrl = process.env.TEST_DATABASE_URL ?? '';
const rolePassword = process.env.CHARTER_APP_PASSWORD ?? '';
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !ownerUrl) {
  throw new Error('TEST_DATABASE_URL_REQUIRED_IN_CI');
}
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !rolePassword) {
  throw new Error('CHARTER_APP_PASSWORD_REQUIRED_IN_CI');
}
function applicationRoleUrl(databaseUrl: string, password: string): string {
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = 'charter_app';
  applicationUrl.password = password;
  return applicationUrl.toString();
}
const appUrl = ownerUrl && rolePassword ? applicationRoleUrl(ownerUrl, rolePassword) : '';
const describeWithPostgres = appUrl ? describe.sequential : describe.skip;

describeWithPostgres('charter_app postgres money kernel', () => {
  let ownerDb: Kysely<Database>;
  let db: Kysely<Database>;
  const ownerId = '01000000-0000-4000-8000-000000000001';
  const requesterId = '01000000-0000-4000-8000-000000000002';
  const authHeaders = { authorization: 'Bearer durable-owner' };
  const requesterHeaders = { authorization: 'Bearer durable-buyer' };

  const buildDurableServer = (
    extraEnv: NodeJS.ProcessEnv = {},
    identity: { userId: string; email: string } = {
      userId: ownerId,
      email: 'northstar.owner@example.invalid',
    },
  ) =>
    buildServer(
      {
        DATABASE_URL: appUrl,
        CHARTER_ENV: 'development',
        RAZORPAY_MODE: 'test',
        ...extraEnv,
      },
      {
        db,
        authVerifier: {
          async verify() {
            return identity;
          },
        },
      },
    );

  beforeAll(async () => {
    ownerDb = createDb(ownerUrl);
    db = createDb(appUrl);
    await pingDb(db);
    await seedDatabase(ownerDb);
    const currentRole = await sql<{ role: string }>`
      select current_user as role
    `.execute(db);
    expect(currentRole.rows).toEqual([{ role: 'charter_app' }]);
  });

  afterAll(async () => {
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(() => {
    resetKernel();
    resetMerchantSeeds();
  });

  it('reloads a frozen canonical quote after memory is cleared', async () => {
    resetKernel();
    const { cart, quote } = buildCanonicalKit();
    await saveCart(db, cart);
    await saveQuote(db, quote, NORTHSTAR_TENANT);
    resetKernel();
    expect(getQuote(quote.id)).toBeUndefined();
    await hydrateCommerce(db, NORTHSTAR_TENANT);
    const loaded = getQuote(quote.id);
    expect(loaded?.totalMinor).toBe(234700n);
    expect(loaded?.status).toBe('FROZEN');
    expect(loaded?.merchant).toContain('synthetic');
  });

  it('loads the exact tenant approval and atomically decides it after kernel reset', async () => {
    resetKernel();
    const { cart } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const approval = preview.approval!;
    await saveCart(db, cart, ownerId);
    await saveApproval(db, approval, requesterId);

    resetKernel();
    expect(await loadApproval(db, 'indigo-desk-in', approval.id)).toBeUndefined();
    expect(await loadApproval(db, NORTHSTAR_TENANT, approval.id)).toMatchObject({
      id: approval.id,
      tenantId: NORTHSTAR_TENANT,
      fromTitle: 'Hand grinder',
      toTitle: 'Pro hand grinder',
      status: 'pending',
    });
    resetKernel();
    const decided = await decidePersistedApproval(db, {
      tenantId: NORTHSTAR_TENANT,
      approvalId: approval.id,
      decision: 'approved',
      decidedBy: ownerId,
    });

    expect(decided.approval.status).toBe('approved');
    expect(decided.cart.lines).toContainEqual({ sku: 'grinder.pocket-pro', quantity: 1 });
    resetKernel();
    expect((await loadCart(db, NORTHSTAR_TENANT, cart.id))?.lines).toContainEqual({
      sku: 'grinder.pocket-pro',
      quantity: 1,
    });
  });

  it('writes approval kind and action_hash columns that survive reload without reconstruction', async () => {
    resetKernel();
    const { cart } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const pinnedHash = 'pinned-action-hash-must-round-trip';
    const approval = {
      ...preview.approval!,
      kind: 'catalog_publish' as const,
      actionHash: pinnedHash,
    };
    await saveCart(db, cart, ownerId);
    await saveApproval(db, approval, requesterId);
    resetKernel();

    const stored = await withMachineTenant(db, NORTHSTAR_TENANT, async (trx) =>
      trx
        .withSchema('policy')
        .selectFrom('approvals')
        .select(['kind', 'action_hash'])
        .where('tenant_id', '=', NORTHSTAR_TENANT)
        .where('id', '=', approval.id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.kind).toBe('catalog_publish');
    expect(stored.action_hash).toBe(pinnedHash);
    expect(stored.action_hash).not.toBeNull();

    const loaded = await loadApproval(db, NORTHSTAR_TENANT, approval.id);
    expect(loaded?.kind).toBe('catalog_publish');
    expect(loaded?.actionHash).toBe(pinnedHash);
  });

  it('rejects the requester deciding their own durable cart_spend approval', async () => {
    resetKernel();
    const { cart } = buildCanonicalKit();
    const approval = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro').approval!;
    await saveCart(db, cart, ownerId);
    await saveApproval(db, approval, ownerId);
    await expect(
      decidePersistedApproval(db, {
        tenantId: NORTHSTAR_TENANT,
        approvalId: approval.id,
        decision: 'approved',
        decidedBy: ownerId,
      }),
    ).rejects.toThrow('APPROVAL_SELF_DECISION');
  });

  it('decides a durable approval after restart without opening Register first', async () => {
    resetKernel();
    const { cart } = buildCanonicalKit();
    const approval = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro').approval!;
    await saveCart(db, cart, ownerId);
    await saveApproval(db, approval, requesterId);
    resetKernel();

    const { app } = await buildDurableServer();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/register/approvals/${approval.id}`,
        headers: authHeaders,
        payload: {
          tenantId: NORTHSTAR_TENANT,
          decision: 'approved',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().approval.status).toBe('approved');
      expect(response.json().cart.lines).toContainEqual({
        sku: 'grinder.pocket-pro',
        quantity: 1,
      });
      resetKernel();
      expect((await loadCart(db, NORTHSTAR_TENANT, cart.id))?.lines).toContainEqual({
        sku: 'grinder.pocket-pro',
        quantity: 1,
      });
    } finally {
      await app.close();
    }
  });

  it('returns durable tenant approvals in deterministic order after restart', async () => {
    resetKernel();
    const firstCart = buildCanonicalKit().cart;
    const firstApproval = {
      ...previewReplace(firstCart.id, 'grinder.pocket-lite', 'grinder.pocket-pro').approval!,
      createdAt: '2099-01-01T00:00:00.000Z',
    };
    const secondCart = buildCanonicalKit().cart;
    const secondApproval = {
      ...previewReplace(secondCart.id, 'grinder.pocket-lite', 'grinder.pocket-pro').approval!,
      createdAt: '2099-01-01T00:00:00.000Z',
    };
    await saveCart(db, firstCart, ownerId);
    await saveCart(db, secondCart, ownerId);
    await saveApproval(db, firstApproval, requesterId);
    await saveApproval(db, secondApproval, requesterId);
    resetKernel();

    const { app } = await buildDurableServer();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/register/${NORTHSTAR_TENANT}`,
        headers: authHeaders,
      });
      const targetIds = new Set([firstApproval.id, secondApproval.id]);
      const durableIds = response
        .json()
        .approvals.map((approval: { id: string }) => approval.id)
        .filter((id: string) => targetIds.has(id));

      expect(response.statusCode, response.body).toBe(200);
      expect(durableIds).toEqual([firstApproval.id, secondApproval.id].sort().reverse());
    } finally {
      await app.close();
    }
  });

  it('persists a chat approval so Register can load and decide it after restart', async () => {
    resetKernel();
    resetConversations();
    const script = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_brewer',
            type: 'function',
            function: {
              name: 'cart.add_line',
              arguments: JSON.stringify({ sku: 'brewer.trailpress-steel-750' }),
            },
          },
          {
            id: 'call_grinder',
            type: 'function',
            function: {
              name: 'cart.add_line',
              arguments: JSON.stringify({ sku: 'grinder.pocket-lite' }),
            },
          },
          {
            id: 'call_filters',
            type: 'function',
            function: {
              name: 'cart.add_line',
              arguments: JSON.stringify({ sku: 'filters.travel-30' }),
            },
          },
          {
            id: 'call_preview',
            type: 'function',
            function: {
              name: 'cart.preview_replace',
              arguments: JSON.stringify({
                fromSku: 'grinder.pocket-lite',
                toSku: 'grinder.pocket-pro',
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'Register approval requested.' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const message = script.shift();
        if (!message) {
          throw new Error('FIREWORKS_SCRIPT_EXHAUSTED');
        }
        return new Response(JSON.stringify({ choices: [{ message }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const firstServer = await buildDurableServer(
      { FIREWORKS_API_KEY: 'fw_test' },
      { userId: requesterId, email: 'indigo.owner@example.invalid' },
    );
    let restartedServer: Awaited<ReturnType<typeof buildDurableServer>> | undefined;
    try {
      const created = await firstServer.app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: requesterHeaders,
        payload: { shopSlug: 'northstar' },
      });
      const turn = await firstServer.app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${created.json().id as string}/turns`,
        headers: requesterHeaders,
        payload: {
          shopSlug: 'northstar',
          text: 'Build the travel kit and preview the Pro grinder swap.',
        },
      });
      expect(turn.statusCode, turn.body).toBe(200);
      const preview = turn
        .json()
        .traces.find((trace: { name: string }) => trace.name === 'cart.preview_replace') as {
        result: { approval: { id: string } };
      };
      const approvalId = preview.result.approval.id;

      resetKernel();
      resetConversations();
      restartedServer = await buildDurableServer();
      const register = await restartedServer.app.inject({
        method: 'GET',
        url: `/api/v1/register/${NORTHSTAR_TENANT}`,
        headers: authHeaders,
      });
      const decision = await restartedServer.app.inject({
        method: 'POST',
        url: `/api/v1/register/approvals/${approvalId}`,
        headers: authHeaders,
        payload: { tenantId: NORTHSTAR_TENANT, decision: 'approved' },
      });

      expect(register.statusCode, register.body).toBe(200);
      expect(register.json().approvals).toContainEqual(
        expect.objectContaining({ id: approvalId, status: 'pending' }),
      );
      expect(decision.statusCode, decision.body).toBe(200);
      expect(decision.json().approval.status).toBe('approved');
      expect(decision.json().cart.lines).toContainEqual({
        sku: 'grinder.pocket-pro',
        quantity: 1,
      });
    } finally {
      vi.unstubAllGlobals();
      await firstServer.app.close();
      await restartedServer?.app.close();
    }
  });

  it('does not redeliver a consumed pending checkout after a database restart', async () => {
    resetConversations();
    const firstServer = await buildDurableServer();
    const secondServer = await buildDurableServer();
    const thirdServer = await buildDurableServer();
    try {
      const created = await firstServer.app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: authHeaders,
        payload: { shopSlug: 'northstar' },
      });
      expect(created.statusCode, created.body).toBe(200);
      const conversationId = created.json().id as string;
      const conversation = getConversation(conversationId);
      expect(conversation).toBeDefined();
      const pendingCheckout = {
        checkoutId: randomUUID(),
        orderId: `order_${randomUUID()}`,
        amount: 234700,
        currency: 'INR',
      };
      conversation!.pendingCheckout = pendingCheckout;
      conversation!.revision = await firstServer.tenantRepository.saveConversation({
        id: conversationId,
        tenantId: NORTHSTAR_TENANT,
        userId: ownerId,
        expectedRevision: conversation!.revision,
        state: {
          cartId: conversation!.cartId,
          quoteId: conversation!.quoteId,
          catalogLoaded: conversation!.catalogLoaded,
          pendingCheckout: conversation!.pendingCheckout,
          messages: conversation!.messages,
        },
      });

      resetConversations();
      const consumed = await secondServer.app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}?shopSlug=northstar&takeCheckout=1`,
        headers: authHeaders,
      });
      resetConversations();
      const afterRestart = await thirdServer.app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}?shopSlug=northstar&takeCheckout=1`,
        headers: authHeaders,
      });

      expect(consumed.statusCode, consumed.body).toBe(200);
      expect(consumed.json().checkout).toEqual(pendingCheckout);
      expect(afterRestart.statusCode, afterRestart.body).toBe(200);
      expect(afterRestart.json().checkout).toBeNull();
    } finally {
      await Promise.all([
        firstServer.app.close(),
        secondServer.app.close(),
        thirdServer.app.close(),
      ]);
    }
  });

  it('reloads failed text and voice turn mutations from Postgres after restart', async () => {
    resetConversations();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    const firstServer = await buildDurableServer({ FIREWORKS_API_KEY: 'fw_test' });
    const restartedServer = await buildDurableServer();
    try {
      const textCreated = await firstServer.app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: authHeaders,
        payload: { shopSlug: 'northstar' },
      });
      const voiceCreated = await firstServer.app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: authHeaders,
        payload: { shopSlug: 'northstar' },
      });
      const textId = textCreated.json().id as string;
      const voiceId = voiceCreated.json().id as string;

      const textFailed = await firstServer.app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${textId}/turns`,
        headers: authHeaders,
        payload: {
          shopSlug: 'northstar',
          text: 'Persist this database text turn',
        },
      });
      const voiceFailed = await firstServer.app.inject({
        method: 'POST',
        url: `/api/v1/voice/${voiceId}/chat/completions`,
        headers: authHeaders,
        payload: {
          shopSlug: 'northstar',
          messages: [{ role: 'user', content: 'Persist this database voice turn' }],
        },
      });

      expect(textFailed.statusCode).toBe(200);
      expect(voiceFailed.statusCode).toBe(200);
      resetConversations();
      for (const [id, expectedText] of [
        [textId, 'Persist this database text turn'],
        [voiceId, 'Persist this database voice turn'],
      ] as const) {
        const rehydrated = await restartedServer.app.inject({
          method: 'GET',
          url: `/api/v1/conversations/${id}?shopSlug=northstar`,
          headers: authHeaders,
        });
        expect(rehydrated.statusCode, rehydrated.body).toBe(200);
        expect(getConversation(id)?.messages).toContainEqual({
          role: 'user',
          content: expectedText,
        });
      }
    } finally {
      vi.unstubAllGlobals();
      await Promise.all([firstServer.app.close(), restartedServer.app.close()]);
    }
  });

  it('records one capture in the ledger and dedupes inbox events', async () => {
    resetKernel();
    const { cart, quote } = buildCanonicalKit();
    await saveCart(db, cart);
    await saveQuote(db, quote, NORTHSTAR_TENANT);
    const checkoutId = randomUUID();
    await saveCheckout(db, NORTHSTAR_TENANT, {
      id: checkoutId,
      tenantId: NORTHSTAR_TENANT,
      quoteId: quote.id,
      receipt: `rcpt_${checkoutId.replaceAll('-', '').slice(0, 20)}`,
      razorpayOrderId: `order_${checkoutId}`,
      amountMinor: 234700,
      currency: 'INR',
      status: 'SETTLED',
      paymentId: 'pay_test',
      providerStatus: 'captured',
      copy: 'Synthetic persistence test checkout.',
    });
    const first = await appendCapture(db, {
      tenantId: NORTHSTAR_TENANT,
      checkoutId,
      quoteId: quote.id,
      amountMinor: 234700n,
      currency: 'INR',
      providerPaymentId: 'pay_test',
    });
    const second = await appendCapture(db, {
      tenantId: NORTHSTAR_TENANT,
      checkoutId,
      quoteId: quote.id,
      amountMinor: 234700n,
      currency: 'INR',
      providerPaymentId: 'pay_test',
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const eventId = `evt_${checkoutId}`;
    expect(
      await recordWebhookIntake(db, {
        provider: 'razorpay',
        eventId,
        eventType: 'payment.captured',
        payload: { ok: true },
      }),
    ).toBe('new');
    await attributeWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      tenantId: NORTHSTAR_TENANT,
      orderId: `order_${checkoutId}`,
    });
    expect(
      await recordWebhookIntake(db, {
        provider: 'razorpay',
        eventId,
        eventType: 'payment.captured',
        payload: { ok: true },
      }),
    ).toBe('duplicate');
  });

  it('hydrates the persisted tenant chain and converges restart webhook retries', async () => {
    resetKernel();
    resetCheckouts();
    const cart = createCart(INDIGO_DESK.tenantId);
    addLine(cart.id, 'note.ruled-a5');
    const quote = freezeQuote(cart.id);
    const checkoutId = randomUUID();
    bindQuote(quote.id, checkoutId);
    const orderId = `order_${checkoutId}`;
    await saveCart(db, cart);
    await saveQuote(db, quote, INDIGO_DESK.tenantId);
    await saveCheckout(db, INDIGO_DESK.tenantId, {
      id: checkoutId,
      tenantId: INDIGO_DESK.tenantId,
      quoteId: quote.id,
      receipt: `rcpt_${checkoutId.replaceAll('-', '').slice(0, 20)}`,
      razorpayOrderId: orderId,
      amountMinor: Number(quote.totalMinor),
      currency: 'INR',
      status: 'CREATED',
      paymentId: null,
      providerStatus: 'created',
      copy: 'Persisted restart webhook test checkout.',
    });

    resetKernel();
    resetCheckouts();
    const persist = await bootPersistence(db);
    const secret = 'whsec_restart_durability';
    const app = Fastify();
    await registerRazorpayWebhook(
      app,
      loadConfig({
        DATABASE_URL: appUrl,
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_WEBHOOK_SECRET: secret,
      }),
      persist,
    );
    const send = async (
      eventId: string,
      event: 'payment.failed' | 'payment.authorized' | 'payment.captured',
    ) => {
      const status = event.slice('payment.'.length);
      const raw = JSON.stringify({
        event,
        payload: {
          payment: {
            entity: { id: `pay_${status}_${checkoutId}`, order_id: orderId, status },
          },
        },
      });
      return app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
          'x-razorpay-event-id': eventId,
        },
        payload: raw,
      });
    };

    const failedEvent = `evt_failed_${checkoutId}`;
    const failed = await send(failedEvent, 'payment.failed');
    expect(failed.statusCode).toBe(200);
    expect((await loadCheckout(db, INDIGO_DESK.tenantId, checkoutId))?.status).toBe(
      'FAILED_PROVISIONAL',
    );

    resetKernel();
    resetCheckouts();
    const authorizedEvent = `evt_authorized_${checkoutId}`;
    const authorized = await send(authorizedEvent, 'payment.authorized');
    expect(authorized.statusCode).toBe(200);
    expect((await loadCheckout(db, INDIGO_DESK.tenantId, checkoutId))?.status).toBe(
      'CAPTURE_PENDING',
    );
    expect(
      (await listCaptures(db, INDIGO_DESK.tenantId)).filter(
        (capture) => capture.checkoutId === checkoutId,
      ),
    ).toHaveLength(0);

    resetKernel();
    resetCheckouts();
    const capturedEvent = `evt_captured_${checkoutId}`;
    const captured = await send(capturedEvent, 'payment.captured');
    expect(captured.statusCode).toBe(200);

    resetKernel();
    resetCheckouts();
    const duplicate = await send(capturedEvent, 'payment.captured');
    expect(duplicate.statusCode).toBe(200);
    expect((await loadCheckout(db, INDIGO_DESK.tenantId, checkoutId))?.status).toBe('SETTLED');
    expect(
      (await listCaptures(db, INDIGO_DESK.tenantId)).filter(
        (capture) => capture.checkoutId === checkoutId,
      ),
    ).toHaveLength(1);

    const inboxRows = await withWebhookContext(db, INDIGO_DESK.tenantId, (trx) =>
      trx
        .withSchema('integration')
        .selectFrom('inbox_events')
        .select(['event_id', 'tenant_id', 'state'])
        .where('event_id', 'in', [failedEvent, authorizedEvent, capturedEvent])
        .execute(),
    );
    expect(inboxRows).toHaveLength(3);
    expect(
      inboxRows.every(
        (row) => row.tenant_id === INDIGO_DESK.tenantId && row.state === 'attributed',
      ),
    ).toBe(true);
    await app.close();
  });

  it('saves a hydrated checkout by loading its tenant-bound quote and cart', async () => {
    resetKernel();
    resetCheckouts();
    const cart = createCart(INDIGO_DESK.tenantId);
    addLine(cart.id, 'note.ruled-a5');
    const quote = freezeQuote(cart.id);
    const checkoutId = randomUUID();
    bindQuote(quote.id, checkoutId);
    const session = {
      id: checkoutId,
      tenantId: INDIGO_DESK.tenantId,
      quoteId: quote.id,
      receipt: `rcpt_${checkoutId.replaceAll('-', '').slice(0, 20)}`,
      razorpayOrderId: `order_${checkoutId}`,
      amountMinor: Number(quote.totalMinor),
      currency: 'INR' as const,
      status: 'CREATED' as const,
      paymentId: null,
      providerStatus: 'created',
      copy: 'Hydrated save fallback test checkout.',
    };
    await saveCart(db, cart);
    await saveQuote(db, quote, INDIGO_DESK.tenantId);
    await saveCheckout(db, INDIGO_DESK.tenantId, session);

    resetKernel();
    resetCheckouts();
    const updated = hydrateCheckout({
      ...session,
      status: 'FAILED_PROVISIONAL',
      providerStatus: 'failed',
    });
    const persist = await bootPersistence(db);
    await expect(persist.saveCheckout(updated)).resolves.toBeUndefined();
    expect(getQuote(quote.id)?.tenantId).toBe(INDIGO_DESK.tenantId);
    expect(getCart(cart.id)?.tenantId).toBe(INDIGO_DESK.tenantId);
    expect((await loadCheckout(db, INDIGO_DESK.tenantId, checkoutId))?.status).toBe(
      'FAILED_PROVISIONAL',
    );
  });

  it('serializes out-of-order provider transitions and inserts one capture', async () => {
    resetKernel();
    resetCheckouts();
    const cart = createCart(INDIGO_DESK.tenantId);
    addLine(cart.id, 'note.ruled-a5');
    const quote = freezeQuote(cart.id);
    const checkoutId = randomUUID();
    bindQuote(quote.id, checkoutId);
    const baseSession = {
      id: checkoutId,
      tenantId: INDIGO_DESK.tenantId,
      quoteId: quote.id,
      receipt: `rcpt_${checkoutId.replaceAll('-', '').slice(0, 20)}`,
      razorpayOrderId: `order_${checkoutId}`,
      amountMinor: Number(quote.totalMinor),
      currency: 'INR' as const,
      status: 'CREATED' as const,
      paymentId: null,
      providerStatus: 'created',
      copy: 'Transactional provider transition test.',
    };
    await saveCart(db, cart);
    await saveQuote(db, quote, INDIGO_DESK.tenantId);
    await saveCheckout(db, INDIGO_DESK.tenantId, baseSession);
    const persist = await bootPersistence(db);

    await persist.persistWebhookTransition({
      ...baseSession,
      status: 'FAILED_PROVISIONAL',
      paymentId: `pay_failed_${checkoutId}`,
      providerStatus: 'failed',
      copy: 'Failed evidence.',
    });
    await persist.persistWebhookTransition({
      ...baseSession,
      status: 'CAPTURE_PENDING',
      paymentId: `pay_authorized_${checkoutId}`,
      providerStatus: 'authorized',
      copy: 'Authorized evidence.',
    });
    expect((await loadCheckout(db, INDIGO_DESK.tenantId, checkoutId))?.providerStatus).toBe(
      'authorized',
    );

    await Promise.all([
      persist.persistWebhookTransition({
        ...baseSession,
        status: 'FAILED_PROVISIONAL',
        paymentId: `pay_failed_late_${checkoutId}`,
        providerStatus: 'failed',
        copy: 'Late failed evidence.',
      }),
      persist.persistWebhookTransition({
        ...baseSession,
        status: 'SETTLED',
        paymentId: `pay_captured_${checkoutId}`,
        providerStatus: 'captured',
        copy: 'Captured evidence.',
      }),
    ]);
    await persist.persistWebhookTransition({
      ...baseSession,
      status: 'CAPTURE_PENDING',
      paymentId: `pay_authorized_late_${checkoutId}`,
      providerStatus: 'authorized',
      copy: 'Late authorized evidence.',
    });

    const final = await loadCheckout(db, INDIGO_DESK.tenantId, checkoutId);
    expect(final).toMatchObject({
      status: 'SETTLED',
      providerStatus: 'captured',
      paymentId: `pay_captured_${checkoutId}`,
    });
    expect(
      (await listCaptures(db, INDIGO_DESK.tenantId)).filter(
        (capture) => capture.checkoutId === checkoutId,
      ),
    ).toHaveLength(1);
    const transitions = await listPaymentTransitions(db, INDIGO_DESK.tenantId, checkoutId);
    expect(transitions.map((row) => row.observedProviderStatus)).toEqual(
      expect.arrayContaining(['failed', 'authorized', 'captured']),
    );
    expect(transitions.filter((row) => row.observedProviderStatus === 'captured')).toHaveLength(1);
  });

  it('appends a refunded provider transition after capture and unfulfills the checkout', async () => {
    resetKernel();
    resetCheckouts();
    const cart = createCart(INDIGO_DESK.tenantId);
    addLine(cart.id, 'note.ruled-a5');
    const quote = freezeQuote(cart.id);
    const checkoutId = randomUUID();
    bindQuote(quote.id, checkoutId);
    const baseSession = {
      id: checkoutId,
      tenantId: INDIGO_DESK.tenantId,
      quoteId: quote.id,
      receipt: `rcpt_${checkoutId.replaceAll('-', '').slice(0, 20)}`,
      razorpayOrderId: `order_${checkoutId}`,
      amountMinor: Number(quote.totalMinor),
      currency: 'INR' as const,
      status: 'CREATED' as const,
      paymentId: null as string | null,
      providerStatus: 'created',
      copy: 'Refund transition fixture.',
    };
    await saveCart(db, cart);
    await saveQuote(db, quote, INDIGO_DESK.tenantId);
    await saveCheckout(db, INDIGO_DESK.tenantId, baseSession);
    const persist = await bootPersistence(db);

    await persist.persistWebhookTransition({
      ...baseSession,
      status: 'SETTLED',
      paymentId: `pay_captured_${checkoutId}`,
      providerStatus: 'captured',
      copy: 'Captured evidence.',
    });
    await persist.persistWebhookTransition({
      ...baseSession,
      status: 'RECONCILING',
      paymentId: `pay_captured_${checkoutId}`,
      providerStatus: 'refunded',
      copy: 'Refund evidence.',
    });

    const final = await loadCheckout(db, INDIGO_DESK.tenantId, checkoutId);
    expect(final).toMatchObject({
      status: 'RECONCILING',
      providerStatus: 'refunded',
      paymentId: `pay_captured_${checkoutId}`,
    });
    const persistedQuote = await loadQuote(db, INDIGO_DESK.tenantId, quote.id);
    expect(persistedQuote?.status).not.toBe('SETTLED');
    const ledger = (await listCaptures(db, INDIGO_DESK.tenantId)).filter(
      (entry) => entry.checkoutId === checkoutId,
    );
    expect(ledger.some((entry) => entry.kind === 'capture')).toBe(true);
    expect(
      ledger.some(
        (entry) =>
          entry.kind === 'refund' || entry.kind === 'void' || entry.kind === 'capture_reversal',
      ),
    ).toBe(true);
    const repository = createPostgresTenantRepository(db);
    const order = await repository.getMerchantOrder({
      userId: requesterId,
      tenantId: INDIGO_DESK.tenantId,
      orderId: checkoutId,
    });
    expect(order).toMatchObject({
      paid: false,
      fulfillmentReady: false,
    });
    expect(order?.quote.status).not.toBe('SETTLED');
    const recovery = await repository.getMerchantRecovery({
      userId: requesterId,
      tenantId: INDIGO_DESK.tenantId,
      checkoutId,
    });
    expect(recovery).toMatchObject({
      canSend: false,
      blockedReason: 'PAYMENT_REFUNDED',
    });
    expect(recovery?.reconciliationStatus).not.toBe('captured');
    expect(recovery?.stopStatus).not.toBe('captured');
    const transitions = await listPaymentTransitions(db, INDIGO_DESK.tenantId, checkoutId);
    expect(transitions.map((row) => row.observedProviderStatus)).toEqual(
      expect.arrayContaining(['captured', 'refunded']),
    );
    expect(transitions.filter((row) => row.observedProviderStatus === 'refunded')).toHaveLength(1);
  });
});
