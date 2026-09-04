import { describe, expect, it } from 'vitest';
import { createAgentMailSender } from './agentmail.js';

describe('agentmail sender', () => {
  it('is off when keys are missing', () => {
    const sender = createAgentMailSender({ apiKey: '', inbox: '' });
    expect(sender.configured).toBe(false);
  });

  it('posts text mail from the configured inbox', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const sender = createAgentMailSender(
      { apiKey: 'am_test', inbox: 'demo@agentmail.to' },
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ messageId: 'msg_1' }), { status: 200 });
      },
    );
    const sent = await sender.send({
      to: 'shopper@example.com',
      subject: 'Payment not confirmed',
      text: 'Do not assume nothing was charged.',
    });
    expect(sent.messageId).toBe('msg_1');
    expect(calls[0]?.url).toBe(
      'https://api.agentmail.to/v0/inboxes/demo%40agentmail.to/messages/send',
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer am_test',
    });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.to).toBe('shopper@example.com');
    expect(body.text).toContain('Do not assume nothing was charged.');
  });
});
