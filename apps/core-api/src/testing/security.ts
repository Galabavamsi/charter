import type { AuthVerifier, VerifiedIdentity } from '../auth/verifier.js';
import {
  createMemoryTenantRepository,
  type MemoryTenantRepository,
} from './memory-tenant-repository.js';

export const TEST_USERS = {
  northstarOwner: '71000000-0000-4000-8000-000000000001',
  buyer: '71000000-0000-4000-8000-000000000002',
  platformAdmin: '71000000-0000-4000-8000-000000000003',
  northstarFinance: '71000000-0000-4000-8000-000000000004',
  northstarCatalog: '71000000-0000-4000-8000-000000000005',
} as const;

const identities = new Map<string, VerifiedIdentity>([
  [
    'northstar-owner',
    { userId: TEST_USERS.northstarOwner, email: 'northstar-owner@example.invalid' },
  ],
  ['buyer', { userId: TEST_USERS.buyer, email: 'buyer@example.invalid' }],
  ['platform-admin', { userId: TEST_USERS.platformAdmin, email: 'admin@example.invalid' }],
  ['northstar-finance', { userId: TEST_USERS.northstarFinance, email: 'finance@example.invalid' }],
  ['northstar-catalog', { userId: TEST_USERS.northstarCatalog, email: 'catalog@example.invalid' }],
]);

export function testAuthVerifier(): AuthVerifier {
  return {
    async verify(token) {
      const identity = identities.get(token);
      if (!identity) {
        throw new Error('AUTH_INVALID_TOKEN');
      }
      return identity;
    },
  };
}

export function testTenantRepository(): MemoryTenantRepository {
  return createMemoryTenantRepository({
    memberships: [
      {
        userId: TEST_USERS.northstarOwner,
        tenantId: 'northstar-demo-in',
        role: 'owner',
      },
      {
        userId: TEST_USERS.northstarFinance,
        tenantId: 'northstar-demo-in',
        role: 'finance',
      },
      {
        userId: TEST_USERS.northstarCatalog,
        tenantId: 'northstar-demo-in',
        role: 'catalog',
      },
    ],
    platformRoles: [{ userId: TEST_USERS.platformAdmin, role: 'admin' }],
  });
}

export function authHeaders(
  token: 'northstar-owner' | 'buyer' | 'platform-admin' | 'northstar-finance' | 'northstar-catalog',
) {
  return { authorization: `Bearer ${token}` };
}
