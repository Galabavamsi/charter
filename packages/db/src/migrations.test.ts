import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMigrationFiles, migrationDirectory, seedFilePath } from './migrations.js';
import { withAuthContext, withMachineTenant } from './tenant.js';

const roleProvisioningPath = fileURLToPath(
  new URL('../../../supabase/roles/001_charter_app.sql', import.meta.url),
);

describe('migration file discovery', () => {
  it('loads canonical files in lexical order with stable checksums', async () => {
    const first = await loadMigrationFiles(migrationDirectory);
    const second = await loadMigrationFiles(migrationDirectory);

    expect(first.map((migration) => migration.id)).toEqual([
      expect.stringMatching(/_money_kernel$/),
      expect.stringMatching(/_secure_schema_auth_foundation$/),
      expect.stringMatching(/_tenant_api_durability$/),
      expect.stringMatching(/_catalog_auth_remediation$/),
      expect.stringMatching(/_webhook_durability_remediation$/),
      expect.stringMatching(/_tenant_api_durability_completion$/),
      expect.stringMatching(/_recovery_send_idempotency$/),
      expect.stringMatching(/_conversation_revision_cas$/),
      expect.stringMatching(/_public_directory$/),
      expect.stringMatching(/_merchant_workspace$/),
      expect.stringMatching(/_payment_reconciliation$/),
      expect.stringMatching(/_membership_self_listing$/),
      expect.stringMatching(/_typed_approvals_pii$/),
      expect.stringMatching(/_quote_fact_pinning$/),
      expect.stringMatching(/_catalog_machine_fact_reads$/),
      expect.stringMatching(/_typed_approval_resources$/),
      expect.stringMatching(/_recovery_offer_evidence$/),
      expect.stringMatching(/_quote_fact_hash_check$/),
      expect.stringMatching(/_shop_policies_machine_update$/),
      expect.stringMatching(/_shop_directory_metrics$/),
      expect.stringMatching(/_shop_profile_and_discovery$/),
      expect.stringMatching(/_seeded_shop_gift_caps$/),
      expect.stringMatching(/_seeded_shop_catalog_expand$/),
      expect.stringMatching(/_sandbox_fulfillment$/),
    ]);
    expect(first.map((migration) => migration.checksum)).toEqual(
      second.map((migration) => migration.checksum),
    );
    expect(new Set(first.map((migration) => migration.checksum)).size).toBe(24);
    expect(seedFilePath).toMatch(/supabase[\\/]seed\.sql$/);
  });

  it('keeps runner bookkeeping outside exposed schemas', async () => {
    const runner = await readFile(
      fileURLToPath(new URL('./migrations.ts', import.meta.url)),
      'utf8',
    );

    expect(runner).toContain('charter_migrations.schema_migrations');
    expect(runner).not.toContain('public.schema_migrations');
  });

  it('versions repeatable charter_app provisioning after schema migrations', async () => {
    const provisioning = (await readFile(roleProvisioningPath, 'utf8')).toLowerCase();

    expect(provisioning).toContain('create or replace function pg_temp.provision_charter_app');
    expect(provisioning).toContain('create role charter_app');
    expect(provisioning).toContain('alter role charter_app with login');
    expect(provisioning).toContain('nosuperuser');
    expect(provisioning).toContain('nobypassrls');
    expect(provisioning).toContain(
      'grant execute on function app_private.resolve_webhook_checkout_by_order(text) to charter_app',
    );
    expect(provisioning).toContain('role_password text');
    expect(provisioning).not.toMatch(/password\s+'[^']+'/);
  });
});

describe('transaction auth context validation', () => {
  it('rejects an invalid user UUID before opening a transaction', async () => {
    await expect(
      withAuthContext(
        undefined as never,
        { userId: 'not-a-uuid', tenantId: 'northstar-demo-in' },
        async () => undefined,
      ),
    ).rejects.toThrow('AUTH_CONTEXT_USER_ID_INVALID');
  });

  it('rejects unsafe tenant identifiers before opening a transaction', async () => {
    await expect(
      withAuthContext(
        undefined as never,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: "northstar-demo-in'; reset role; --",
        },
        async () => undefined,
      ),
    ).rejects.toThrow('AUTH_CONTEXT_TENANT_ID_INVALID');
  });

  it('validates machine tenant context separately from human auth', async () => {
    await expect(
      withMachineTenant(undefined as never, "northstar-demo-in'; reset role; --", async () => {
        return undefined;
      }),
    ).rejects.toThrow('MACHINE_CONTEXT_TENANT_ID_INVALID');
  });
});
