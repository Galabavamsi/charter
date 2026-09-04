import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

export type MigrationFile = {
  id: string;
  filename: string;
  path: string;
  checksum: string;
  sql: string;
};

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

export const migrationDirectory = fileURLToPath(
  new URL('../../../supabase/migrations/', import.meta.url),
);
export const seedFilePath = fileURLToPath(new URL('../../../supabase/seed.sql', import.meta.url));

const MIGRATION_FILENAME = /^\d{14}_[a-z0-9_]+\.sql$/;

export async function loadMigrationFiles(
  directory: string = migrationDirectory,
): Promise<MigrationFile[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    filenames.map(async (filename) => {
      if (!MIGRATION_FILENAME.test(filename)) {
        throw new Error(`MIGRATION_FILENAME_INVALID: ${filename}`);
      }
      const path = join(directory, filename);
      const contents = await readFile(path, 'utf8');
      if (!contents.trim()) {
        throw new Error(`MIGRATION_EMPTY: ${filename}`);
      }
      return {
        id: filename.slice(0, -'.sql'.length),
        filename,
        path,
        checksum: createHash('sha256').update(contents).digest('hex'),
        sql: contents,
      };
    }),
  );
}

async function ensureMigrationTable(db: Kysely<Database>): Promise<void> {
  await sql`
    create schema if not exists charter_migrations;
    create table if not exists charter_migrations.schema_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `.execute(db);
}

export async function migrateDatabase(
  db: Kysely<Database>,
  directory: string = migrationDirectory,
): Promise<MigrationResult> {
  await ensureMigrationTable(db);
  const migrations = await loadMigrationFiles(directory);
  const appliedRows = await sql<{ id: string; checksum: string }>`
    select id, checksum
    from charter_migrations.schema_migrations
    order by id
  `.execute(db);
  const appliedChecksums = new Map(appliedRows.rows.map((row) => [row.id, row.checksum] as const));
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    const appliedChecksum = appliedChecksums.get(migration.id);
    if (appliedChecksum) {
      if (appliedChecksum !== migration.checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH: ${migration.id}`);
      }
      result.skipped.push(migration.id);
      continue;
    }

    await db.transaction().execute(async (trx) => {
      await sql.raw(migration.sql).execute(trx);
      await sql`
        insert into charter_migrations.schema_migrations (id, checksum)
        values (${migration.id}, ${migration.checksum})
      `.execute(trx);
    });
    result.applied.push(migration.id);
  }

  return result;
}

export async function seedDatabase(
  db: Kysely<Database>,
  path: string = seedFilePath,
): Promise<void> {
  const contents = await readFile(path, 'utf8');
  if (!contents.trim()) {
    throw new Error('SEED_EMPTY');
  }
  await sql.raw(contents).execute(db);
}

export async function resetApplicationDatabase(db: Kysely<Database>): Promise<void> {
  await sql`
    drop schema if exists operations cascade;
    drop schema if exists recovery cascade;
    drop schema if exists conversation cascade;
    drop schema if exists policy cascade;
    drop schema if exists catalog cascade;
    drop schema if exists integration cascade;
    drop schema if exists ledger cascade;
    drop schema if exists payments cascade;
    drop schema if exists commerce cascade;
    drop schema if exists identity cascade;
    drop schema if exists app_private cascade;
    drop schema if exists charter_migrations cascade;
    drop function if exists public.charter_set_updated_at() cascade;
  `.execute(db);
}
