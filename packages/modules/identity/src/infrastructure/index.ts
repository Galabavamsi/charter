import { withAuthContext, type AuthContext, type Database, type Kysely } from '@charter/db';
import type { Tenant } from '../domain/index.js';

export type ShopProvisioningRepository = {
  provision(context: AuthContext, tenant: Tenant): Promise<Tenant>;
};

export function createShopProvisioningRepository(db: Kysely<Database>): ShopProvisioningRepository {
  return {
    async provision(context, tenant) {
      await withAuthContext(db, context, async (trx) => {
        await trx
          .withSchema('identity')
          .insertInto('tenants')
          .values({
            id: tenant.id,
            label: tenant.label,
            synthetic: tenant.synthetic,
            created_at: new Date(),
          })
          .onConflict((conflict) =>
            conflict.column('id').doUpdateSet({
              label: tenant.label,
              synthetic: tenant.synthetic,
            }),
          )
          .execute();
      });
      return tenant;
    },
  };
}
