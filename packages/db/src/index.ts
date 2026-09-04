import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export type * from './types.js';
export type { Kysely, Transaction } from 'kysely';
export { sql };
export {
  createAuthorizationRepository,
  isActiveMembershipAllowed,
  type AuthorizationRepository,
  type AuthorizationSnapshot,
  type ShopMembershipRecord,
} from './authorization.js';
export {
  loadMigrationFiles,
  migrateDatabase,
  migrationDirectory,
  resetApplicationDatabase,
  seedDatabase,
  seedFilePath,
  type MigrationFile,
  type MigrationResult,
} from './migrations.js';
export {
  withAuthContext,
  withUserContext,
  withPublicCatalogContext,
  withMachineTenant,
  withWebhookContext,
  type AuthContext,
  type UserContext,
} from './tenant.js';

export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export async function pingDb(db: Kysely<Database>): Promise<boolean> {
  await sql`select 1`.execute(db);
  return true;
}
