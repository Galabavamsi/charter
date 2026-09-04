import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '@charter/config';

const config = loadConfig();
const ownerDatabaseUrl = config.DATABASE_URL;
const rolePassword = process.env.CHARTER_APP_PASSWORD;

if (!ownerDatabaseUrl) {
  throw new Error('DATABASE_URL_REQUIRED_FOR_ROLE_PROVISIONING');
}
if (!rolePassword || rolePassword.length < 16) {
  throw new Error('CHARTER_APP_PASSWORD_REQUIRED');
}

const provisioningPath = fileURLToPath(
  new URL('../../../supabase/roles/001_charter_app.sql', import.meta.url),
);
const provisioningSql = await readFile(provisioningPath, 'utf8');
const client = new pg.Client({ connectionString: ownerDatabaseUrl });

await client.connect();
try {
  await client.query('begin');
  await client.query(provisioningSql);
  await client.query('select pg_temp.provision_charter_app($1)', [rolePassword]);
  await client.query('commit');
  console.log('charter_app role provisioned');
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
