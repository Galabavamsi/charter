import { describe, expect, it } from 'vitest';
import { redactTraces } from './observe.js';

describe('langfuse redaction', () => {
  it('keeps tool names and policy reasons, drops checkout secrets', () => {
    const redacted = redactTraces([
      {
        name: 'checkout.prepare',
        result: {
          checkout: { keyId: 'rzp_test_hidden', orderId: 'order_1' },
          decision: { outcome: 'allow', reason: 'ALLOW' },
        },
      },
      {
        name: 'cart.add_line',
        result: { decision: { outcome: 'deny', reason: 'PRODUCT_MATERIAL_FORBIDDEN' } },
      },
    ]);
    expect(JSON.stringify(redacted)).not.toContain('rzp_test_hidden');
    expect(redacted[1]?.decision?.reason).toBe('PRODUCT_MATERIAL_FORBIDDEN');
  });
});
