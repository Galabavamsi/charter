import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, buildSystemPrompt } from './prompt.js';

describe('bound Concierge prompt', () => {
  it('forbids reliability puffery because there are no metrics tools', () => {
    const prompt = buildSystemPrompt();
    expect(PROMPT_VERSION).toBe('concierge.tenant.v6');
    expect(prompt).toMatch(/Do not call this shop the most reliable/);
    expect(prompt).toMatch(/you have no metrics tools/);
    expect(prompt).toMatch(/Refund policy \(merchant copy/);
    expect(prompt).toMatch(/cart.set_quantity/);
    expect(prompt).toMatch(/cart.set_quantities/);
    expect(prompt).toMatch(/Talk like a shopkeeper/);
    expect(prompt).toMatch(/Do not skip quantity and jump to pay/);
    expect(prompt).not.toMatch(/most reliable shop/i);
  });
});
