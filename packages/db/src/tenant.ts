import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './types.js';

export type AuthContext = {
  userId: string;
  tenantId: string;
};

export type UserContext = {
  userId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function withUserContext<T>(
  db: Kysely<Database>,
  context: UserContext,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(context.userId)) {
    throw new Error('AUTH_CONTEXT_USER_ID_INVALID');
  }
  return db.transaction().execute(async (trx) => {
    await sql`
      select
        set_config('app.user_id', ${context.userId.toLowerCase()}, true),
        set_config('app.tenant_id', '', true),
        set_config('app.service_context', '', true)
    `.execute(trx);
    return work(trx);
  });
}

export async function withAuthContext<T>(
  db: Kysely<Database>,
  context: AuthContext,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(context.userId)) {
    throw new Error('AUTH_CONTEXT_USER_ID_INVALID');
  }
  if (!TENANT_ID.test(context.tenantId)) {
    throw new Error('AUTH_CONTEXT_TENANT_ID_INVALID');
  }

  return db.transaction().execute(async (trx) => {
    await sql`
      select
        set_config('app.user_id', ${context.userId.toLowerCase()}, true),
        set_config('app.tenant_id', ${context.tenantId}, true),
        set_config('app.service_context', '', true)
    `.execute(trx);
    return work(trx);
  });
}

/**
 * Restricted context for published catalog reads. RLS still limits this context
 * to active tenants and published shops, products, variants, and inventory.
 */
export async function withPublicCatalogContext<T>(
  db: Kysely<Database>,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`
      select
        set_config('app.user_id', '', true),
        set_config('app.tenant_id', '', true),
        set_config('app.service_context', 'public_catalog', true)
    `.execute(trx);
    return work(trx);
  });
}

/**
 * Restricted server-side context for legacy machine workflows.
 * The database policy also verifies that the current database role is charter_app
 * (or a narrowly named role in an ephemeral schema-auth test database).
 */
export async function withMachineTenant<T>(
  db: Kysely<Database>,
  tenantId: string,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (!TENANT_ID.test(tenantId)) {
    throw new Error('MACHINE_CONTEXT_TENANT_ID_INVALID');
  }

  return db.transaction().execute(async (trx) => {
    await sql`
      select
        set_config('app.user_id', '', true),
        set_config('app.tenant_id', ${tenantId}, true),
        set_config('app.service_context', 'machine', true)
    `.execute(trx);
    return work(trx);
  });
}

export async function withWebhookContext<T>(
  db: Kysely<Database>,
  tenantId: string | undefined,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (tenantId !== undefined && !TENANT_ID.test(tenantId)) {
    throw new Error('WEBHOOK_CONTEXT_TENANT_ID_INVALID');
  }

  return db.transaction().execute(async (trx) => {
    await sql`
      select
        set_config('app.user_id', '', true),
        set_config('app.tenant_id', ${tenantId ?? ''}, true),
        set_config('app.service_context', 'webhook', true)
    `.execute(trx);
    return work(trx);
  });
}
