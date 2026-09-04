import { describe, expect, it } from 'vitest';
import {
  canDecideApprovals,
  canDecideCatalogPublish,
  canDecideRefunds,
  canManageCatalog,
  canManageControlKills,
  canOperateRecovery,
  canReadControl,
  canReadRegister,
  merchantSectionForRole,
} from './capabilities';
import type { PlatformRole, ShopRole } from './account';

const shopRoles: ShopRole[] = ['owner', 'admin', 'catalog', 'support', 'finance', 'viewer'];
const platformRoles: PlatformRole[] = ['admin', 'operator', 'auditor'];

describe('frontend capability matrix', () => {
  it.each([
    ['owner', true, true, true, true],
    ['admin', true, true, true, true],
    ['catalog', true, true, false, false],
    ['support', true, false, false, true],
    ['finance', true, false, false, false],
    ['viewer', true, false, false, false],
  ] as const)(
    'matches backend shop capabilities for %s',
    (role, registerRead, catalogWrite, approvalWrite, recoveryOperate) => {
      expect(shopRoles).toContain(role);
      expect(canReadRegister(role)).toBe(registerRead);
      expect(canManageCatalog(role)).toBe(catalogWrite);
      expect(canDecideApprovals(role)).toBe(approvalWrite);
      expect(canOperateRecovery(role)).toBe(recoveryOperate);
      expect(canDecideCatalogPublish(role)).toBe(
        role === 'owner' || role === 'admin' || role === 'catalog',
      );
      expect(canDecideRefunds(role)).toBe(
        role === 'owner' || role === 'admin' || role === 'finance',
      );
    },
  );

  it('lands a viewer on an allowed section when switching shops', () => {
    expect(merchantSectionForRole('viewer', 'recovery')).toBe('overview');
    expect(merchantSectionForRole('support', 'recovery')).toBe('recovery');
    expect(merchantSectionForRole('viewer', 'catalog')).toBe('catalog');
  });

  it.each([
    ['admin', true, true],
    ['operator', true, false],
    ['auditor', false, false],
  ] as const)('matches backend Control capabilities for %s', (role, read, kill) => {
    expect(platformRoles).toContain(role);
    expect(canReadControl([role])).toBe(read);
    expect(canManageControlKills([role])).toBe(kill);
  });
});
