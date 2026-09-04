import { formatInr, money } from '@charter/domain-shared';
import {
  appliedOffersFrom,
  assertFactPinMatch,
  consumeAppliedOffers,
  isFactHash,
  matchingOffersFrom,
  merchantFactPin,
  parseStoredOffers,
  rewindOfferRedemptions,
  type FactPin,
} from '@charter/catalog';
import { sql, type Database, type Kysely, type Transaction, withMachineTenant } from '@charter/db';
import {
  assertApprovalDecision,
  cartSpendActionHash,
  decideLoadedApproval,
  decideTypedApproval,
  hydrateApproval,
  hydrateCart,
  hydrateQuote,
  isApprovalKind,
  proposedReplaceTotal,
  rememberQuoteOfferRedemptions,
  typedActionHash,
  type ApprovalKind,
  type ApprovalRequest,
  type Cart,
  type FrozenQuote,
} from '../domain/index.js';

export async function saveCart(db: Kysely<Database>, cart: Cart, userId?: string): Promise<void> {
  await withMachineTenant(db, cart.tenantId, async (trx) => {
    await trx
      .withSchema('commerce')
      .insertInto('carts')
      .values({
        id: cart.id,
        tenant_id: cart.tenantId,
        user_id: userId ?? null,
        version: cart.version,
        approved_through_minor: cart.approvedThroughMinor.toString(),
        created_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('id')
          .doUpdateSet({
            version: cart.version,
            approved_through_minor: cart.approvedThroughMinor.toString(),
            ...(userId === undefined ? {} : { user_id: userId }),
          })
          .where('carts.tenant_id', '=', cart.tenantId),
      )
      .execute();
    await trx
      .withSchema('commerce')
      .deleteFrom('cart_lines')
      .where('tenant_id', '=', cart.tenantId)
      .where('cart_id', '=', cart.id)
      .execute();
    if (cart.lines.length === 0) {
      return;
    }
    await trx
      .withSchema('commerce')
      .insertInto('cart_lines')
      .values(
        cart.lines.map((line) => ({
          tenant_id: cart.tenantId,
          cart_id: cart.id,
          sku: line.sku,
          quantity: line.quantity,
        })),
      )
      .execute();
  });
}

export async function saveQuote(
  db: Kysely<Database>,
  quote: FrozenQuote,
  tenantId: string = quote.tenantId,
): Promise<void> {
  if (tenantId !== quote.tenantId) {
    throw new Error('QUOTE_TENANT_MISMATCH');
  }
  if (!isFactHash(quote.factHash)) {
    throw new Error('FACTS_UNPINNED');
  }
  await withMachineTenant(db, tenantId, async (trx) => {
    const pending = quote.discountMinor > 0n ? await lockQuoteOfferCoverage(trx, quote) : undefined;
    await trx
      .withSchema('commerce')
      .insertInto('quotes')
      .values({
        id: quote.id,
        tenant_id: tenantId,
        cart_id: quote.cartId,
        cart_version: quote.cartVersion,
        status: quote.status,
        bound_checkout_id: quote.boundCheckoutId,
        currency: quote.currency,
        subtotal_minor: quote.subtotalMinor.toString(),
        discount_minor: quote.discountMinor.toString(),
        total_minor: quote.totalMinor.toString(),
        delivery_by: quote.deliveryBy,
        merchant: quote.merchant,
        catalog_version: quote.catalogVersion,
        policy_version: quote.policyVersion,
        fact_hash: quote.factHash,
        created_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('id')
          .doUpdateSet({
            status: quote.status,
            bound_checkout_id: quote.boundCheckoutId,
            cart_version: quote.cartVersion,
          })
          .where('quotes.tenant_id', '=', tenantId),
      )
      .execute();
    await trx
      .withSchema('commerce')
      .deleteFrom('quote_lines')
      .where('tenant_id', '=', tenantId)
      .where('quote_id', '=', quote.id)
      .execute();
    if (quote.lines.length > 0) {
      await trx
        .withSchema('commerce')
        .insertInto('quote_lines')
        .values(
          quote.lines.map((line) => ({
            tenant_id: tenantId,
            quote_id: quote.id,
            sku: line.sku,
            title: line.title,
            quantity: line.quantity,
            unit_minor: line.unitMinor.toString(),
            line_minor: line.lineMinor.toString(),
          })),
        )
        .execute();
    }
    if (pending) {
      await persistQuoteOfferRedemptions(trx, quote, pending.offers, pending.applied);
    }
  });
}

function throwOfferCoverageExhausted(
  offers: ReturnType<typeof parseStoredOffers>,
  skus: string[],
): never {
  const have = new Set(skus);
  const skuMatched = offers.filter((offer) =>
    offer.groups.every((group) => group.some((sku) => have.has(sku))),
  );
  if (
    skuMatched.some(
      (offer) =>
        offer.maxRedemptions !== undefined && (offer.redemptions ?? 0) >= offer.maxRedemptions,
    )
  ) {
    throw new Error('OFFER_FREQUENCY_EXHAUSTED');
  }
  throw new Error('OFFER_BUDGET_EXHAUSTED');
}

async function applyClaimedOfferCoverage(
  trx: Transaction<Database>,
  quote: FrozenQuote,
  offers: ReturnType<typeof parseStoredOffers>,
): Promise<void> {
  if (offers.length === 0) {
    return;
  }
  const claimed = await sql<{ offer_id: string; redemptions: number; spent_minor: string }>`
    select offer_id,
           count(*)::int as redemptions,
           coalesce(sum(discount_minor), 0)::text as spent_minor
    from commerce.offer_redemptions
    where tenant_id = ${quote.tenantId}
      and quote_id <> ${quote.id}::uuid
    group by offer_id
  `.execute(trx);
  const byOffer = new Map(claimed.rows.map((row) => [row.offer_id, row]));
  for (const offer of offers) {
    const other = byOffer.get(offer.id);
    if (!other) {
      continue;
    }
    const jsonRedemptions = offer.redemptions ?? 0;
    offer.redemptions = Math.max(jsonRedemptions, other.redemptions);
    if (offer.budgetRemainingMinor === undefined) {
      continue;
    }
    const spent = BigInt(other.spent_minor);
    const jsonAccounted = BigInt(jsonRedemptions) * offer.discountMinor;
    if (spent <= jsonAccounted) {
      continue;
    }
    const unaccounted = spent - jsonAccounted;
    offer.budgetRemainingMinor =
      offer.budgetRemainingMinor > unaccounted ? offer.budgetRemainingMinor - unaccounted : 0n;
  }
}

async function lockQuoteOfferCoverage(
  trx: Transaction<Database>,
  quote: FrozenQuote,
): Promise<
  | {
      offers: ReturnType<typeof parseStoredOffers>;
      applied: ReturnType<typeof parseStoredOffers>;
    }
  | undefined
> {
  const locked = await sql<{ rules: unknown }>`
    select rules
    from policy.shop_policies
    where tenant_id = ${quote.tenantId}
    for update
  `.execute(trx);
  const row = locked.rows[0];
  if (!row) {
    throw new Error('OFFER_BUDGET_EXHAUSTED');
  }
  const existing = await sql<{ offer_id: string }>`
    select offer_id
    from commerce.offer_redemptions
    where tenant_id = ${quote.tenantId}
      and quote_id = ${quote.id}::uuid
    limit 1
  `.execute(trx);
  if (existing.rows[0]) {
    return undefined;
  }
  const offers = parseStoredOffers(row.rules);
  await applyClaimedOfferCoverage(trx, quote, offers);
  const applied = appliedOffersFrom(
    matchingOffersFrom(
      offers,
      quote.lines.map((line) => line.sku),
    ),
  );
  if (applied.length === 0) {
    throwOfferCoverageExhausted(
      offers,
      quote.lines.map((line) => line.sku),
    );
  }
  for (const offer of applied) {
    if (
      offer.budgetRemainingMinor !== undefined &&
      offer.budgetRemainingMinor < offer.discountMinor
    ) {
      throw new Error('OFFER_BUDGET_EXHAUSTED');
    }
    if (offer.maxRedemptions !== undefined && (offer.redemptions ?? 0) + 1 > offer.maxRedemptions) {
      throw new Error('OFFER_FREQUENCY_EXHAUSTED');
    }
  }
  const needsDurableCoverage = applied.some(
    (offer) => offer.budgetRemainingMinor !== undefined || offer.maxRedemptions !== undefined,
  );
  if (!needsDurableCoverage) {
    return undefined;
  }
  return { offers, applied };
}

async function persistQuoteOfferRedemptions(
  trx: Transaction<Database>,
  quote: FrozenQuote,
  offers: ReturnType<typeof parseStoredOffers>,
  applied: ReturnType<typeof parseStoredOffers>,
): Promise<void> {
  let consumed = false;
  for (const offer of applied) {
    const inserted = await sql<{ offer_id: string }>`
      insert into commerce.offer_redemptions (
        tenant_id, quote_id, offer_id, discount_minor
      )
      values (
        ${quote.tenantId},
        ${quote.id}::uuid,
        ${offer.id},
        ${offer.discountMinor.toString()}::bigint
      )
      on conflict (tenant_id, quote_id, offer_id) do nothing
      returning offer_id
    `.execute(trx);
    if (inserted.rows[0]) {
      consumed = true;
    }
  }
  if (!consumed) {
    throw new Error('OFFER_REDEMPTION_NOT_PERSISTED');
  }
  consumeAppliedOffers(offers.filter((offer) => applied.some((item) => item.id === offer.id)));
  rememberQuoteOfferRedemptions(
    quote.id,
    applied.map((offer) => ({ offerId: offer.id, discountMinor: offer.discountMinor })),
  );
  await sql`
    update policy.shop_policies
    set rules = jsonb_set(
      coalesce(rules, '{}'::jsonb),
      '{offers}',
      ${JSON.stringify(
        offers.map((offer) => ({
          id: offer.id,
          discount_minor: offer.discountMinor.toString(),
          required_sku_groups: offer.groups,
          stackable: offer.stackable !== false,
          margin_floor_minor: offer.marginFloorMinor?.toString() ?? null,
          budget_remaining_minor: offer.budgetRemainingMinor?.toString() ?? null,
          max_redemptions: offer.maxRedemptions ?? null,
          redemptions: offer.redemptions ?? 0,
          expires_at: offer.expiresAt ?? null,
        })),
      )}::jsonb
    )
    where tenant_id = ${quote.tenantId}
  `.execute(trx);
}

export async function loadCart(
  db: Kysely<Database>,
  tenantId: string,
  cartId: string,
): Promise<Cart | undefined> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const row = await trx
      .withSchema('commerce')
      .selectFrom('carts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', cartId)
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    const lines = await trx
      .withSchema('commerce')
      .selectFrom('cart_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('cart_id', '=', cartId)
      .execute();
    return hydrateCart(fromCartRow(row, lines));
  });
}

export async function loadQuote(
  db: Kysely<Database>,
  tenantId: string,
  quoteId: string,
): Promise<FrozenQuote | undefined> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const row = await trx
      .withSchema('commerce')
      .selectFrom('quotes')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', quoteId)
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    const lines = await trx
      .withSchema('commerce')
      .selectFrom('quote_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('quote_id', '=', quoteId)
      .execute();
    const quote = hydrateQuote(fromQuoteRow(row, lines));
    rememberQuoteOfferRedemptions(
      quote.id,
      await loadQuoteOfferRedemptions(trx, tenantId, quote.id),
    );
    return quote;
  });
}

export async function hydrateCommerce(
  db: Kysely<Database>,
  tenantId: string,
): Promise<{ carts: Cart[]; quotes: FrozenQuote[] }> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const carts = await trx
      .withSchema('commerce')
      .selectFrom('carts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const cartLines = await trx
      .withSchema('commerce')
      .selectFrom('cart_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('cart_id', 'asc')
      .orderBy('sku', 'asc')
      .execute();
    const quotes = await trx
      .withSchema('commerce')
      .selectFrom('quotes')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const quoteLines = await trx
      .withSchema('commerce')
      .selectFrom('quote_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('quote_id', 'asc')
      .orderBy('sku', 'asc')
      .execute();
    const hydratedCarts = carts.map((cart) =>
      hydrateCart(
        fromCartRow(
          cart,
          cartLines.filter((line) => line.cart_id === cart.id),
        ),
      ),
    );
    const hydratedQuotes = quotes.map((quote) =>
      hydrateQuote(
        fromQuoteRow(
          quote,
          quoteLines.filter((line) => line.quote_id === quote.id),
        ),
      ),
    );
    const redemptionRows = await sql<{
      quote_id: string;
      offer_id: string;
      discount_minor: string;
    }>`
      select quote_id::text, offer_id, discount_minor::text
      from commerce.offer_redemptions
      where tenant_id = ${tenantId}
    `.execute(trx);
    const redemptionsByQuote = new Map<string, Array<{ offerId: string; discountMinor: bigint }>>();
    for (const row of redemptionRows.rows) {
      const list = redemptionsByQuote.get(row.quote_id) ?? [];
      list.push({ offerId: row.offer_id, discountMinor: BigInt(row.discount_minor) });
      redemptionsByQuote.set(row.quote_id, list);
    }
    for (const quote of hydratedQuotes) {
      rememberQuoteOfferRedemptions(quote.id, redemptionsByQuote.get(quote.id) ?? []);
    }
    return { carts: hydratedCarts, quotes: hydratedQuotes };
  });
}

export async function saveApproval(
  db: Kysely<Database>,
  approval: ApprovalRequest,
  requestedBy: string,
  decidedBy?: string,
): Promise<void> {
  await withMachineTenant(db, approval.tenantId, async (trx) => {
    await trx
      .withSchema('policy')
      .insertInto('approvals')
      .values({
        id: approval.id,
        tenant_id: approval.tenantId,
        cart_id: approval.cartId || null,
        from_sku: approval.fromSku || null,
        to_sku: approval.toSku || null,
        proposed_total_minor: approval.proposedTotalMinor.toString(),
        approved_through_minor:
          approval.status === 'approved' ? approval.proposedTotalMinor.toString() : null,
        requested_by: requestedBy,
        decided_by: decidedBy ?? null,
        status: approval.status,
        kind: approval.kind,
        action_hash: approval.actionHash,
        currency: 'INR',
        resource_id: approval.resourceId,
        resource_version: approval.resourceVersion,
        reason: approval.reason,
        expires_at: approval.expiresAt ? new Date(approval.expiresAt) : null,
        decided_at: approval.decidedAt,
        created_at: approval.createdAt,
        updated_at: new Date(),
      })
      .onConflict((conflict) =>
        conflict
          .column('id')
          .doUpdateSet({
            status: approval.status,
            approved_through_minor:
              approval.status === 'approved' ? approval.proposedTotalMinor.toString() : null,
            decided_by: decidedBy ?? null,
            decided_at: approval.decidedAt,
            updated_at: new Date(),
          })
          .where('approvals.tenant_id', '=', approval.tenantId),
      )
      .execute();
  });
}

export async function hydrateApprovals(
  db: Kysely<Database>,
  tenantId: string,
): Promise<ApprovalRequest[]> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const rows = await readApprovalRows(trx, tenantId);
    return rows.map((row) => hydrateApproval(fromApprovalRow(row)));
  });
}

export async function loadApproval(
  db: Kysely<Database>,
  tenantId: string,
  approvalId: string,
): Promise<ApprovalRequest | undefined> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const row = (await readApprovalRows(trx, tenantId, approvalId))[0];
    return row ? hydrateApproval(fromApprovalRow(row)) : undefined;
  });
}

export async function decidePersistedApproval(
  db: Kysely<Database>,
  input: {
    tenantId: string;
    approvalId: string;
    decision: 'approved' | 'denied';
    decidedBy: string;
  },
): Promise<{ approval: ApprovalRequest; cart: Cart }> {
  const persisted = await withMachineTenant(db, input.tenantId, async (trx) => {
    await sql`
      select set_config('app.user_id', ${input.decidedBy.toLowerCase()}, true)
    `.execute(trx);
    const membership = await sql<{ role: string }>`
      select membership.role
      from identity.shop_memberships membership
      join identity.users application_user
        on application_user.id = membership.user_id
       and application_user.status = 'active'
      join identity.tenants tenant
        on tenant.id = membership.tenant_id
       and tenant.status = 'active'
      where membership.tenant_id = ${input.tenantId}
        and membership.user_id = ${input.decidedBy.toLowerCase()}::uuid
        and membership.status = 'active'
      limit 1
    `.execute(trx);
    if (!membership.rows[0]) {
      throw new Error('SHOP_MEMBERSHIP_REQUIRED');
    }
    const approvalResult = await sql<ApprovalPersistenceRow>`
      select approval.id,
             approval.tenant_id,
             approval.cart_id,
             approval.from_sku,
             approval.to_sku,
             approval.proposed_total_minor::text,
             approval.status,
             approval.kind,
             approval.action_hash,
             approval.currency,
             approval.resource_id,
             approval.resource_version,
             approval.requested_by::text,
             approval.expires_at,
             approval.reason,
             approval.created_at,
             approval.decided_at,
             from_variant.title as from_title,
             to_variant.title as to_title
      from policy.approvals approval
      join catalog.variants from_variant
        on from_variant.tenant_id = approval.tenant_id
       and from_variant.sku = approval.from_sku
      join catalog.variants to_variant
        on to_variant.tenant_id = approval.tenant_id
       and to_variant.sku = approval.to_sku
      where approval.tenant_id = ${input.tenantId}
        and approval.id = ${input.approvalId}::uuid
      for update of approval
    `.execute(trx);
    const approvalRow = approvalResult.rows[0];
    if (!approvalRow) {
      throw new Error('APPROVAL_NOT_FOUND');
    }
    const cartRow = await trx
      .withSchema('commerce')
      .selectFrom('carts')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', approvalRow.cart_id ?? '')
      .forUpdate()
      .executeTakeFirst();
    if (!cartRow) {
      throw new Error('CART_NOT_FOUND');
    }
    const [cartLines, quotes] = await Promise.all([
      trx
        .withSchema('commerce')
        .selectFrom('cart_lines')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('cart_id', '=', cartRow.id)
        .execute(),
      trx
        .withSchema('commerce')
        .selectFrom('quotes')
        .select(['id', 'status'])
        .where('tenant_id', '=', input.tenantId)
        .where('cart_id', '=', cartRow.id)
        .forUpdate()
        .execute(),
    ]);
    const approval = fromApprovalRow(approvalRow);
    if (approval.kind !== 'cart_spend') {
      throw new Error('APPROVAL_KIND_MISMATCH');
    }
    const cart = fromCartRow(cartRow, cartLines);
    const liveAmountMinor = proposedReplaceTotal(cart, approval.fromSku, approval.toSku);
    const asserted = assertApprovalDecision({
      kind: approval.kind,
      shopRole: membership.rows[0].role,
      requestedBy: approvalRow.requested_by,
      decidedBy: input.decidedBy,
      expiresAt: approval.expiresAt,
      actionHash: approval.actionHash,
      liveActionHash: cartSpendActionHash({
        tenantId: approval.tenantId,
        cartId: approval.cartId,
        fromSku: approval.fromSku,
        toSku: approval.toSku,
        amountMinor: liveAmountMinor,
        currency: 'INR',
      }),
      amountMinor: approval.proposedTotalMinor,
      liveAmountMinor,
      currency: 'INR',
      liveCurrency: 'INR',
    });
    const result = decideLoadedApproval(approval, cart, input.decision, {
      checkoutLocked: quotes.some(
        (quote) => quote.status === 'BOUND' || quote.status === 'SETTLED',
      ),
      asserted,
    });

    const updatedApproval = await trx
      .withSchema('policy')
      .updateTable('approvals')
      .set({
        status: result.approval.status,
        approved_through_minor:
          result.approval.status === 'approved'
            ? result.approval.proposedTotalMinor.toString()
            : null,
        decided_by: input.decidedBy.toLowerCase(),
        decided_at: result.approval.decidedAt,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.approvalId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (!updatedApproval) {
      throw new Error('APPROVAL_ALREADY_DECIDED');
    }
    if (result.approval.status === 'approved') {
      const updatedCart = await trx
        .withSchema('commerce')
        .updateTable('carts')
        .set({
          version: result.cart.version,
          approved_through_minor: result.cart.approvedThroughMinor.toString(),
        })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', result.cart.id)
        .where('version', '=', cartRow.version)
        .returning('id')
        .executeTakeFirst();
      if (!updatedCart) {
        throw new Error('APPROVAL_STALE');
      }
      await trx
        .withSchema('commerce')
        .deleteFrom('cart_lines')
        .where('tenant_id', '=', input.tenantId)
        .where('cart_id', '=', result.cart.id)
        .execute();
      if (result.cart.lines.length > 0) {
        await trx
          .withSchema('commerce')
          .insertInto('cart_lines')
          .values(
            result.cart.lines.map((line) => ({
              tenant_id: input.tenantId,
              cart_id: result.cart.id,
              sku: line.sku,
              quantity: line.quantity,
            })),
          )
          .execute();
      }
    }
    return result;
  });
  return {
    approval: hydrateApproval(persisted.approval),
    cart: hydrateCart(persisted.cart),
  };
}

export async function decidePersistedTypedApproval(
  db: Kysely<Database>,
  input: {
    tenantId: string;
    approvalId: string;
    decision: 'approved' | 'denied';
    decidedBy: string;
    kind: ApprovalKind;
  },
): Promise<{ approval: ApprovalRequest }> {
  const persisted = await withMachineTenant(db, input.tenantId, async (trx) => {
    await sql`
      select set_config('app.user_id', ${input.decidedBy.toLowerCase()}, true)
    `.execute(trx);
    const approvalRow = (await readApprovalRows(trx, input.tenantId, input.approvalId, true))[0];
    if (!approvalRow) {
      throw new Error('APPROVAL_NOT_FOUND');
    }
    const approval = fromApprovalRow(approvalRow);
    if (approval.kind !== input.kind || approval.kind === 'cart_spend') {
      throw new Error('APPROVAL_KIND_MISMATCH');
    }
    let shopRole: string | undefined;
    let platformRoles: string[] = [];
    if (input.kind === 'platform') {
      const roles = await sql<{ role: string }>`
        select platform_role.role
        from identity.platform_roles platform_role
        where platform_role.user_id = ${input.decidedBy.toLowerCase()}::uuid
      `.execute(trx);
      platformRoles = roles.rows.map((row) => row.role);
    } else {
      const membership = await sql<{ role: string }>`
        select membership.role
        from identity.shop_memberships membership
        join identity.users application_user
          on application_user.id = membership.user_id
         and application_user.status = 'active'
        join identity.tenants tenant
          on tenant.id = membership.tenant_id
         and tenant.status = 'active'
        where membership.tenant_id = ${input.tenantId}
          and membership.user_id = ${input.decidedBy.toLowerCase()}::uuid
          and membership.status = 'active'
        limit 1
      `.execute(trx);
      if (!membership.rows[0]) {
        throw new Error('SHOP_MEMBERSHIP_REQUIRED');
      }
      shopRole = membership.rows[0].role;
    }
    hydrateApproval(approval);
    const decided = decideTypedApproval(approval.id, input.decision, {
      decidedBy: input.decidedBy,
      shopRole,
      platformRoles,
      expectedKind: input.kind,
    });
    const updated = await trx
      .withSchema('policy')
      .updateTable('approvals')
      .set({
        status: decided.status,
        approved_through_minor:
          decided.status === 'approved' ? decided.proposedTotalMinor.toString() : null,
        decided_by: input.decidedBy.toLowerCase(),
        decided_at: decided.decidedAt,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.approvalId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (!updated) {
      throw new Error('APPROVAL_ALREADY_DECIDED');
    }
    return decided;
  });
  return { approval: hydrateApproval(persisted) };
}

type ApprovalPersistenceRow = {
  id: string;
  tenant_id: string;
  cart_id: string | null;
  from_sku: string | null;
  to_sku: string | null;
  proposed_total_minor: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  kind: string;
  action_hash: string | null;
  currency: string;
  resource_id: string | null;
  resource_version: number | null;
  requested_by: string;
  expires_at: Date | null;
  reason: string | null;
  created_at: Date;
  decided_at: Date | null;
  from_title: string | null;
  to_title: string | null;
};

async function readApprovalRows(
  executor: Transaction<Database>,
  tenantId: string,
  approvalId?: string,
  forUpdate = false,
): Promise<ApprovalPersistenceRow[]> {
  const result = await sql<ApprovalPersistenceRow>`
    select approval.id,
           approval.tenant_id,
           approval.cart_id,
           approval.from_sku,
           approval.to_sku,
           approval.proposed_total_minor::text,
           approval.status,
           approval.kind,
           approval.action_hash,
           approval.currency,
           approval.resource_id,
           approval.resource_version,
           approval.requested_by::text,
           approval.expires_at,
           approval.reason,
           approval.created_at,
           approval.decided_at,
           from_variant.title as from_title,
           to_variant.title as to_title
    from policy.approvals approval
    left join catalog.variants from_variant
      on from_variant.tenant_id = approval.tenant_id
     and from_variant.sku = approval.from_sku
    left join catalog.variants to_variant
      on to_variant.tenant_id = approval.tenant_id
     and to_variant.sku = approval.to_sku
    where approval.tenant_id = ${tenantId}
      and (${approvalId ?? null}::uuid is null or approval.id = ${approvalId ?? null}::uuid)
    order by approval.created_at desc, approval.id desc
    ${forUpdate ? sql`for update of approval` : sql``}
  `.execute(executor);
  return result.rows;
}

function fromApprovalRow(row: ApprovalPersistenceRow): ApprovalRequest {
  const proposedTotalMinor = BigInt(row.proposed_total_minor);
  const kind = isApprovalKind(row.kind) ? row.kind : 'cart_spend';
  const cartId = row.cart_id ?? '';
  const fromSku = row.from_sku ?? '';
  const toSku = row.to_sku ?? '';
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cartId,
    fromSku,
    toSku,
    fromTitle: row.from_title ?? row.resource_id ?? fromSku,
    toTitle: row.to_title ?? row.resource_id ?? toSku,
    proposedTotalMinor,
    proposedDisplay: formatInr(money(proposedTotalMinor)),
    reason: row.reason ?? 'APPROVAL_REQUIRED',
    status: row.status === 'expired' ? 'denied' : row.status,
    kind,
    actionHash:
      row.action_hash ??
      (kind === 'cart_spend'
        ? cartSpendActionHash({
            tenantId: row.tenant_id,
            cartId,
            fromSku,
            toSku,
            amountMinor: proposedTotalMinor,
            currency: 'INR',
          })
        : typedActionHash({
            kind,
            tenantId: row.tenant_id,
            resourceId: row.resource_id ?? '',
            resourceVersion: row.resource_version,
            amountMinor: proposedTotalMinor,
            currency: 'INR',
          })),
    resourceId: row.resource_id ?? (kind === 'cart_spend' ? cartId : null),
    resourceVersion: row.resource_version,
    requestedBy: row.requested_by,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

function fromCartRow(
  row: {
    id: string;
    tenant_id: string;
    version: number;
    approved_through_minor: string;
  },
  lines: Array<{ sku: string; quantity: number }>,
): Cart {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    approvedThroughMinor: BigInt(row.approved_through_minor),
    lines: lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
  };
}

function fromQuoteRow(
  row: {
    id: string;
    tenant_id: string;
    cart_id: string;
    cart_version: number;
    status: string;
    bound_checkout_id: string | null;
    currency: string;
    subtotal_minor: string;
    discount_minor: string;
    total_minor: string;
    delivery_by: string | Date;
    merchant: string;
    catalog_version?: number;
    policy_version?: number;
    fact_hash?: string;
  },
  lines: Array<{
    sku: string;
    title: string;
    quantity: number;
    unit_minor: string;
    line_minor: string;
  }>,
): FrozenQuote {
  const totalMinor = BigInt(row.total_minor);
  const deliveryBy = asDateOnly(row.delivery_by);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cartId: row.cart_id,
    cartVersion: row.cart_version,
    status: row.status as FrozenQuote['status'],
    boundCheckoutId: row.bound_checkout_id,
    currency: 'INR',
    subtotalMinor: BigInt(row.subtotal_minor),
    discountMinor: BigInt(row.discount_minor),
    totalMinor,
    totalDisplay: formatInr(money(totalMinor)),
    deliveryBy,
    merchant: row.merchant,
    catalogVersion: row.catalog_version ?? 1,
    policyVersion: row.policy_version ?? 1,
    factHash: row.fact_hash ?? '',
    lines: lines.map((line) => ({
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      unitMinor: BigInt(line.unit_minor),
      lineMinor: BigInt(line.line_minor),
    })),
  };
}

function asDateOnly(value: string | Date): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function loadQuoteOfferRedemptions(
  trx: Transaction<Database>,
  tenantId: string,
  quoteId: string,
): Promise<Array<{ offerId: string; discountMinor: bigint }>> {
  const redemptions = await sql<{ offer_id: string; discount_minor: string }>`
    select offer_id, discount_minor::text
    from commerce.offer_redemptions
    where tenant_id = ${tenantId}
      and quote_id = ${quoteId}::uuid
  `.execute(trx);
  return redemptions.rows.map((row) => ({
    offerId: row.offer_id,
    discountMinor: BigInt(row.discount_minor),
  }));
}

export async function loadDurableFactPin(
  db: Kysely<Database>,
  tenantId: string,
  quoteId?: string,
): Promise<FactPin> {
  return withMachineTenant(db, tenantId, async (trx) => {
    const versions = await sql<{
      catalog_version: number;
      policy_version: number;
      hard_cap_minor: string;
      autonomous_cap_minor: string;
      forbidden_materials: string[];
      rules: unknown;
    }>`
      select coalesce(
               (select shop.version
                  from catalog.shops shop
                 where shop.tenant_id = policy.tenant_id),
               1
             ) as catalog_version,
             policy.version as policy_version,
             policy.hard_cap_minor::text,
             policy.autonomous_cap_minor::text,
             policy.forbidden_materials,
             policy.rules
      from policy.shop_policies policy
      where policy.tenant_id = ${tenantId}
      limit 1
    `.execute(trx);
    const version = versions.rows[0];
    if (!version) {
      throw new Error('FACTS_STALE');
    }
    const variants = await sql<{
      sku: string;
      price_minor: string;
      on_hand: number;
      material: string;
    }>`
      select variant.sku,
             variant.price_minor::text,
             inventory.available as on_hand,
             variant.material
      from catalog.variants variant
      join catalog.products product
        on product.tenant_id = variant.tenant_id
       and product.id = variant.product_id
      join catalog.inventory inventory
        on inventory.tenant_id = variant.tenant_id
       and inventory.variant_id = variant.id
      where variant.tenant_id = ${tenantId}
        and variant.status = 'published'
        and product.status = 'published'
      order by variant.sku
    `.execute(trx);
    const offers = quoteId
      ? rewindOfferRedemptions(
          durablePolicyOffers(version.rules),
          await loadQuoteOfferRedemptions(trx, tenantId, quoteId),
        )
      : durablePolicyOffers(version.rules);
    return merchantFactPin({
      catalogVersion: Number(version.catalog_version),
      policyVersion: Number(version.policy_version),
      variants: variants.rows.map((row) => ({
        sku: row.sku,
        priceMinor: BigInt(row.price_minor),
        stock: Number(row.on_hand),
        material: row.material,
        published: true,
      })),
      authority: {
        hardCapMinor: BigInt(version.hard_cap_minor),
        autonomousCapMinor: BigInt(version.autonomous_cap_minor),
        forbiddenMaterials: version.forbidden_materials,
      },
      offers,
    });
  });
}

export async function assertDurableQuoteFacts(
  db: Kysely<Database>,
  quote: FrozenQuote,
): Promise<void> {
  assertFactPinMatch(
    {
      catalogVersion: quote.catalogVersion,
      policyVersion: quote.policyVersion,
      factHash: quote.factHash,
    },
    await loadDurableFactPin(db, quote.tenantId, quote.id),
  );
}

function durablePolicyOffers(value: unknown): FactPinSourceOffers {
  return parseStoredOffers(value);
}

type FactPinSourceOffers = ReturnType<typeof parseStoredOffers>;
