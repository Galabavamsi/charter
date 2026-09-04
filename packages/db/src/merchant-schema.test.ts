import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const merchantMigration = new URL(
  '../../../supabase/migrations/20260822110256_merchant_workspace.sql',
  import.meta.url,
);

describe('merchant workspace schema', () => {
  it('adds versioned catalog, stock, policy, settings, suppression, and command records', async () => {
    const sql = await readFile(merchantMigration, 'utf8');

    expect(sql).toContain('add column version integer not null default 1');
    expect(sql).toContain('create table catalog.inventory_adjustments');
    expect(sql).toContain('create table catalog.product_audits');
    expect(sql).toContain('create table policy.shop_policy_audits');
    expect(sql).toContain('create table catalog.shop_audits');
    expect(sql).toContain('create table recovery.suppressions');
    expect(sql).toContain('create table operations.merchant_commands');
    expect(sql).toContain('request_hash text not null');
    expect(sql).toContain('response jsonb not null');
  });

  it('keeps growing merchant reads tenant/date indexed and RLS-bound', async () => {
    const sql = await readFile(merchantMigration, 'utf8');

    expect(sql).toContain('checkout_sessions_tenant_created_idx');
    expect(sql).toContain('quotes_tenant_status_created_idx');
    expect(sql).toContain('ledger_entries_tenant_kind_created_idx');
    expect(sql).toContain('merchant_commands_actor_read');
    expect(sql).toContain('inventory_adjustments_members_read');
    expect(sql).toContain("array['owner', 'admin', 'catalog']");
    expect(sql).toContain("array['owner', 'admin']");
    expect(sql).not.toMatch(/\bdouble precision\b|\breal\b/);
  });
});
