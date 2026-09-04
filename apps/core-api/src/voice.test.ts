import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NORTHSTAR_TENANT } from '@charter/catalog';
import { createConversation, resetConversations } from '@charter/orchestrator';
import { loadConfig } from '@charter/config';
import { registerAuthContext } from './auth/context.js';
import {
  registerVoiceRoutes,
  resolveVoiceShopSlug,
  isIncompleteVoiceUtterance,
  VOICE_HOLD_REPLY,
} from './voice.js';
import { persistedConversationState } from './tenant/conversation-state.js';
import {
  authHeaders,
  TEST_USERS,
  testAuthVerifier,
  testTenantRepository,
} from './testing/security.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused',
  CHARTER_ENV: 'test',
  RAZORPAY_MODE: 'test',
});

describe('voice shop slug resolution', () => {
  it('accepts Vapi custom-LLM payloads from body, metadata, header, or query', () => {
    expect(
      resolveVoiceShopSlug({
        body: { messages: [], model: 'charter-concierge', stream: true },
      }),
    ).toBeUndefined();
    expect(resolveVoiceShopSlug({ body: { shopSlug: 'northstar' } })).toBe('northstar');
    expect(
      resolveVoiceShopSlug({
        body: { messages: [], metadata: { shopSlug: 'northstar' } },
      }),
    ).toBe('northstar');
    expect(
      resolveVoiceShopSlug({
        body: { messages: [] },
        header: 'northstar',
      }),
    ).toBe('northstar');
    expect(
      resolveVoiceShopSlug({
        body: { messages: [] },
        query: { shopSlug: 'northstar' },
      }),
    ).toBe('northstar');
    expect(resolveVoiceShopSlug({ body: { shopSlug: 'Not A Slug' } })).toBeUndefined();
  });
});

describe('voice custom LLM route', () => {
  beforeEach(() => {
    resetConversations();
    vi.unstubAllGlobals();
  });

  it('completes an OpenAI-shaped Vapi request using the shop slug header', async () => {
    const repository = testTenantRepository();
    const conversation = createConversation(NORTHSTAR_TENANT);
    await repository.claimResource(
      'conversation',
      NORTHSTAR_TENANT,
      conversation.id,
      TEST_USERS.buyer,
    );
    conversation.revision = await repository.saveConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
      expectedRevision: 0,
      state: persistedConversationState(conversation),
    });
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerVoiceRoutes(app, config, null, repository);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/voice/${conversation.id}/chat/completions`,
      headers: {
        ...authHeaders('buyer'),
        'x-charter-shop-slug': 'northstar',
      },
      payload: {
        model: 'charter-concierge',
        stream: false,
        messages: [{ role: 'user', content: 'what products are available' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().choices[0].message.role).toBe('assistant');
    expect(response.json().choices[0].message.content).toMatch(
      /PocketGrind|Trail|press|filter|Available/i,
    );
    await app.close();
  });

  it('rejects an authenticated Vapi body that cannot resolve a shop', async () => {
    const repository = testTenantRepository();
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerVoiceRoutes(app, config, null, repository);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/voice/82000000-0000-4000-8000-000000000099/chat/completions',
      headers: authHeaders('buyer'),
      payload: {
        model: 'charter-concierge',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('SHOP_SLUG_REQUIRED');
    await app.close();
  });
});

describe('voice utterance completeness', () => {
  it('holds on hanging shopkeeper fragments and lets complete shop turns through', () => {
    expect(isIncompleteVoiceUtterance('So we can log the total—')).toBe(true);
    expect(isIncompleteVoiceUtterance("Okay, let's pick the.")).toBe(true);
    expect(isIncompleteVoiceUtterance('Amount.')).toBe(true);
    expect(isIncompleteVoiceUtterance('Add the')).toBe(true);
    expect(isIncompleteVoiceUtterance('Checkout.')).toBe(false);
    expect(isIncompleteVoiceUtterance("Let's log the total.")).toBe(false);
    expect(isIncompleteVoiceUtterance('Add the steel travel press')).toBe(false);
    expect(isIncompleteVoiceUtterance('what products are available')).toBe(false);
  });

  it('does not run a shop turn for an incomplete Vapi fragment', async () => {
    const repository = testTenantRepository();
    const conversation = createConversation(NORTHSTAR_TENANT);
    await repository.claimResource(
      'conversation',
      NORTHSTAR_TENANT,
      conversation.id,
      TEST_USERS.buyer,
    );
    conversation.revision = await repository.saveConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
      expectedRevision: 0,
      state: persistedConversationState(conversation),
    });
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerVoiceRoutes(app, config, null, repository);

    const held = await app.inject({
      method: 'POST',
      url: `/v1/voice/${conversation.id}/chat/completions`,
      headers: {
        ...authHeaders('buyer'),
        'x-charter-shop-slug': 'northstar',
      },
      payload: {
        model: 'charter-concierge',
        stream: false,
        messages: [{ role: 'user', content: "Okay, let's pick the." }],
      },
    });
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json().choices[0].message.content).toBe(VOICE_HOLD_REPLY);

    const loaded = await repository.loadConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
    });
    expect(loaded?.state).toEqual(persistedConversationState(conversation));
    await app.close();
  });
});
