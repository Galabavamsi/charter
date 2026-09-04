import { randomUUID } from 'node:crypto';
import { type Database, type Kysely, withMachineTenant } from '@charter/db';

export type CaptureEvidence = {
  tenantId: string;
  checkoutId: string;
  quoteId: string;
  amountMinor: bigint;
  currency: 'INR';
  providerPaymentId: string | null;
};

export async function appendCapture(
  db: Kysely<Database>,
  evidence: CaptureEvidence,
): Promise<{ id: string; inserted: boolean }> {
  return withMachineTenant(db, evidence.tenantId, async (trx) => {
    const id = randomUUID();
    const inserted = await trx
      .withSchema('ledger')
      .insertInto('ledger_entries')
      .values({
        id,
        tenant_id: evidence.tenantId,
        checkout_id: evidence.checkoutId,
        quote_id: evidence.quoteId,
        kind: 'capture',
        amount_minor: evidence.amountMinor.toString(),
        currency: evidence.currency,
        provider_payment_id: evidence.providerPaymentId,
        created_at: new Date(),
      })
      .onConflict((conflict) => conflict.columns(['tenant_id', 'checkout_id', 'kind']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      return { id: inserted.id, inserted: true };
    }
    const existing = await trx
      .withSchema('ledger')
      .selectFrom('ledger_entries')
      .select('id')
      .where('tenant_id', '=', evidence.tenantId)
      .where('checkout_id', '=', evidence.checkoutId)
      .where('kind', '=', 'capture')
      .executeTakeFirst();
    if (!existing) {
      throw new Error('CAPTURE_CONFLICT_ROW_MISSING');
    }
    return { id: existing.id, inserted: false };
  });
}

export type LedgerCapture = {
  id: string;
  checkoutId: string;
  quoteId: string;
  kind: string;
  amountMinor: string;
  currency: string;
  providerPaymentId: string | null;
  createdAt: string;
};

export async function listCaptures(
  db: Kysely<Database>,
  tenantId: string,
): Promise<LedgerCapture[]> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const rows = await trx
      .withSchema('ledger')
      .selectFrom('ledger_entries')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      checkoutId: row.checkout_id,
      quoteId: row.quote_id,
      kind: row.kind,
      amountMinor: String(row.amount_minor),
      currency: row.currency,
      providerPaymentId: row.provider_payment_id,
      createdAt: row.created_at.toISOString(),
    }));
  });
}
