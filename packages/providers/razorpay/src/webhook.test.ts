import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRazorpayReceipt, verifyRazorpayWebhookSignature } from './webhook.js';

describe('verifyRazorpayWebhookSignature', () => {
  it('accepts HMAC of the exact raw bytes', () => {
    const secret = 'whsec_test';
    const rawBody = Buffer.from('{"event":"payment.captured"}', 'utf8');
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(
      verifyRazorpayWebhookSignature({
        rawBody,
        signatureHeader: signature,
        secret,
      }),
    ).toBe(true);
  });

  it('rejects a parsed-then-restringified body', () => {
    const secret = 'whsec_test';
    const rawBody = Buffer.from('{ "event": "payment.captured" }', 'utf8');
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    const reencoded = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString())), 'utf8');
    expect(reencoded.equals(rawBody)).toBe(false);
    expect(
      verifyRazorpayWebhookSignature({
        rawBody: reencoded,
        signatureHeader: signature,
        secret,
      }),
    ).toBe(false);
  });
});

describe('buildRazorpayReceipt', () => {
  it('stays within 40 characters', () => {
    expect(buildRazorpayReceipt('01ARZ3NDEKTSV4RRFFQ69G5FAV').length).toBeLessThanOrEqual(40);
  });
});
