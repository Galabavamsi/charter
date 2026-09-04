import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = fileURLToPath(
  new URL('../../../supabase/migrations/', import.meta.url),
);
const seedPath = fileURLToPath(new URL('../../../supabase/seed.sql', import.meta.url));
const commercePersistencePath = fileURLToPath(
  new URL('../../modules/commerce/src/infrastructure/index.ts', import.meta.url),
);
const paymentsPersistencePath = fileURLToPath(
  new URL('../../modules/payments/src/infrastructure/index.ts', import.meta.url),
);
const ledgerPersistencePath = fileURLToPath(
  new URL('../../modules/ledger/src/infrastructure/index.ts', import.meta.url),
);
const turboPath = fileURLToPath(new URL('../../../turbo.json', import.meta.url));
const ciPath = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
const rootPackagePath = fileURLToPath(new URL('../../../package.json', import.meta.url));
const roleProvisioningPath = fileURLToPath(
  new URL('../../../supabase/roles/001_charter_app.sql', import.meta.url),
);
const roleProvisioningRunnerPath = fileURLToPath(new URL('./provision-role.ts', import.meta.url));
const corePersistencePath = fileURLToPath(
  new URL('../../../apps/core-api/src/persist.ts', import.meta.url),
);
const corePersistenceTestPath = fileURLToPath(
  new URL('../../../apps/core-api/src/persist.test.ts', import.meta.url),
);
const recoveryPostgresTestPath = fileURLToPath(
  new URL('../../../apps/core-api/src/recovery.postgres.test.ts', import.meta.url),
);
const identityPersistencePath = fileURLToPath(
  new URL('../../modules/identity/src/infrastructure/index.ts', import.meta.url),
);

async function migrationSql(): Promise<{ files: string[]; sql: string }> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  const contents = await Promise.all(
    files.map((file) =>
      readFile(new URL(file, `file:///${migrationsDirectory.replaceAll('\\', '/')}/`), 'utf8'),
    ),
  );
  return { files, sql: contents.join('\n').toLowerCase().replaceAll(/\s+/g, ' ') };
}

describe('canonical Supabase schema history', () => {
  it('versions the money kernel before the secure foundation', async () => {
    const { files, sql } = await migrationSql();

    expect(files).toHaveLength(24);
    expect(files[0]).toMatch(/_money_kernel\.sql$/);
    expect(files[1]).toMatch(/_secure_schema_auth_foundation\.sql$/);
    expect(files[2]).toMatch(/_tenant_api_durability\.sql$/);
    expect(files[3]).toMatch(/_catalog_auth_remediation\.sql$/);
    expect(files[4]).toMatch(/_webhook_durability_remediation\.sql$/);
    expect(files[5]).toMatch(/_tenant_api_durability_completion\.sql$/);
    expect(files[6]).toMatch(/_recovery_send_idempotency\.sql$/);
    expect(files[7]).toMatch(/_conversation_revision_cas\.sql$/);
    expect(files[8]).toMatch(/_public_directory\.sql$/);
    expect(files[9]).toMatch(/_merchant_workspace\.sql$/);
    expect(files[10]).toMatch(/_payment_reconciliation\.sql$/);
    expect(files[11]).toMatch(/_membership_self_listing\.sql$/);
    expect(files[12]).toMatch(/_typed_approvals_pii\.sql$/);
    expect(files[13]).toMatch(/_quote_fact_pinning\.sql$/);
    expect(files[14]).toMatch(/_catalog_machine_fact_reads\.sql$/);
    expect(files[15]).toMatch(/_typed_approval_resources\.sql$/);
    expect(files[16]).toMatch(/_recovery_offer_evidence\.sql$/);
    expect(files[17]).toMatch(/_quote_fact_hash_check\.sql$/);
    expect(files[18]).toMatch(/_shop_policies_machine_update\.sql$/);
    expect(files[19]).toMatch(/_shop_directory_metrics\.sql$/);
    expect(files[20]).toMatch(/_shop_profile_and_discovery\.sql$/);
    expect(files[21]).toMatch(/_seeded_shop_gift_caps\.sql$/);
    expect(files[22]).toMatch(/_seeded_shop_catalog_expand\.sql$/);
    expect(files[23]).toMatch(/_sandbox_fulfillment\.sql$/);
    expect(sql).toContain('add column if not exists rating_milli');
    expect(sql).toContain('add column if not exists gstin');
    expect(sql).toContain('create table catalog.search_events');
    expect(sql).toContain('create table catalog.recommendation_impressions');
    expect(sql).toContain('add column if not exists resource_id text');
    expect(sql).toContain('create policy shops_machine_read');
    expect(sql).toContain('create policy products_machine_read');
    expect(sql).toContain('create policy inventory_machine_read');
    expect(sql).toContain('create policy shop_policies_machine_update');
    expect(sql).toContain('create table commerce.carts');
    expect(sql).toContain('approved_through_minor');
    expect(sql).toContain('add column revision bigint not null default 0');
    expect(sql).toContain('add column catalog_version integer not null default 1');
    expect(sql).toContain('add column fact_hash text not null default');
    expect(sql).toContain("fact_hash ~ '^[a-f0-9]{64}$'");
    expect(sql).toContain('check (version_before >= 0)');
    expect(sql).not.toContain('money_kernel_sql');
  });

  it('contains every durable identity, catalog, policy, and operational table', async () => {
    const { sql } = await migrationSql();
    const requiredTables = [
      'identity.users',
      'identity.profiles',
      'identity.tenants',
      'identity.shop_memberships',
      'identity.platform_roles',
      'catalog.shops',
      'catalog.categories',
      'catalog.products',
      'catalog.variants',
      'catalog.inventory',
      'catalog.inventory_adjustments',
      'catalog.product_audits',
      'catalog.shop_audits',
      'policy.shop_policies',
      'policy.shop_policy_audits',
      'policy.approvals',
      'conversation.conversations',
      'conversation.messages',
      'recovery.consents',
      'recovery.attempts',
      'recovery.checkout_consents',
      'recovery.suppressions',
      'operations.kill_switches',
      'operations.merchant_commands',
      'payments.payment_transitions',
      'payments.reconciliation_snapshots',
      'commerce.offer_redemptions',
      'commerce.shipping_addresses',
      'commerce.fulfillment_shipments',
      'commerce.fulfillment_events',
      'catalog.search_events',
      'catalog.recommendation_impressions',
    ];

    for (const table of requiredTables) {
      expect(sql, `missing ${table}`).toContain(`create table ${table}`);
    }
  });

  it('enables RLS and uses trusted transaction-local context', async () => {
    const { sql } = await migrationSql();
    const protectedTables = [
      'identity.users',
      'identity.profiles',
      'identity.tenants',
      'identity.shop_memberships',
      'identity.platform_roles',
      'commerce.carts',
      'commerce.cart_lines',
      'commerce.quotes',
      'commerce.quote_lines',
      'commerce.offer_redemptions',
      'commerce.shipping_addresses',
      'commerce.fulfillment_shipments',
      'commerce.fulfillment_events',
      'payments.checkout_sessions',
      'payments.payment_transitions',
      'payments.reconciliation_snapshots',
      'integration.inbox_events',
      'ledger.ledger_entries',
      'catalog.shops',
      'catalog.categories',
      'catalog.products',
      'catalog.variants',
      'catalog.inventory',
      'catalog.search_events',
      'catalog.recommendation_impressions',
      'policy.shop_policies',
      'policy.approvals',
      'conversation.conversations',
      'conversation.messages',
      'recovery.consents',
      'recovery.attempts',
      'recovery.checkout_consents',
      'operations.kill_switches',
    ];

    for (const table of protectedTables) {
      expect(sql, `RLS disabled for ${table}`).toContain(
        `alter table ${table} enable row level security`,
      );
    }
    expect(sql).toContain("current_setting('app.user_id', true)");
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    expect(sql).toContain('identity.shop_memberships');
    expect(sql).toContain('app_private.can_access_conversation');
    expect(sql).toContain("current_setting('app.service_context', true)");
    expect(sql).toContain("current_user::text = 'charter_app'");
    expect(sql).toContain('app_private.has_public_catalog_access');
    expect(sql).toContain('app_private.has_self_membership');
    expect(sql).toContain('app_private.is_public_inventory');
    expect(sql).toContain("array['owner', 'admin', 'catalog']");
    expect(sql).toContain('create policy inventory_public_read');
    expect(sql).toContain('create policy categories_public_read');
    expect(sql).toContain('public_directory_shop_sort_idx');
    expect(sql).toContain('public_directory_variant_price_idx');
    expect(sql).toContain("application_user.status = 'active'");
    expect(sql).toContain("tenant.status = 'active'");
    expect(sql).not.toContain(' for all ');
    expect(sql).not.toContain('user_metadata');
    expect(sql).not.toContain('service_role');
  });

  it('uses command-specific destructive policies', async () => {
    const { sql } = await migrationSql();

    expect(sql).toContain('create policy tenants_platform_delete');
    expect(sql).toContain('create policy profiles_platform_delete');
    expect(sql).toContain('create policy products_managers_delete');
    expect(sql).toContain('create policy shop_policies_managers_delete');
    expect(sql).toContain('create policy kill_switches_admin_delete');
  });

  it('models trusted pre-resolution webhook intake', async () => {
    const { sql } = await migrationSql();

    expect(sql).toContain('tenant_id text references identity.tenants (id)');
    expect(sql).toContain("state text not null default 'unresolved'");
    expect(sql).toContain('primary key (provider, event_id)');
    expect(sql).toContain('app_private.has_webhook_intake_access');
    expect(sql).toContain('create policy inbox_events_webhook_insert');
    expect(sql).toContain('create policy inbox_events_webhook_update');
    expect(sql).toContain('create function app_private.resolve_webhook_checkout_by_order');
    expect(sql).toContain('returns table(tenant_id text, checkout_id uuid)');
    expect(sql).toContain('security definer set search_path = pg_catalog');
    expect(sql).toContain("current_setting('app.service_context', true) = 'webhook'");
    expect(sql).toContain(
      'revoke all on function app_private.resolve_webhook_checkout_by_order(text) from public',
    );
    expect(sql).not.toContain(
      'grant execute on function app_private.resolve_webhook_checkout_by_order(text) to charter_app',
    );
    expect(sql).toContain(
      'drop policy checkout_sessions_webhook_resolve on payments.checkout_sessions',
    );
    expect(sql).toContain(
      'create unique index checkout_sessions_order_uidx on payments.checkout_sessions (razorpay_order_id)',
    );
    expect(sql).toContain('unique (tenant_id, checkout_id, kind)');
  });

  it('keeps application-role grants in repeatable post-migration provisioning', async () => {
    const [provisioning, runner, rootPackage, ci] = await Promise.all([
      readFile(roleProvisioningPath, 'utf8'),
      readFile(roleProvisioningRunnerPath, 'utf8'),
      readFile(rootPackagePath, 'utf8'),
      readFile(ciPath, 'utf8'),
    ]);
    const normalizedProvisioning = provisioning.toLowerCase().replaceAll(/\s+/g, ' ');

    expect(normalizedProvisioning).toContain(
      'grant execute on function app_private.resolve_webhook_checkout_by_order(text) to charter_app',
    );
    expect(normalizedProvisioning).toContain(
      'grant select, insert, update, delete on all tables in schema',
    );
    expect(normalizedProvisioning).toContain('revoke all on all tables in schema');
    expect(runner).toContain('process.env.CHARTER_APP_PASSWORD');
    expect(runner).toContain('select pg_temp.provision_charter_app($1)');
    expect(runner).not.toContain('console.log(rolePassword)');
    expect(rootPackage).toContain('"db:provision-role"');
    expect(ci.indexOf('run: pnpm db:provision-role')).toBeGreaterThan(
      ci.indexOf('run: pnpm migrate'),
    );
    expect(ci).toContain('randomBytes(32)');
    expect(ci).not.toMatch(/CHARTER_APP_PASSWORD:\s*\S+/);
  });

  it('binds buyer resources and tenant API state to durable rows', async () => {
    const { sql } = await migrationSql();

    expect(sql).toContain('add column user_id uuid');
    expect(sql).toContain("'catalog', 'support', 'finance', 'viewer'");
    expect(sql).toContain('create unique index checkout_sessions_order_uidx');
    expect(sql).toContain('create policy checkout_sessions_webhook_resolve');
    expect(sql).toContain('create function app_private.sync_auth_user');
    expect(sql).toContain('create function app_private.provision_shop');
    expect(sql).toContain('add column state jsonb');
    expect(sql).not.toContain('owner_email');
  });

  it('models recovery send reservations and one durable successful send per checkout consent', async () => {
    const { sql } = await migrationSql();

    expect(sql).toContain("'pending', 'sent', 'delivered', 'failed', 'suppressed'");
    expect(sql).toContain('recovery_attempts_checkout_active_uidx');
    expect(sql).toContain("where status in ('pending', 'sent', 'delivered')");
    expect(sql).toContain('add column purpose text');
    expect(sql).toContain('add column channel text');
    expect(sql).toContain(
      'on recovery.attempts (tenant_id, checkout_id, consent_id, purpose, channel)',
    );
    expect(sql).toContain('attempts_consent_dimensions_fkey');
    expect(sql).toContain('create policy variants_machine_read');
    expect(sql).toContain('create policy shops_machine_read');
    expect(sql).toContain('create policy products_machine_read');
    expect(sql).toContain('create policy inventory_machine_read');
    expect(sql).toContain('create policy shop_policies_machine_update');
  });
});

describe('SQL seeds', () => {
  it('is deterministic and preserves current catalog facts', async () => {
    const seed = (await readFile(seedPath, 'utf8')).toLowerCase();

    expect(seed).toContain('northstar travel coffee');
    expect(seed).toContain('indigo desk');
    expect(seed).toContain('harbor spice');
    expect(seed).toContain('sable atelier');
    expect(seed).toContain('lotus gifting');
    expect(seed).toContain('marigold home');
    expect(seed).not.toContain('(synthetic)');
    expect(seed).toContain('example.invalid');
    expect(seed).toContain('brewer.trailpress-steel-750');
    expect(seed).toContain('119900');
    expect(seed).toContain('grinder.pocket-lite');
    expect(seed).toContain('99900');
    expect(seed).toContain('shirt.linen-sand');
    expect(seed).toContain('mug.steel-travel');
    expect(seed).toContain('gift.tea-hamper');
    expect(seed).toContain('10000');
    expect(seed).not.toMatch(
      /insert into catalog\.products[\s\S]*?values[\s\S]*?\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*null\s*,/i,
    );
    expect(seed).toMatch(/on conflict[\s\S]+do update/);
    expect(seed).toContain('is distinct from');
  });
});

describe('money-kernel persistence bridge', () => {
  it('round-trips the durable cart approval ceiling', async () => {
    const persistence = await readFile(commercePersistencePath, 'utf8');

    expect(persistence).toContain('approved_through_minor: cart.approvedThroughMinor.toString()');
    expect(persistence).toContain('approvedThroughMinor: BigInt(row.approved_through_minor)');
  });

  it('scopes every legacy read, update, and delete by tenant', async () => {
    const sources = await Promise.all(
      [commercePersistencePath, paymentsPersistencePath, ledgerPersistencePath].map((path) =>
        readFile(path, 'utf8'),
      ),
    );
    const persistence = sources.join('\n');

    expect(persistence).not.toContain('withTenant');
    expect(persistence).toContain('withMachineTenant');
    expect(persistence.match(/\.where\('tenant_id', '=',/g)?.length ?? 0).toBeGreaterThanOrEqual(
      16,
    );
  });

  it('locks webhook transitions and uses conflict-safe capture insertion', async () => {
    const [paymentsPersistence, ledgerPersistence] = await Promise.all([
      readFile(paymentsPersistencePath, 'utf8'),
      readFile(ledgerPersistencePath, 'utf8'),
    ]);

    expect(paymentsPersistence).toContain('.forUpdate()');
    expect(paymentsPersistence).toContain('persistProviderTransition');
    expect(paymentsPersistence).toContain("columns(['tenant_id', 'checkout_id', 'kind'])");
    expect(ledgerPersistence).not.toMatch(
      /appendCapture[\s\S]*?selectFrom\('ledger_entries'\)[\s\S]*?insertInto\('ledger_entries'\)/,
    );
    expect(ledgerPersistence).toContain("columns(['tenant_id', 'checkout_id', 'kind'])");
    expect(ledgerPersistence).toContain(".returning('id')");
  });

  it('keeps tenant provisioning out of startup persistence', async () => {
    const [corePersistence, identityPersistence] = await Promise.all([
      readFile(corePersistencePath, 'utf8'),
      readFile(identityPersistencePath, 'utf8'),
    ]);

    expect(corePersistence).not.toContain('ensureTenant');
    expect(corePersistence).not.toContain('ensureShop');
    expect(identityPersistence).toContain('export type ShopProvisioningRepository');
    expect(identityPersistence).toContain('createShopProvisioningRepository');
  });
});

describe('CI database test wiring', () => {
  it('passes database URLs through Turbo and runs DB tests uncached', async () => {
    const [turbo, ci, corePersistenceTest, recoveryPostgresTest] = await Promise.all([
      readFile(turboPath, 'utf8'),
      readFile(ciPath, 'utf8'),
      readFile(corePersistenceTestPath, 'utf8'),
      readFile(recoveryPostgresTestPath, 'utf8'),
    ]);

    expect(turbo).toContain('"cache": false');
    expect(turbo).toContain('"TEST_DATABASE_URL"');
    expect(turbo).toContain('"CI_REQUIRE_TEST_DATABASE_URL"');
    expect(turbo).toContain('"CHARTER_APP_PASSWORD"');
    expect(ci).toContain('CI_REQUIRE_TEST_DATABASE_URL: true');
    expect(ci).toContain('src/database.integration.test.ts');
    expect(corePersistenceTest).toContain("process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true'");
    expect(corePersistenceTest).toContain('TEST_DATABASE_URL_REQUIRED_IN_CI');
    expect(corePersistenceTest).toContain("username = 'charter_app'");
    expect(corePersistenceTest).toContain('current_user as role');
    expect(corePersistenceTest).toContain('CHARTER_APP_PASSWORD_REQUIRED_IN_CI');
    expect(corePersistenceTest).toContain('PAYMENT_REFUNDED');
    expect(recoveryPostgresTest).toContain("username = 'charter_app'");
    expect(recoveryPostgresTest).toContain('current_user as role');
    expect(recoveryPostgresTest).toContain('CHARTER_APP_PASSWORD_REQUIRED_IN_CI');
    expect(recoveryPostgresTest).toContain('cross-tenant');
    expect(recoveryPostgresTest).toContain('PAYMENT_REFUNDED');
  });
});
