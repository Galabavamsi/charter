import { describe, expect, it, vi } from 'vitest';
import { createFireworksClient, stripThinking } from './fireworks.js';

describe('Fireworks client', () => {
  it('aborts a hanging completion so the resilient client can fall back', async () => {
    const httpFetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'TimeoutError';
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const client = createFireworksClient('fw_test', '', httpFetch, 20);
    await expect(client.complete([{ role: 'user', content: 'Buy now' }])).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(httpFetch).toHaveBeenCalled();
  });

  it('keeps id-less tool calls, coerces object arguments, and strips reasoning text', async () => {
    const httpFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '<think>The shopper wants a grinder.</think>',
                  tool_calls: [
                    {
                      function: {
                        name: 'cart.add_line',
                        arguments: { sku: 'grinder.pocket-lite' },
                      },
                    },
                    { id: 'call_b', function: { name: 'checkout.quote' } },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const client = createFireworksClient('fw_test', '', httpFetch);
    const message = await client.complete([{ role: 'user', content: 'add the grinder' }]);
    expect(message.role).toBe('assistant');
    if (message.role !== 'assistant') {
      return;
    }
    expect(message.content).toBeNull();
    expect(message.tool_calls).toHaveLength(2);
    expect(message.tool_calls?.[0]?.id).toMatch(/^call_0_/);
    expect(message.tool_calls?.[0]?.function.arguments).toBe('{"sku":"grinder.pocket-lite"}');
    expect(message.tool_calls?.[1]).toMatchObject({
      id: 'call_b',
      function: { name: 'checkout.quote', arguments: '{}' },
    });
  });

  it('strips an unterminated reasoning block from the reply', () => {
    expect(stripThinking('<think>still thinking')).toBe('');
    expect(stripThinking('<think>a</think>\nHere are the grinders.')).toBe(
      'Here are the grinders.',
    );
  });
});
