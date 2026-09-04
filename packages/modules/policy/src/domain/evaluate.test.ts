import { describe, expect, it } from 'vitest';
import { POLICY_REASON } from '@charter/domain-shared';
import { evaluateProposedTotal } from './evaluate.js';

describe('proposed total policy', () => {
  it('requires approval above the autonomous cap until Register grants it', () => {
    expect(evaluateProposedTotal(284700n).reason).toBe(POLICY_REASON.AUTHORITY_APPROVAL_REQUIRED);
    expect(evaluateProposedTotal(284700n, undefined, 284700n).outcome).toBe('allow');
  });

  it('still denies above the hard cap after a grant', () => {
    expect(evaluateProposedTotal(300100n, undefined, 300100n).reason).toBe(
      POLICY_REASON.HARD_CAP_EXCEEDED,
    );
  });
});
