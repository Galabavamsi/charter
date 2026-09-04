import type { Kysely } from 'kysely';
import { withAuthContext, type AuthContext } from './tenant.js';
import type { Database, PlatformRole, ShopMembershipRole, ShopMembershipStatus } from './types.js';

export type ShopMembershipRecord = {
  tenantId: string;
  userId: string;
  role: ShopMembershipRole;
  status: ShopMembershipStatus;
};

export type AuthorizationSnapshot = {
  context: AuthContext;
  membership: ShopMembershipRecord | undefined;
  platformRoles: PlatformRole[];
};

export type AuthorizationRepository = {
  resolve(context: AuthContext): Promise<AuthorizationSnapshot>;
  requireActiveMembership(
    context: AuthContext,
    allowedRoles?: readonly ShopMembershipRole[],
  ): Promise<ShopMembershipRecord>;
  hasPlatformRole(context: AuthContext, allowedRoles: readonly PlatformRole[]): Promise<boolean>;
};

export function isActiveMembershipAllowed(
  membership: ShopMembershipRecord | undefined,
  allowedRoles?: readonly ShopMembershipRole[],
): boolean {
  return (
    membership?.status === 'active' &&
    (allowedRoles === undefined || allowedRoles.includes(membership.role))
  );
}

export function createAuthorizationRepository(db: Kysely<Database>): AuthorizationRepository {
  const resolve = async (context: AuthContext): Promise<AuthorizationSnapshot> =>
    withAuthContext(db, context, async (trx) => {
      const membershipRow = await trx
        .withSchema('identity')
        .selectFrom('shop_memberships as membership')
        .innerJoin('users as application_user', 'application_user.id', 'membership.user_id')
        .innerJoin('tenants as tenant', 'tenant.id', 'membership.tenant_id')
        .select([
          'membership.tenant_id',
          'membership.user_id',
          'membership.role',
          'membership.status',
        ])
        .where('membership.tenant_id', '=', context.tenantId)
        .where('membership.user_id', '=', context.userId.toLowerCase())
        .where('membership.status', '=', 'active')
        .where('application_user.status', '=', 'active')
        .where('tenant.status', '=', 'active')
        .executeTakeFirst();
      const platformRoleRows = await trx
        .withSchema('identity')
        .selectFrom('platform_roles as platform_role')
        .innerJoin('users as application_user', 'application_user.id', 'platform_role.user_id')
        .innerJoin('tenants as tenant', (join) => join.on('tenant.id', '=', context.tenantId))
        .select('platform_role.role')
        .where('platform_role.user_id', '=', context.userId.toLowerCase())
        .where('application_user.status', '=', 'active')
        .where('tenant.status', '=', 'active')
        .orderBy('platform_role.role')
        .execute();

      return {
        context: {
          userId: context.userId.toLowerCase(),
          tenantId: context.tenantId,
        },
        membership: membershipRow
          ? {
              tenantId: membershipRow.tenant_id,
              userId: membershipRow.user_id,
              role: membershipRow.role,
              status: membershipRow.status,
            }
          : undefined,
        platformRoles: platformRoleRows.map((row) => row.role),
      };
    });

  return {
    resolve,
    async requireActiveMembership(context, allowedRoles) {
      const snapshot = await resolve(context);
      const membership = snapshot.membership;
      if (!membership || !isActiveMembershipAllowed(membership, allowedRoles)) {
        throw new Error('SHOP_MEMBERSHIP_REQUIRED');
      }
      return membership;
    },
    async hasPlatformRole(context, allowedRoles) {
      const snapshot = await resolve(context);
      return snapshot.platformRoles.some((role) => allowedRoles.includes(role));
    },
  };
}
