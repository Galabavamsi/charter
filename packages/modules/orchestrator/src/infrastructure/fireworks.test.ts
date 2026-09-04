import { describe, expect, it, vi } from 'vitest';
import { createFireworksClient } from './fireworks.js';

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
});
