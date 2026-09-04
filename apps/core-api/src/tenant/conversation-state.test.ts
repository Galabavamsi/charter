import { describe, expect, it } from 'vitest';
import {
  persistedConversationState,
  reconcilePersistedConversationState,
} from './conversation-state.js';

describe('persisted conversation state', () => {
  it('keeps checkout handoff fields while removing secrets and raw payment credentials', () => {
    const state = persistedConversationState({
      cartId: null,
      quoteId: null,
      catalogLoaded: false,
      pendingCheckout: {
        checkoutId: '87000000-0000-4000-8000-000000000001',
        orderId: 'order_safe',
        amount: 50000,
        currency: 'INR',
        keySecret: 'must-not-persist',
        cardNumber: '4111111111111111',
      },
      messages: [
        { role: 'user', content: 'Use card 4111111111111111 with cvv 123' },
        {
          role: 'assistant',
          content: 'I will use the hosted checkout.',
          tool_calls: [
            {
              id: 'call_credential',
              type: 'function',
              function: {
                name: 'checkout.prepare',
                arguments: '{"key_secret":"must-not-persist","cardNumber":"4111111111111111"}',
              },
            },
          ],
        },
      ],
    });

    expect(state.pendingCheckout).toEqual({
      checkoutId: '87000000-0000-4000-8000-000000000001',
      orderId: 'order_safe',
      amount: 50000,
      currency: 'INR',
    });
    expect(JSON.stringify(state)).not.toContain('must-not-persist');
    expect(JSON.stringify(state)).not.toContain('4111111111111111');
    expect(JSON.stringify(state)).not.toContain('cvv 123');
  });

  it('preserves a consumed checkout and merges independent turn updates', () => {
    const checkout = {
      checkoutId: '87000000-0000-4000-8000-000000000002',
      orderId: 'order_consumed_during_turn',
    };
    const base = {
      cartId: '80000000-0000-4000-8000-000000000001',
      quoteId: '81000000-0000-4000-8000-000000000001',
      catalogLoaded: false,
      pendingCheckout: checkout,
      messages: [{ role: 'system', content: 'base' }],
    };
    const local = {
      ...base,
      cartId: '80000000-0000-4000-8000-000000000002',
      messages: [
        ...base.messages,
        { role: 'user', content: 'local turn' },
        { role: 'assistant', content: 'local reply' },
      ],
    };
    const latest = {
      ...base,
      quoteId: '81000000-0000-4000-8000-000000000002',
      pendingCheckout: null,
      messages: [...base.messages, { role: 'user', content: 'concurrent turn' }],
    };

    expect(reconcilePersistedConversationState(base, local, latest)).toEqual({
      cartId: local.cartId,
      quoteId: latest.quoteId,
      catalogLoaded: false,
      pendingCheckout: null,
      messages: [...latest.messages, ...local.messages.slice(base.messages.length)],
    });
  });

  it('rejects overlapping state changes instead of dropping newer values', () => {
    const base = {
      cartId: '80000000-0000-4000-8000-000000000010',
      quoteId: null,
      catalogLoaded: false,
      pendingCheckout: null,
      messages: [],
    };

    expect(() =>
      reconcilePersistedConversationState(
        base,
        { ...base, cartId: '80000000-0000-4000-8000-000000000011' },
        { ...base, cartId: '80000000-0000-4000-8000-000000000012' },
      ),
    ).toThrow('CONVERSATION_VERSION_CONFLICT');
  });
});
