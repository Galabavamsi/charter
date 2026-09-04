import { describe, expect, it } from 'vitest';
import { isActiveMembershipAllowed, type ShopMembershipRecord } from './authorization.js';

const owner: ShopMembershipRecord = {
  tenantId: 'northstar-demo-in',
  userId: '01000000-0000-4000-8000-000000000001',
  role: 'owner',
  status: 'active',
};

describe('membership authorization', () => {
  it('requires an active persisted membership role', () => {
    expect(isActiveMembershipAllowed(owner, ['owner', 'admin'])).toBe(true);
    expect(isActiveMembershipAllowed(owner, ['viewer'])).toBe(false);
    expect(isActiveMembershipAllowed({ ...owner, status: 'suspended' }, ['owner'])).toBe(false);
    expect(isActiveMembershipAllowed(undefined, ['owner'])).toBe(false);
  });
});
