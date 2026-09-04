import { randomUUID } from 'node:crypto';
import { merchantDisplayName, parseStoredOffers, type Material } from '@charter/catalog';
import {
  charterTrackingId,
  fulfillmentStatusDetail,
  fulfillmentStatusLabel,
  isFulfillmentStatus,
  mockIndianAddress,
  nextFulfillmentStatus,
  type FulfillmentStatus,
  type ShippingAddress,
} from '@charter/commerce';
import { paymentTruth } from '@charter/payments';
import { formatInr, lexicalPhrase, lexicalSearchTokens, money } from '@charter/domain-shared';
import {
  sql,
  withAuthContext,
  withMachineTenant,
  withPublicCatalogContext,
  withUserContext,
  type Database,
  type Kysely,
  type Transaction,
} from '@charter/db';
import type { VerifiedIdentity } from '../auth/verifier.js';
import { persistedConversationState } from './conversation-state.js';
import { normalizeShopProfile } from './shop-profile.js';
import type {
  BuyerOrderShop,
  BuyerOrderSummary,
  MerchantCatalogRecord,
  MerchantCursorPosition,
  MerchantOrderDetail,
  MerchantOrderSummary,
  MerchantPage,
  MerchantRecoveryRecord,
  MerchantRulesSnapshot,
  MerchantSettingsSnapshot,
} from './merchant-repository.js';
import {
  publicRating,
  searchPublicShopSources,
  shopMatchReasons,
  type PublicCatalogSourceShop,
} from './public-catalog.js';
import type { PublicCatalogQuery } from './public-catalog-query.js';
import {
  type CatalogItem,
  type KillSnapshot,
  type PlatformRole,
  type PublicCatalogFacets,
  type PublicCategory,
  type PublicDirectoryResult,
  type PublicShop,
  type PublicShopCatalogResult,
  type PersistedConversationState,
  type ShopPolicy,
  type ShopRecord,
  type ShopRole,
  type TenantRepository,
} from './repository.js';

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'shop'
  );
}

function formatMinor(value: bigint): string {
  return formatInr(money(value));
}

function lexicalTokenHitsSql(columnSql: string) {
  const column = sql.raw(columnSql);
  return sql`(
    strpos(lower(${column}), token) > 0
    or exists (
      select 1
      from unnest(regexp_split_to_array(lower(${column}), '[^a-z0-9]+')) as word
      where word <> ''
        and length(token) >= 4
        and length(word) >= 4
        and (
          word = token
          or left(word, length(token)) = token
          or left(token, length(word)) = word
          or (
            length(token) >= 6
            and length(word) >= 6
            and abs(length(word) - length(token)) <= 2
            and left(word, 5) = left(token, 5)
          )
        )
    )
  )`;
}

function lexicalColumnScore(columnSql: string, phrase: string, tokens: string[], weight: number) {
  const column = sql.raw(columnSql);
  const tokenHits = lexicalTokenHitsSql(columnSql);
  return sql`case
    when ${phrase} <> '' and lower(${column}) = ${phrase} then ${weight * 4}
    when ${phrase} <> '' and left(lower(${column}), length(${phrase})) = ${phrase} then ${weight * 3}
    when ${phrase} <> '' and strpos(lower(${column}), ${phrase}) > 0 then ${weight * 2}
    when cardinality(${tokens}::text[]) > 0 then (
      case
        when not exists (
          select 1 from unnest(${tokens}::text[]) token
          where token <> '' and ${tokenHits}
        ) then 0
        else greatest(
          1,
          (${weight})::integer * (
            select count(*)::integer
            from unnest(${tokens}::text[]) token
            where token <> '' and ${tokenHits}
          ) / greatest(cardinality(${tokens}::text[]), 1)
        )
      end
    )
    else 0
  end`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function policyOffers(value: unknown): ShopPolicy['offers'] {
  return parseStoredOffers(value);
}

function snapshotOffer(offer: ShopPolicy['offers'][number]): {
  id: string;
  discountMinor: string;
  discountDisplay: string;
  requiredSkuGroups: string[][];
  stackable: boolean;
  marginFloorMinor: string | null;
  budgetRemainingMinor: string | null;
  maxRedemptions: number | null;
  redemptions: number | null;
  expiresAt: string | null;
} {
  return {
    id: offer.id,
    discountMinor: offer.discountMinor.toString(),
    discountDisplay: formatMinor(offer.discountMinor),
    requiredSkuGroups: offer.groups.map((group) => [...group]),
    stackable: offer.stackable !== false,
    marginFloorMinor: offer.marginFloorMinor?.toString() ?? null,
    budgetRemainingMinor: offer.budgetRemainingMinor?.toString() ?? null,
    maxRedemptions: offer.maxRedemptions ?? null,
    redemptions: offer.redemptions ?? 0,
    expiresAt: offer.expiresAt ?? null,
  };
}

function offerRulesJson(
  offers: Array<{
    id: string;
    discountMinor: string;
    requiredSkuGroups: string[][];
    stackable?: boolean;
    marginFloorMinor?: string | null;
    budgetRemainingMinor?: string | null;
    maxRedemptions?: number | null;
    redemptions?: number | null;
    expiresAt?: string | null;
  }>,
) {
  return {
    offers: offers.map((offer) => ({
      id: offer.id,
      discount_minor: offer.discountMinor,
      required_sku_groups: offer.requiredSkuGroups,
      stackable: offer.stackable !== false,
      margin_floor_minor: offer.marginFloorMinor ?? null,
      budget_remaining_minor: offer.budgetRemainingMinor ?? null,
      max_redemptions: offer.maxRedemptions ?? null,
      redemptions: offer.redemptions ?? 0,
      expires_at: offer.expiresAt ?? null,
    })),
  };
}

function conversationState(value: unknown): PersistedConversationState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const state = value as Partial<PersistedConversationState>;
  if (
    !Array.isArray(state.messages) ||
    typeof state.catalogLoaded !== 'boolean' ||
    (state.cartId !== null && typeof state.cartId !== 'string') ||
    (state.quoteId !== null && typeof state.quoteId !== 'string')
  ) {
    return undefined;
  }
  return {
    cartId: state.cartId ?? null,
    quoteId: state.quoteId ?? null,
    catalogLoaded: state.catalogLoaded,
    pendingCheckout: state.pendingCheckout ?? null,
    messages: state.messages,
  };
}

function conversationRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('CONVERSATION_REVISION_INVALID');
  }
  return revision;
}

function shopRecord(row: {
  tenant_id: string;
  slug: string;
  name: string;
  label: string;
  blurb: string;
  status: ShopRecord['status'];
  synthetic: boolean;
  version?: number;
  published_at?: Date | null;
  gstin?: string;
  address_line?: string;
  refund_policy?: string;
  profile_verified?: boolean;
}): ShopRecord {
  return {
    tenantId: row.tenant_id,
    slug: row.slug,
    name: row.name,
    label: row.label,
    blurb: row.blurb,
    currency: 'INR',
    status: row.status,
    synthetic: row.synthetic,
    version: row.version ?? 1,
    publishedAt: row.published_at?.toISOString() ?? null,
    gstin: row.gstin ?? '',
    addressLine: row.address_line ?? '',
    refundPolicy: row.refund_policy ?? '',
    profileVerified: row.profile_verified === true,
  };
}

type MerchantCatalogDbRow = {
  product_id: string;
  product_version: number;
  product_title: string;
  description: string;
  product_status: 'draft' | 'published' | 'archived';
  category_id: string | null;
  category_slug: string | null;
  category_title: string | null;
  variant_id: string;
  variant_version: number;
  sku: string;
  material: Material;
  price_minor: string;
  on_hand: number;
  reserved: number;
  available: number;
  inventory_version: number;
  updated_at: Date;
};

function merchantCatalogRecord(row: MerchantCatalogDbRow): MerchantCatalogRecord {
  return {
    productId: row.product_id,
    productVersion: row.product_version,
    title: row.product_title,
    description: row.description,
    status: row.product_status,
    category:
      row.category_id && row.category_slug && row.category_title
        ? {
            id: row.category_id,
            slug: row.category_slug,
            title: row.category_title,
          }
        : null,
    variantId: row.variant_id,
    variantVersion: row.variant_version,
    sku: row.sku,
    material: row.material,
    priceMinor: row.price_minor,
    priceDisplay: formatMinor(BigInt(row.price_minor)),
    inventory: {
      onHand: row.on_hand,
      reserved: row.reserved,
      available: row.available,
      version: row.inventory_version,
    },
    updatedAt: row.updated_at.toISOString(),
  };
}

type MerchantOrderDbRow = {
  id: string;
  quote_id: string;
  receipt: string;
  razorpay_order_id: string;
  amount_minor: string;
  checkout_status: string;
  payment_id: string | null;
  provider_status: string | null;
  copy: string;
  created_at: Date;
  updated_at: Date;
  captured_at: Date | null;
};

function merchantOrderSummary(row: MerchantOrderDbRow): MerchantOrderSummary {
  const truth = paymentTruth(row.checkout_status);
  const paid = row.captured_at !== null && row.provider_status === 'captured';
  return {
    id: row.id,
    receipt: row.receipt,
    razorpayOrderId: row.razorpay_order_id,
    status: row.checkout_status,
    paymentState: row.provider_status ?? 'unknown',
    totalMinor: row.amount_minor,
    totalDisplay: formatMinor(BigInt(row.amount_minor)),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    paid,
    fulfillmentReady: paid,
    paymentTruth: truth.label,
  };
}

type SandboxFulfillment = {
  trackingId?: string;
  fulfillmentStatus?: FulfillmentStatus;
  shippingAddress?: ShippingAddress;
  nextFulfillmentStatus?: FulfillmentStatus | null;
  events: MerchantOrderDetail['timeline'];
};

async function loadSandboxFulfillment(
  trx: Transaction<Database>,
  tenantId: string,
  checkoutId: string,
): Promise<SandboxFulfillment> {
  const addressResult = await sql<{
    recipient_name: string;
    street: string;
    city: string;
    state: string;
    pincode: string;
    phone: string;
    source: ShippingAddress['source'];
  }>`
    select recipient_name, street, city, state, pincode, phone, source
    from commerce.shipping_addresses
    where tenant_id = ${tenantId}
      and checkout_id = ${checkoutId}::uuid
    limit 1
  `.execute(trx);
  const shipmentResult = await sql<{ tracking_id: string; status: string }>`
    select tracking_id, status
    from commerce.fulfillment_shipments
    where tenant_id = ${tenantId}
      and checkout_id = ${checkoutId}::uuid
    limit 1
  `.execute(trx);
  const eventResult = await sql<{
    id: string;
    status: string;
    note: string;
    occurred_at: Date;
  }>`
    select id, status, note, occurred_at
    from commerce.fulfillment_events
    where tenant_id = ${tenantId}
      and checkout_id = ${checkoutId}::uuid
    order by occurred_at, status, id
  `.execute(trx);
  const addressRow = addressResult.rows[0];
  const shipment = shipmentResult.rows[0];
  const fulfillmentStatus =
    shipment && isFulfillmentStatus(shipment.status) ? shipment.status : undefined;
  return {
    ...(shipment ? { trackingId: shipment.tracking_id } : {}),
    ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
    ...(addressRow
      ? {
          shippingAddress: {
            recipientName: addressRow.recipient_name,
            street: addressRow.street,
            city: addressRow.city,
            state: addressRow.state,
            pincode: addressRow.pincode,
            phone: addressRow.phone,
            source: addressRow.source,
          },
        }
      : {}),
    ...(fulfillmentStatus
      ? { nextFulfillmentStatus: nextFulfillmentStatus(fulfillmentStatus) }
      : {}),
    events: eventResult.rows.flatMap((event) => {
      if (!isFulfillmentStatus(event.status)) {
        return [];
      }
      return [
        {
          id: `fulfillment:${event.id}`,
          at: event.occurred_at.toISOString(),
          status: event.status,
          label: fulfillmentStatusLabel(event.status),
          detail: event.note || fulfillmentStatusDetail(event.status),
        },
      ];
    }),
  };
}

async function ensureSandboxFulfillment(
  trx: Transaction<Database>,
  tenantId: string,
  checkoutId: string,
  fulfillmentReady: boolean,
): Promise<SandboxFulfillment> {
  if (fulfillmentReady) {
    const address = mockIndianAddress(checkoutId);
    const trackingId = charterTrackingId(checkoutId);
    await sql`
      insert into commerce.shipping_addresses (
        tenant_id, checkout_id, recipient_name, street, city, state, pincode, phone, source
      ) values (
        ${tenantId},
        ${checkoutId}::uuid,
        ${address.recipientName},
        ${address.street},
        ${address.city},
        ${address.state},
        ${address.pincode},
        ${address.phone},
        ${address.source}
      )
      on conflict (tenant_id, checkout_id) do nothing
    `.execute(trx);
    await sql`
      insert into commerce.fulfillment_shipments (
        tenant_id, checkout_id, tracking_id, status
      ) values (
        ${tenantId},
        ${checkoutId}::uuid,
        ${trackingId},
        'confirmed'
      )
      on conflict (tenant_id, checkout_id) do nothing
    `.execute(trx);
    await sql`
      insert into commerce.fulfillment_events (
        tenant_id, checkout_id, status, note
      ) values (
        ${tenantId},
        ${checkoutId}::uuid,
        'confirmed',
        ${fulfillmentStatusDetail('confirmed')}
      )
      on conflict (tenant_id, checkout_id, status) do nothing
    `.execute(trx);
  }
  return loadSandboxFulfillment(trx, tenantId, checkoutId);
}

function withSandboxSummary(
  summary: MerchantOrderSummary,
  sandbox: SandboxFulfillment,
): MerchantOrderSummary {
  return {
    ...summary,
    ...(sandbox.trackingId ? { trackingId: sandbox.trackingId } : {}),
    ...(sandbox.fulfillmentStatus ? { fulfillmentStatus: sandbox.fulfillmentStatus } : {}),
  };
}

function timelineFromProviderTransition(transition: {
  id: string;
  observed_provider_status: string;
  to_checkout_status: string;
  occurred_at: Date;
  observed_at: Date;
  source: string;
  provider_reference: string;
}): MerchantOrderDetail['timeline'][number] {
  const status =
    transition.observed_provider_status === 'failed'
      ? 'failed_provisional'
      : transition.observed_provider_status === 'authorized'
        ? 'authorized'
        : transition.observed_provider_status === 'captured'
          ? 'captured'
          : transition.observed_provider_status === 'refunded'
            ? 'refunded'
            : transition.to_checkout_status.toLowerCase();
  const label =
    status === 'failed_provisional'
      ? 'Payment not confirmed'
      : status === 'authorized'
        ? 'Awaiting capture'
        : status === 'captured'
          ? 'Payment captured'
          : status === 'refunded'
            ? 'Payment refunded'
            : status === 'reconciling'
              ? 'Reconciling'
              : 'Provider status updated';
  const detail =
    status === 'captured'
      ? 'Captured ledger evidence. Eligible for fulfillment.'
      : status === 'authorized'
        ? 'Waiting for automatic capture. Not fulfilled.'
        : status === 'refunded'
          ? 'Refund evidence is not a capture. Not fulfilled.'
          : `Provider ${transition.source} observed ${transition.observed_provider_status} on ${transition.provider_reference}.`;
  return {
    id: `transition:${transition.id}`,
    at: transition.occurred_at.toISOString(),
    status,
    label,
    detail,
  };
}

type MerchantRecoveryDbRow = MerchantOrderDbRow & {
  consent_id: string | null;
  consent_status: 'granted' | 'revoked' | null;
  contact_value: string | null;
  attempt_status: 'pending' | 'sent' | 'delivered' | 'failed' | 'suppressed' | null;
  attempt_number: number | null;
  attempt_count: number;
  suppressed: boolean;
  killed: boolean;
  reconciliation_outcome: string | null;
};

function merchantRecoveryRecord(row: MerchantRecoveryDbRow): MerchantRecoveryRecord {
  const refunded = row.provider_status === 'refunded' || row.reconciliation_outcome === 'refunded';
  const captured =
    !refunded && (row.provider_status === 'captured' || row.checkout_status === 'SETTLED');
  const alreadySent =
    row.attempt_status === 'pending' ||
    row.attempt_status === 'sent' ||
    row.attempt_status === 'delivered';
  const retryLimitReached = row.attempt_count >= 2;
  const reconciling =
    !captured &&
    !refunded &&
    row.checkout_status === 'FAILED_PROVISIONAL' &&
    row.reconciliation_outcome !== 'same_order_retry_safe';
  const blockedReason = captured
    ? 'PAYMENT_CAPTURED'
    : refunded
      ? 'PAYMENT_REFUNDED'
      : row.killed
        ? 'CHECKOUT_KILLED'
        : row.suppressed
          ? 'SUPPRESSED'
          : row.consent_status !== 'granted'
            ? row.consent_status === 'revoked'
              ? 'CONSENT_REVOKED'
              : 'NO_CONSENT'
            : row.checkout_status !== 'FAILED_PROVISIONAL'
              ? 'NOT_FAILED_PROVISIONAL'
              : reconciling
                ? 'RECONCILIATION_REQUIRED'
                : alreadySent
                  ? row.attempt_status === 'pending'
                    ? 'ALREADY_PENDING'
                    : 'ALREADY_SENT'
                  : retryLimitReached
                    ? 'RETRY_LIMIT_REACHED'
                    : null;
  return {
    checkoutId: row.id,
    quoteId: row.quote_id,
    razorpayOrderId: row.razorpay_order_id,
    amountMinor: row.amount_minor,
    amountDisplay: formatMinor(BigInt(row.amount_minor)),
    checkoutStatus: row.checkout_status,
    reconciliationStatus: captured
      ? 'captured'
      : row.checkout_status === 'RECONCILING' || reconciling
        ? 'reconciling'
        : row.checkout_status === 'FAILED_PROVISIONAL'
          ? 'unresolved'
          : 'clear',
    consentStatus:
      row.consent_status === 'granted'
        ? 'granted'
        : row.consent_status === 'revoked'
          ? 'revoked'
          : 'missing',
    sendStatus: row.attempt_status ?? 'not_sent',
    stopStatus: captured
      ? 'captured'
      : row.killed
        ? 'killed'
        : row.suppressed
          ? 'suppressed'
          : 'clear',
    canSend: blockedReason === null,
    blockedReason,
    updatedAt: row.updated_at.toISOString(),
  };
}

function projectSettingsMembers(
  actorRole: ShopRole,
  members: MerchantSettingsSnapshot['members'],
): MerchantSettingsSnapshot['members'] {
  if (actorRole !== 'owner' && actorRole !== 'admin') {
    return [];
  }
  return members.map((member) => ({
    userId: member.userId,
    role: member.role,
    status: member.status,
    label: member.role,
  }));
}

function unpagedQuery(): PublicCatalogQuery {
  return {
    q: '',
    sku: '',
    category: '',
    inStock: false,
    minPriceMinor: null,
    maxPriceMinor: null,
    sort: 'name',
    limit: Number.MAX_SAFE_INTEGER,
    fingerprint: '',
    after: null,
  };
}

async function listPublishedBuyerShops(db: Kysely<Database>): Promise<BuyerOrderShop[]> {
  return withPublicCatalogContext(db, async (trx) => {
    const result = await sql<{
      tenant_id: string;
      slug: string;
      name: string;
      synthetic: boolean;
    }>`
      select shop.tenant_id, shop.slug, shop.name, shop.synthetic
      from catalog.shops shop
      where shop.status = 'published'
      order by shop.tenant_id
    `.execute(trx);
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      slug: row.slug,
      name: row.name,
      synthetic: row.synthetic,
    }));
  });
}

async function loadBuyerOrderDetail(
  trx: Transaction<Database>,
  tenantId: string,
  orderId: string,
): Promise<MerchantOrderDetail | undefined> {
  const orderResult = await sql<MerchantOrderDbRow>`
    select checkout_session.id,
           checkout_session.quote_id,
           checkout_session.receipt,
           checkout_session.razorpay_order_id,
           checkout_session.amount_minor::text,
           checkout_session.status as checkout_status,
           checkout_session.payment_id,
           checkout_session.provider_status,
           checkout_session.copy,
           checkout_session.created_at,
           checkout_session.updated_at,
           capture.created_at as captured_at
    from payments.checkout_sessions checkout_session
    left join lateral (
      select entry.created_at
      from ledger.ledger_entries entry
      where entry.tenant_id = checkout_session.tenant_id
        and entry.checkout_id = checkout_session.id
        and entry.kind = 'capture'
        and checkout_session.provider_status = 'captured'
        and not exists (
          select 1
          from ledger.ledger_entries reversal
          where reversal.tenant_id = entry.tenant_id
            and reversal.checkout_id = entry.checkout_id
            and reversal.kind in ('refund', 'void', 'capture_reversal')
        )
      order by entry.created_at desc
      limit 1
    ) capture on true
    where checkout_session.tenant_id = ${tenantId}
      and checkout_session.id = ${orderId}::uuid
    limit 1
  `.execute(trx);
  const row = orderResult.rows[0];
  if (!row) {
    return undefined;
  }
  const quoteResult = await sql<{
    id: string;
    status: string;
    subtotal_minor: string;
    discount_minor: string;
    total_minor: string;
    delivery_by: string;
    created_at: Date;
  }>`
    select quote.id,
           quote.status,
           quote.subtotal_minor::text,
           quote.discount_minor::text,
           quote.total_minor::text,
           to_char(quote.delivery_by, 'YYYY-MM-DD') as delivery_by,
           quote.created_at
    from commerce.quotes quote
    where quote.tenant_id = ${tenantId}
      and quote.id = ${row.quote_id}::uuid
    limit 1
  `.execute(trx);
  const quote = quoteResult.rows[0];
  if (!quote) {
    return undefined;
  }
  const lineResult = await sql<{
    sku: string;
    title: string;
    quantity: number;
    unit_minor: string;
    line_minor: string;
  }>`
    select line.sku,
           line.title,
           line.quantity,
           line.unit_minor::text,
           line.line_minor::text
    from commerce.quote_lines line
    where line.tenant_id = ${tenantId}
      and line.quote_id = ${row.quote_id}::uuid
    order by line.sku
  `.execute(trx);
  const attemptResult = await sql<{
    id: string;
    status: string;
    attempted_at: Date;
    completed_at: Date | null;
    failure_code: string | null;
  }>`
    select attempt.id,
           attempt.status,
           attempt.attempted_at,
           attempt.completed_at,
           attempt.failure_code
    from recovery.attempts attempt
    where attempt.tenant_id = ${tenantId}
      and attempt.checkout_id = ${row.id}::uuid
    order by attempt.attempt_number, attempt.id
  `.execute(trx);
  const summary = merchantOrderSummary(row);
  const timeline: MerchantOrderDetail['timeline'] = [
    {
      id: `quote:${quote.id}`,
      at: quote.created_at.toISOString(),
      status: 'quote_frozen',
      label: 'Quote frozen',
      detail: 'Line prices and totals were frozen for this checkout.',
    },
    {
      id: `provider-order:${row.id}`,
      at: row.created_at.toISOString(),
      status: 'provider_order_created',
      label: 'Razorpay Order created',
      detail: `Receipt ${row.receipt}. Payment is not fulfilled at this stage.`,
    },
  ];
  const transitionResult = await sql<{
    id: string;
    observed_provider_status: string;
    to_checkout_status: string;
    occurred_at: Date;
    observed_at: Date;
    source: string;
    provider_reference: string;
  }>`
    select id,
           observed_provider_status,
           to_checkout_status,
           occurred_at,
           observed_at,
           source,
           provider_reference
    from payments.payment_transitions
    where tenant_id = ${tenantId}
      and checkout_id = ${row.id}::uuid
    order by occurred_at, observed_at, id
  `.execute(trx);
  for (const transition of transitionResult.rows) {
    timeline.push(timelineFromProviderTransition(transition));
  }
  if (transitionResult.rows.length === 0) {
    if (row.captured_at) {
      timeline.push({
        id: `capture:${row.id}`,
        at: row.captured_at.toISOString(),
        status: 'captured',
        label: 'Payment captured',
        detail: 'Captured ledger evidence. Eligible for fulfillment.',
      });
    } else if (row.checkout_status === 'FAILED_PROVISIONAL') {
      timeline.push({
        id: `failure:${row.id}`,
        at: row.updated_at.toISOString(),
        status: 'failed_provisional',
        label: 'Payment not confirmed',
        detail: 'Provisional provider failure. Reconciliation remains authoritative.',
      });
    } else if (row.checkout_status === 'CAPTURE_PENDING') {
      timeline.push({
        id: `authorization:${row.id}`,
        at: row.updated_at.toISOString(),
        status: 'authorized',
        label: 'Awaiting capture',
        detail: 'Waiting for automatic capture. Not fulfilled.',
      });
    } else if (row.checkout_status === 'RECONCILING') {
      timeline.push({
        id: `reconciling:${row.id}`,
        at: row.updated_at.toISOString(),
        status: 'reconciling',
        label: 'Reconciling',
        detail: 'Payment not confirmed. Provider state is being fetched.',
      });
    } else {
      timeline.push({
        id: `status:${row.id}`,
        at: row.updated_at.toISOString(),
        status: row.checkout_status.toLowerCase(),
        label: 'Provider status updated',
        detail: row.copy,
      });
    }
  }
  for (const attempt of attemptResult.rows) {
    timeline.push({
      id: `recovery:${attempt.id}`,
      at: (attempt.completed_at ?? attempt.attempted_at).toISOString(),
      status: `recovery_${attempt.status}`,
      label: `Recovery ${attempt.status}`,
      detail:
        attempt.status === 'sent'
          ? 'A consented recovery email was sent.'
          : `Recovery stopped with ${attempt.failure_code ?? attempt.status}.`,
    });
  }
  timeline.sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  );
  const sandbox = await ensureSandboxFulfillment(trx, tenantId, row.id, summary.fulfillmentReady);
  timeline.push(...sandbox.events);
  timeline.sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  );
  return {
    ...withSandboxSummary(summary, sandbox),
    quote: {
      id: quote.id,
      status: quote.status,
      subtotalMinor: quote.subtotal_minor,
      discountMinor: quote.discount_minor,
      totalMinor: quote.total_minor,
      ...(quote.delivery_by ? { deliveryBy: quote.delivery_by } : {}),
      lines: lineResult.rows.map((line) => ({
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
        unitMinor: line.unit_minor,
        lineMinor: line.line_minor,
      })),
    },
    provider: {
      razorpayOrderId: row.razorpay_order_id,
      paymentId: row.payment_id,
      status: row.provider_status,
    },
    ...(sandbox.shippingAddress ? { shippingAddress: sandbox.shippingAddress } : {}),
    ...(sandbox.fulfillmentStatus
      ? { nextFulfillmentStatus: sandbox.nextFulfillmentStatus ?? null }
      : {}),
    timeline,
  };
}

export function createPostgresTenantRepository(db: Kysely<Database>): TenantRepository {
  type Executor = Kysely<Database> | Transaction<Database>;

  async function syncIdentity(identity: VerifiedIdentity): Promise<void> {
    const status = await withUserContext(db, { userId: identity.userId }, async (trx) => {
      const result = await sql<{ status: string }>`
        select app_private.sync_auth_user(
          ${identity.userId.toLowerCase()}::uuid,
          ${identity.email ?? null}
        ) as status
      `.execute(trx);
      return result.rows[0]?.status;
    });
    if (status !== 'active') {
      throw new Error('AUTH_USER_DISABLED');
    }
  }

  async function readShop(
    executor: Executor,
    column: 'slug' | 'tenant_id',
    value: string,
    publishedOnly: boolean,
  ): Promise<ShopRecord | undefined> {
    const result =
      column === 'slug'
        ? await sql<{
            tenant_id: string;
            slug: string;
            name: string;
            label: string;
            blurb: string;
            status: ShopRecord['status'];
            synthetic: boolean;
            version: number;
            published_at: Date | null;
            gstin: string;
            address_line: string;
            refund_policy: string;
            profile_verified: boolean;
          }>`
            select shop.tenant_id, shop.slug, shop.name, shop.label, shop.blurb,
                   shop.status, shop.synthetic, shop.version, shop.published_at,
                   shop.gstin, shop.address_line, shop.refund_policy, shop.profile_verified
            from catalog.shops shop
            where shop.slug = ${value}
              and shop.status <> 'archived'
              and (not ${publishedOnly} or shop.status = 'published')
            limit 1
          `.execute(executor)
        : await sql<{
            tenant_id: string;
            slug: string;
            name: string;
            label: string;
            blurb: string;
            status: ShopRecord['status'];
            synthetic: boolean;
            version: number;
            published_at: Date | null;
            gstin: string;
            address_line: string;
            refund_policy: string;
            profile_verified: boolean;
          }>`
            select shop.tenant_id, shop.slug, shop.name, shop.label, shop.blurb,
                   shop.status, shop.synthetic, shop.version, shop.published_at,
                   shop.gstin, shop.address_line, shop.refund_policy, shop.profile_verified
            from catalog.shops shop
            where shop.tenant_id = ${value}
              and shop.status <> 'archived'
              and (not ${publishedOnly} or shop.status = 'published')
            limit 1
          `.execute(executor);
    const row = result.rows[0];
    return row ? shopRecord(row) : undefined;
  }

  async function activeMembershipRole(
    executor: Executor,
    userId: string,
    tenantId: string,
  ): Promise<ShopRole | undefined> {
    const result = await sql<{ role: ShopRole }>`
      select membership.role
      from identity.shop_memberships membership
      join identity.users application_user
        on application_user.id = membership.user_id
       and application_user.status = 'active'
      join identity.tenants tenant
        on tenant.id = membership.tenant_id
       and tenant.status = 'active'
      where membership.user_id = ${userId.toLowerCase()}::uuid
        and membership.tenant_id = ${tenantId}
        and membership.status = 'active'
      limit 1
    `.execute(executor);
    return result.rows[0]?.role;
  }

  async function requireMembership(
    executor: Executor,
    userId: string,
    tenantId: string,
    allowedRoles?: readonly ShopRole[],
  ): Promise<ShopRole> {
    const role = await activeMembershipRole(executor, userId, tenantId);
    if (!role || (allowedRoles && !allowedRoles.includes(role))) {
      throw new Error('SHOP_MEMBERSHIP_REQUIRED');
    }
    return role;
  }

  async function readCatalog(
    executor: Executor,
    tenantId: string,
    publishedOnly: boolean,
  ): Promise<CatalogItem[]> {
    const result = await sql<{
      id: string;
      product_id: string;
      sku: string;
      title: string;
      price_minor: string;
      stock: number;
      material: Material;
      aliases: string[];
      status: 'draft' | 'published' | 'archived';
      category_slug: string | null;
      category_title: string | null;
      published_at: Date | null;
    }>`
      select variant.id,
             product.id as product_id,
             variant.sku,
             variant.title,
             variant.price_minor::text,
             ${publishedOnly ? sql`inventory.available` : sql`inventory.on_hand`} as stock,
             variant.material,
             variant.aliases,
             variant.status,
             category.slug as category_slug,
             category.title as category_title,
             variant.published_at
      from catalog.variants variant
      join catalog.products product
        on product.tenant_id = variant.tenant_id
       and product.id = variant.product_id
      join catalog.inventory inventory
        on inventory.tenant_id = variant.tenant_id
       and inventory.variant_id = variant.id
      left join catalog.categories category
        on category.tenant_id = product.tenant_id
       and category.id = product.category_id
       and category.status = 'active'
      where variant.tenant_id = ${tenantId}
        and (
          not ${publishedOnly}
          or (variant.status = 'published' and product.status = 'published')
        )
      order by variant.created_at, variant.id
    `.execute(executor);
    return result.rows.map((row) => {
      const minor = BigInt(row.price_minor);
      return {
        id: row.id,
        productId: row.product_id,
        sku: row.sku,
        title: row.title,
        priceMinor: row.price_minor,
        priceDisplay: formatMinor(minor),
        stock: row.stock,
        material: row.material,
        published: row.status === 'published',
        aliases: [...row.aliases],
        category:
          row.category_slug && row.category_title
            ? { slug: row.category_slug, title: row.category_title }
            : null,
        publishedAt: row.published_at?.toISOString() ?? null,
      };
    });
  }

  async function readMerchantCatalog(
    executor: Executor,
    input: {
      tenantId: string;
      limit: number;
      after: MerchantCursorPosition | null;
      productId?: string;
    },
  ): Promise<MerchantPage<MerchantCatalogRecord>> {
    const afterSort = input.after?.sortValue ?? null;
    const afterId = input.after?.id ?? null;
    const productId = input.productId ?? null;
    const result = await sql<MerchantCatalogDbRow>`
      select product.id as product_id,
             product.version as product_version,
             product.title as product_title,
             product.description,
             product.status as product_status,
             category.id as category_id,
             category.slug as category_slug,
             category.title as category_title,
             variant.id as variant_id,
             variant.version as variant_version,
             variant.sku,
             variant.material,
             variant.price_minor::text,
             inventory.on_hand,
             inventory.reserved,
             inventory.available,
             inventory.version as inventory_version,
             greatest(
               product.updated_at,
               variant.updated_at,
               inventory.updated_at
             ) as updated_at
      from catalog.products product
      join catalog.variants variant
        on variant.tenant_id = product.tenant_id
       and variant.product_id = product.id
      join catalog.inventory inventory
        on inventory.tenant_id = variant.tenant_id
       and inventory.variant_id = variant.id
      left join catalog.categories category
        on category.tenant_id = product.tenant_id
       and category.id = product.category_id
      where product.tenant_id = ${input.tenantId}
        and (${productId}::uuid is null or product.id = ${productId}::uuid)
        and (
          ${afterSort}::timestamptz is null
          or greatest(product.updated_at, variant.updated_at, inventory.updated_at)
              < ${afterSort}::timestamptz
          or (
            greatest(product.updated_at, variant.updated_at, inventory.updated_at)
              = ${afterSort}::timestamptz
            and product.id < ${afterId}::uuid
          )
        )
      order by greatest(
                 product.updated_at,
                 variant.updated_at,
                 inventory.updated_at
               ) desc,
               product.id desc
      limit ${input.limit + 1}
    `.execute(executor);
    const rows = result.rows.slice(0, input.limit).map(merchantCatalogRecord);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      cursor:
        result.rows.length > input.limit && last
          ? { sortValue: last.updatedAt, id: last.productId }
          : null,
    };
  }

  async function runMerchantCommand<T extends object>(
    trx: Transaction<Database>,
    input: {
      userId: string;
      tenantId: string | null;
      operation: string;
      idempotencyKey: string;
      requestHash: string;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    await sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`${input.userId.toLowerCase()}:${input.operation}:${input.idempotencyKey}`},
          0
        )
      )
    `.execute(trx);
    const existing = await sql<{ request_hash: string; response: unknown }>`
      select command.request_hash, command.response
      from operations.merchant_commands command
      where command.actor_id = ${input.userId.toLowerCase()}::uuid
        and command.operation = ${input.operation}
        and command.idempotency_key = ${input.idempotencyKey}
      limit 1
    `.execute(trx);
    const replay = existing.rows[0];
    if (replay) {
      if (replay.request_hash !== input.requestHash) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }
      return replay.response as T;
    }
    const response = await work();
    await sql`
      insert into operations.merchant_commands (
        actor_id,
        tenant_id,
        operation,
        idempotency_key,
        request_hash,
        response
      )
      values (
        ${input.userId.toLowerCase()}::uuid,
        ${input.tenantId},
        ${input.operation},
        ${input.idempotencyKey},
        ${input.requestHash},
        ${JSON.stringify(response)}::jsonb
      )
    `.execute(trx);
    return response;
  }

  async function readPublicCatalogSources(
    executor: Executor,
    slug?: string,
    tenantIds?: readonly string[],
    variantIds?: readonly string[],
  ): Promise<PublicCatalogSourceShop[]> {
    const result = await sql<{
      tenant_id: string;
      slug: string;
      name: string;
      label: string;
      blurb: string;
      shop_status: ShopRecord['status'];
      synthetic: boolean;
      shop_published_at: Date;
      variant_id: string | null;
      product_id: string | null;
      product_title: string | null;
      sku: string | null;
      variant_title: string | null;
      price_minor: string | null;
      available_stock: number | null;
      material: Material | null;
      aliases: string[] | null;
      variant_published_at: Date | null;
      category_slug: string | null;
      category_title: string | null;
    }>`
      select shop.tenant_id,
             shop.slug,
             shop.name,
             shop.label,
             shop.blurb,
             shop.status as shop_status,
             shop.synthetic,
             shop.published_at as shop_published_at,
             variant.id as variant_id,
             product.id as product_id,
             product.title as product_title,
             variant.sku,
             variant.title as variant_title,
             variant.price_minor::text,
             inventory.available as available_stock,
             variant.material,
             variant.aliases,
             variant.published_at as variant_published_at,
             category.slug as category_slug,
             category.title as category_title
      from catalog.shops shop
      left join catalog.products product
        on product.tenant_id = shop.tenant_id
       and product.status = ${'published'}
       and product.published_at is not null
      left join catalog.variants variant
        on variant.tenant_id = product.tenant_id
       and variant.product_id = product.id
       and variant.status = ${'published'}
       and variant.published_at is not null
       and (
         ${variantIds ? true : false} = false
         or variant.id = any(${variantIds ?? []}::uuid[])
       )
      left join catalog.inventory inventory
        on inventory.tenant_id = variant.tenant_id
       and inventory.variant_id = variant.id
      left join catalog.categories category
        on category.tenant_id = product.tenant_id
       and category.id = product.category_id
       and category.status = ${'active'}
      where shop.status = ${'published'}
        and shop.published_at is not null
        and (${slug ?? null}::text is null or shop.slug = ${slug ?? null})
        and (
          ${tenantIds ? true : false} = false
          or shop.tenant_id = any(${tenantIds ?? []}::text[])
        )
      order by shop.slug, variant.created_at, variant.id
    `.execute(executor);

    const shops = new Map<string, PublicCatalogSourceShop>();
    for (const row of result.rows) {
      let shop = shops.get(row.tenant_id);
      if (!shop) {
        shop = {
          tenantId: row.tenant_id,
          slug: row.slug,
          name: row.name,
          label: row.label,
          blurb: row.blurb,
          currency: 'INR',
          status: row.shop_status,
          synthetic: row.synthetic,
          publishedAt: row.shop_published_at.toISOString(),
          items: [],
        };
        shops.set(row.tenant_id, shop);
      }
      if (
        row.variant_id &&
        row.product_id &&
        row.product_title &&
        row.sku &&
        row.variant_title &&
        row.price_minor !== null &&
        row.available_stock !== null &&
        row.material &&
        row.aliases &&
        row.variant_published_at
      ) {
        shop.items.push({
          id: row.variant_id,
          productId: row.product_id,
          productTitle: row.product_title,
          sku: row.sku,
          title: row.variant_title,
          priceMinor: row.price_minor,
          availableStock: row.available_stock,
          category:
            row.category_slug && row.category_title
              ? { slug: row.category_slug, title: row.category_title }
              : null,
          material: row.material,
          aliases: [...row.aliases],
          publishedAt: row.variant_published_at.toISOString(),
        });
      }
    }
    return [...shops.values()];
  }

  function publicCategories(value: unknown): PublicCategory[] {
    return Array.isArray(value)
      ? value.flatMap((entry) =>
          entry &&
          typeof entry === 'object' &&
          'slug' in entry &&
          typeof entry.slug === 'string' &&
          'title' in entry &&
          typeof entry.title === 'string'
            ? [{ slug: entry.slug, title: entry.title }]
            : [],
        )
      : [];
  }

  function publicFacets(
    categories: unknown,
    inStockCount: string,
    minPriceMinor: string | null,
    maxPriceMinor: string | null,
  ): PublicCatalogFacets {
    return {
      categories: Array.isArray(categories)
        ? categories.flatMap((entry) =>
            entry &&
            typeof entry === 'object' &&
            'slug' in entry &&
            typeof entry.slug === 'string' &&
            'title' in entry &&
            typeof entry.title === 'string' &&
            'count' in entry &&
            (typeof entry.count === 'number' || typeof entry.count === 'string')
              ? [{ slug: entry.slug, title: entry.title, count: Number(entry.count) }]
              : [],
          )
        : [],
      inStockCount: Number(inStockCount),
      minPriceMinor,
      maxPriceMinor,
    };
  }

  async function queryPublicDirectory(
    executor: Executor,
    query: PublicCatalogQuery,
  ): Promise<PublicDirectoryResult> {
    const tokens = lexicalSearchTokens(query.q);
    const phrase = lexicalPhrase(query.q);
    const requiresProduct =
      Boolean(query.category) ||
      query.inStock ||
      query.minPriceMinor !== null ||
      query.maxPriceMinor !== null;
    const after = query.after;
    const keyset = !after
      ? sql`true`
      : query.sort === 'name'
        ? sql`(matching.sort_name, matching.tenant_id) > (${after.name}, ${after.id})`
        : query.sort === 'rating'
          ? sql`(
              matching.rating_milli < ${after.ratingMilli}
              or (
                matching.rating_milli = ${after.ratingMilli}
                and (
                  matching.review_count < ${after.reviewCount}
                  or (
                    matching.review_count = ${after.reviewCount}
                    and (matching.sort_name, matching.tenant_id) > (${after.name}, ${after.id})
                  )
                )
              )
            )`
          : query.sort === 'relevance' && query.q
            ? sql`(
              matching.relevance < ${after.relevance}
              or (
                matching.relevance = ${after.relevance}
                and (
                  matching.published_at < ${after.publishedAt}::timestamptz
                  or (
                    matching.published_at = ${after.publishedAt}::timestamptz
                    and (matching.sort_name, matching.tenant_id) > (${after.name}, ${after.id})
                  )
                )
              )
            )`
            : sql`(
              matching.published_at < ${after.publishedAt}::timestamptz
              or (
                matching.published_at = ${after.publishedAt}::timestamptz
                and (matching.sort_name, matching.tenant_id) > (${after.name}, ${after.id})
              )
            )`;
    const order =
      query.sort === 'name'
        ? sql`matching.sort_name asc, matching.tenant_id asc`
        : query.sort === 'rating'
          ? sql`matching.rating_milli desc, matching.review_count desc, matching.sort_name asc, matching.tenant_id asc`
          : query.sort === 'relevance' && query.q
            ? sql`matching.relevance desc, matching.published_at desc, matching.sort_name asc, matching.tenant_id asc`
            : sql`matching.published_at desc, matching.sort_name asc, matching.tenant_id asc`;
    const pageOrder =
      query.sort === 'name'
        ? sql`page.sort_name asc, page.tenant_id asc`
        : query.sort === 'rating'
          ? sql`page.rating_milli desc, page.review_count desc, page.sort_name asc, page.tenant_id asc`
          : query.sort === 'relevance' && query.q
            ? sql`page.relevance desc, page.published_at desc, page.sort_name asc, page.tenant_id asc`
            : sql`page.published_at desc, page.sort_name asc, page.tenant_id asc`;
    const result = await sql<{
      total: string;
      facet_categories: unknown;
      facet_in_stock_count: string;
      facet_min_price_minor: string | null;
      facet_max_price_minor: string | null;
      tenant_id: string | null;
      slug: string | null;
      name: string | null;
      blurb: string | null;
      synthetic: boolean | null;
      published_at: Date | null;
      sort_name: string | null;
      relevance: number | null;
      item_count: string | null;
      in_stock_count: string | null;
      units_in_stock: string | null;
      categories: unknown;
      starting_price_minor: string | null;
      rating_milli: number | null;
      review_count: number | null;
      refund_policy: string | null;
    }>`
      with published_shops as (
        select shop.tenant_id, shop.slug, shop.name, shop.blurb, shop.synthetic,
               shop.published_at, shop.rating_milli, shop.review_count, shop.refund_policy,
               lower(shop.name) as sort_name,
               greatest(
                 (${lexicalColumnScore('shop.name', phrase, tokens, 40)})::integer,
                 (${lexicalColumnScore('shop.blurb', phrase, tokens, 18)})::integer,
                 (${lexicalColumnScore("coalesce(shop.refund_policy, '')", phrase, tokens, 14)})::integer
               )::integer as shop_relevance
        from catalog.shops shop
        where shop.status = ${'published'} and shop.published_at is not null
      ),
      catalog_rows as (
        select product.tenant_id, product.id as product_id, product.title as product_title,
               variant.id, variant.sku, variant.title, variant.price_minor,
               inventory.available, variant.material, variant.aliases, variant.published_at,
               category.slug as category_slug, category.title as category_title
        from catalog.products product
        join catalog.variants variant
          on variant.tenant_id = product.tenant_id and variant.product_id = product.id
         and variant.status = ${'published'} and variant.published_at is not null
        join catalog.inventory inventory
          on inventory.tenant_id = variant.tenant_id and inventory.variant_id = variant.id
        left join catalog.categories category
          on category.tenant_id = product.tenant_id and category.id = product.category_id
         and category.status = ${'active'}
        where product.status = ${'published'} and product.published_at is not null
      ),
      scored_items as (
        select catalog_rows.*,
          greatest(
            (${lexicalColumnScore('product_title', phrase, tokens, 28)})::integer,
            (${lexicalColumnScore('title', phrase, tokens, 30)})::integer,
            (${lexicalColumnScore('sku', phrase, tokens, 12)})::integer,
            (${lexicalColumnScore('material', phrase, tokens, 10)})::integer,
            (${lexicalColumnScore("coalesce(category_title, '')", phrase, tokens, 20)})::integer,
            (${lexicalColumnScore("coalesce(category_slug, '')", phrase, tokens, 12)})::integer,
            coalesce((
              select max((${lexicalColumnScore('alias_value', phrase, tokens, 26)})::integer)
              from unnest(coalesce(aliases, '{}'::text[])) alias_value
            ), 0)
          )::integer as item_relevance
        from catalog_rows
      ),
      filtered_items as (
        select * from scored_items
        where (${query.category} = '' or category_slug = ${query.category})
          and (not ${query.inStock} or available > 0)
          and (${query.minPriceMinor}::bigint is null or price_minor >= ${query.minPriceMinor}::bigint)
          and (${query.maxPriceMinor}::bigint is null or price_minor <= ${query.maxPriceMinor}::bigint)
      ),
      ranked_base as (
        select shop.*, greatest(shop.shop_relevance, coalesce(max(item.item_relevance), 0))::integer as relevance,
               count(item.id)::integer as matched_item_count
        from published_shops shop
        left join filtered_items item on item.tenant_id = shop.tenant_id
        group by shop.tenant_id, shop.slug, shop.name, shop.blurb, shop.synthetic,
                 shop.published_at, shop.rating_milli, shop.review_count, shop.refund_policy,
                 shop.sort_name, shop.shop_relevance
      ),
      matching as (
        select * from ranked_base
        where (not ${requiresProduct} or matched_item_count > 0)
          and (${query.q} = '' or relevance > 0)
      ),
      shop_facts as (
        select matching.tenant_id, count(item.id)::text as item_count,
               count(item.id) filter (where item.available > 0)::text as in_stock_count,
               coalesce(sum(item.available), 0)::text as units_in_stock,
               min(item.price_minor)::text as starting_price_minor,
               coalesce(jsonb_agg(distinct jsonb_build_object(
                 'slug', item.category_slug, 'title', item.category_title
               )) filter (where item.category_slug is not null), '[]'::jsonb) as categories
        from matching left join catalog_rows item on item.tenant_id = matching.tenant_id
        group by matching.tenant_id
      ),
      category_facets as (
        select item.category_slug as slug, item.category_title as title,
               count(distinct matching.tenant_id)::integer as count
        from matching join catalog_rows item on item.tenant_id = matching.tenant_id
        where item.category_slug is not null
        group by item.category_slug, item.category_title
      ),
      metadata as (
        select count(*)::text as total,
          coalesce((select jsonb_agg(to_jsonb(category_facets) order by title, slug) from category_facets), '[]'::jsonb) as facet_categories,
          count(*) filter (where facts.in_stock_count::integer > 0)::text as facet_in_stock_count,
          (select min(item.price_minor)::text from matching join catalog_rows item using (tenant_id)) as facet_min_price_minor,
          (select max(item.price_minor)::text from matching join catalog_rows item using (tenant_id)) as facet_max_price_minor
        from matching join shop_facts facts using (tenant_id)
      ),
      page as (
        select matching.*, facts.item_count, facts.in_stock_count, facts.units_in_stock,
               facts.categories, facts.starting_price_minor
        from matching join shop_facts facts using (tenant_id)
        where ${keyset}
        order by ${order}
        limit ${query.limit + 1}
      )
      select metadata.*, page.tenant_id, page.slug, page.name, page.blurb, page.synthetic,
             page.published_at, page.sort_name, page.relevance, page.item_count,
             page.in_stock_count, page.units_in_stock, page.categories, page.starting_price_minor,
             page.rating_milli, page.review_count, page.refund_policy
      from metadata
      left join lateral (select * from page) page on true
      order by ${pageOrder}
    `.execute(executor);
    const metadata = result.rows[0];
    if (!metadata) {
      throw new Error('PUBLIC_DIRECTORY_METADATA_MISSING');
    }
    const pageRows = result.rows.filter(
      (
        row,
      ): row is typeof row & {
        tenant_id: string;
        published_at: Date;
        name: string;
        slug: string;
        blurb: string;
        synthetic: boolean;
        sort_name: string;
        relevance: number;
        item_count: string;
        in_stock_count: string;
        units_in_stock: string;
        rating_milli: number;
        review_count: number;
        refund_policy: string;
      } =>
        row.tenant_id !== null &&
        row.published_at !== null &&
        row.name !== null &&
        row.slug !== null &&
        row.blurb !== null &&
        row.synthetic !== null &&
        row.sort_name !== null &&
        row.relevance !== null &&
        row.item_count !== null &&
        row.in_stock_count !== null &&
        row.units_in_stock !== null &&
        row.rating_milli !== null &&
        row.review_count !== null &&
        row.refund_policy !== null,
    );
    const hasMore = pageRows.length > query.limit;
    const rows = pageRows.slice(0, query.limit);
    const items: PublicShop[] = rows.map((row) => {
      const categories = publicCategories(row.categories);
      return {
        tenantId: row.tenant_id,
        slug: row.slug,
        name: row.name,
        blurb: row.blurb,
        currency: 'INR',
        synthetic: row.synthetic,
        publishedAt: row.published_at.toISOString(),
        href: `/shops/${row.slug}`,
        catalogPath: `/api/v1/merchants/${row.tenant_id}/catalog`,
        itemCount: Number(row.item_count),
        inStockCount: Number(row.in_stock_count),
        unitsInStock: Number(row.units_in_stock),
        categories,
        startingPriceMinor: row.starting_price_minor,
        startingPriceDisplay:
          row.starting_price_minor === null ? null : formatMinor(BigInt(row.starting_price_minor)),
        rating: publicRating(row.rating_milli),
        reviewCount: row.review_count,
        refundPolicy: row.refund_policy,
        matchedOn: shopMatchReasons({ name: row.name, blurb: row.blurb, categories }, query),
      };
    });
    const last = rows.at(-1);
    return {
      items,
      total: Number(metadata.total),
      facets: publicFacets(
        metadata.facet_categories,
        metadata.facet_in_stock_count,
        metadata.facet_min_price_minor,
        metadata.facet_max_price_minor,
      ),
      cursor:
        hasMore && last
          ? {
              relevance: last.relevance,
              publishedAt: last.published_at.toISOString(),
              name: last.sort_name,
              id: last.tenant_id,
              ratingMilli: last.rating_milli,
              reviewCount: last.review_count,
            }
          : null,
    };
  }

  async function queryPublicCatalog(
    executor: Executor,
    slug: string,
    query: PublicCatalogQuery,
  ): Promise<PublicShopCatalogResult | undefined> {
    const tokens = lexicalSearchTokens(query.q);
    const phrase = lexicalPhrase(query.q);
    const after = query.after;
    const keyset = !after
      ? sql`true`
      : query.sort === 'name'
        ? sql`(matching.sort_name, matching.id) > (${after.name}, ${after.id}::uuid)`
        : query.sort === 'relevance' && query.q
          ? sql`(
              matching.relevance < ${after.relevance}
              or (
                matching.relevance = ${after.relevance}
                and (
                  matching.published_at < ${after.publishedAt}::timestamptz
                  or (
                    matching.published_at = ${after.publishedAt}::timestamptz
                    and (matching.sort_name, matching.id) > (${after.name}, ${after.id}::uuid)
                  )
                )
              )
            )`
          : sql`(
              matching.published_at < ${after.publishedAt}::timestamptz
              or (
                matching.published_at = ${after.publishedAt}::timestamptz
                and (matching.sort_name, matching.id) > (${after.name}, ${after.id}::uuid)
              )
            )`;
    const order =
      query.sort === 'name'
        ? sql`matching.sort_name asc, matching.id asc`
        : query.sort === 'relevance' && query.q
          ? sql`matching.relevance desc, matching.published_at desc, matching.sort_name asc, matching.id asc`
          : sql`matching.published_at desc, matching.sort_name asc, matching.id asc`;
    const pageOrder =
      query.sort === 'name'
        ? sql`page.sort_name asc, page.id asc`
        : query.sort === 'relevance' && query.q
          ? sql`page.relevance desc, page.published_at desc, page.sort_name asc, page.id asc`
          : sql`page.published_at desc, page.sort_name asc, page.id asc`;
    const result = await sql<{
      shop_tenant_id: string;
      shop_slug: string;
      shop_name: string;
      shop_blurb: string;
      shop_synthetic: boolean;
      shop_published_at: Date;
      shop_item_count: string;
      shop_in_stock_count: string;
      shop_units_in_stock: string;
      shop_categories: unknown;
      shop_starting_price_minor: string | null;
      shop_rating_milli: number;
      shop_review_count: number;
      shop_refund_policy: string;
      total: string;
      facet_categories: unknown;
      facet_in_stock_count: string;
      facet_min_price_minor: string | null;
      facet_max_price_minor: string | null;
      id: string | null;
      product_id: string | null;
      sku: string | null;
      title: string | null;
      price_minor: string | null;
      available: number | null;
      material: Material | null;
      published_at: Date | null;
      category_slug: string | null;
      category_title: string | null;
      sort_name: string | null;
      relevance: number | null;
    }>`
      with published_shop as (
        select shop.tenant_id, shop.slug, shop.name, shop.blurb, shop.synthetic, shop.published_at,
               shop.rating_milli, shop.review_count, shop.refund_policy
        from catalog.shops shop
        where shop.slug = ${slug} and shop.status = ${'published'} and shop.published_at is not null
      ),
      catalog_rows as (
        select product.tenant_id, shop.name as shop_name, shop.blurb as shop_blurb,
               product.id as product_id, product.title as product_title,
               variant.id, variant.sku, variant.title, variant.price_minor,
               inventory.available, variant.material, variant.aliases, variant.published_at,
               category.slug as category_slug, category.title as category_title,
               lower(variant.title) as sort_name
        from published_shop shop
        join catalog.products product
          on product.tenant_id = shop.tenant_id
         and product.status = ${'published'} and product.published_at is not null
        join catalog.variants variant
          on variant.tenant_id = product.tenant_id and variant.product_id = product.id
         and variant.status = ${'published'} and variant.published_at is not null
        join catalog.inventory inventory
          on inventory.tenant_id = variant.tenant_id and inventory.variant_id = variant.id
        left join catalog.categories category
          on category.tenant_id = product.tenant_id and category.id = product.category_id
         and category.status = ${'active'}
      ),
      scored_items as (
        select catalog_rows.*,
          greatest(
            (${lexicalColumnScore('product_title', phrase, tokens, 28)})::integer,
            (${lexicalColumnScore('title', phrase, tokens, 30)})::integer,
            (${lexicalColumnScore('sku', phrase, tokens, 12)})::integer,
            (${lexicalColumnScore('material', phrase, tokens, 10)})::integer,
            (${lexicalColumnScore("coalesce(category_title, '')", phrase, tokens, 20)})::integer,
            (${lexicalColumnScore("coalesce(category_slug, '')", phrase, tokens, 12)})::integer,
            coalesce((
              select max((${lexicalColumnScore('alias_value', phrase, tokens, 26)})::integer)
              from unnest(coalesce(aliases, '{}'::text[])) alias_value
            ), 0)
          )::integer as relevance
        from catalog_rows
      ),
      matching as (
        select * from scored_items
        where (${query.sku} = '' or sku = ${query.sku})
          and (${query.category} = '' or category_slug = ${query.category})
          and (not ${query.inStock} or available > 0)
          and (${query.minPriceMinor}::bigint is null or price_minor >= ${query.minPriceMinor}::bigint)
          and (${query.maxPriceMinor}::bigint is null or price_minor <= ${query.maxPriceMinor}::bigint)
          and (${query.q} = '' or relevance > 0)
      ),
      shop_facts as (
        select count(id)::text as item_count,
               count(id) filter (where available > 0)::text as in_stock_count,
               coalesce(sum(available), 0)::text as units_in_stock,
               min(price_minor)::text as starting_price_minor,
               coalesce(jsonb_agg(distinct jsonb_build_object(
                 'slug', category_slug, 'title', category_title
               )) filter (where category_slug is not null), '[]'::jsonb) as categories
        from catalog_rows
      ),
      category_facets as (
        select category_slug as slug, category_title as title, count(*)::integer as count
        from matching where category_slug is not null
        group by category_slug, category_title
      ),
      metadata as (
        select count(*)::text as total,
          coalesce((select jsonb_agg(to_jsonb(category_facets) order by title, slug) from category_facets), '[]'::jsonb) as facet_categories,
          count(*) filter (where available > 0)::text as facet_in_stock_count,
          min(price_minor)::text as facet_min_price_minor,
          max(price_minor)::text as facet_max_price_minor
        from matching
      ),
      page as (
        select * from matching
        where ${keyset}
        order by ${order}
        limit ${query.limit + 1}
      )
      select shop.tenant_id as shop_tenant_id, shop.slug as shop_slug,
             shop.name as shop_name, shop.blurb as shop_blurb,
             shop.synthetic as shop_synthetic, shop.published_at as shop_published_at,
             shop.rating_milli as shop_rating_milli, shop.review_count as shop_review_count,
             shop.refund_policy as shop_refund_policy,
             facts.item_count as shop_item_count, facts.in_stock_count as shop_in_stock_count,
             facts.units_in_stock as shop_units_in_stock, facts.categories as shop_categories,
             facts.starting_price_minor as shop_starting_price_minor,
             metadata.*, page.id, page.product_id, page.sku, page.title,
             page.price_minor::text, page.available, page.material, page.published_at,
             page.category_slug, page.category_title, page.sort_name, page.relevance
      from published_shop shop cross join shop_facts facts cross join metadata
      left join lateral (select * from page) page on true
      order by ${pageOrder}
    `.execute(executor);
    const metadata = result.rows[0];
    if (!metadata) {
      return undefined;
    }
    const pageRows = result.rows.filter(
      (
        row,
      ): row is typeof row & {
        id: string;
        product_id: string;
        sku: string;
        title: string;
        price_minor: string;
        available: number;
        material: Material;
        published_at: Date;
        sort_name: string;
        relevance: number;
      } =>
        row.id !== null &&
        row.product_id !== null &&
        row.sku !== null &&
        row.title !== null &&
        row.price_minor !== null &&
        row.available !== null &&
        row.material !== null &&
        row.published_at !== null &&
        row.sort_name !== null &&
        row.relevance !== null,
    );
    const hasMore = pageRows.length > query.limit;
    const rows = pageRows.slice(0, query.limit);
    const startingPrice = metadata.shop_starting_price_minor;
    const shop: PublicShop = {
      tenantId: metadata.shop_tenant_id,
      slug: metadata.shop_slug,
      name: metadata.shop_name,
      blurb: metadata.shop_blurb,
      currency: 'INR',
      synthetic: metadata.shop_synthetic,
      publishedAt: metadata.shop_published_at.toISOString(),
      href: `/shops/${metadata.shop_slug}`,
      catalogPath: `/api/v1/merchants/${metadata.shop_tenant_id}/catalog`,
      itemCount: Number(metadata.shop_item_count),
      inStockCount: Number(metadata.shop_in_stock_count),
      unitsInStock: Number(metadata.shop_units_in_stock),
      categories: publicCategories(metadata.shop_categories),
      startingPriceMinor: startingPrice,
      startingPriceDisplay: startingPrice === null ? null : formatMinor(BigInt(startingPrice)),
      rating: publicRating(metadata.shop_rating_milli),
      reviewCount: metadata.shop_review_count,
      refundPolicy: metadata.shop_refund_policy,
      matchedOn: shopMatchReasons(
        {
          name: metadata.shop_name,
          blurb: metadata.shop_blurb,
          categories: publicCategories(metadata.shop_categories),
        },
        query,
      ),
    };
    const last = rows.at(-1);
    return {
      shop,
      items: rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        sku: row.sku,
        title: row.title,
        priceMinor: row.price_minor,
        priceDisplay: formatMinor(BigInt(row.price_minor)),
        availableStock: row.available,
        category:
          row.category_slug && row.category_title
            ? { slug: row.category_slug, title: row.category_title }
            : null,
        material: row.material,
        publishedAt: row.published_at.toISOString(),
        provenance: 'merchant',
      })),
      total: Number(metadata.total),
      facets: publicFacets(
        metadata.facet_categories,
        metadata.facet_in_stock_count,
        metadata.facet_min_price_minor,
        metadata.facet_max_price_minor,
      ),
      cursor:
        hasMore && last
          ? {
              relevance: last.relevance,
              publishedAt: last.published_at.toISOString(),
              name: last.sort_name,
              id: last.id,
              ratingMilli: 0,
              reviewCount: 0,
            }
          : null,
    };
  }

  async function readKillSnapshot(
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<KillSnapshot> {
    const result = await sql<{ scope: 'global' | 'tenant'; tenant_id: string | null }>`
      select scope, tenant_id
      from operations.kill_switches
      where feature = 'checkout'
        and enabled = true
    `.execute(executor);
    return {
      global: result.rows.some((row) => row.scope === 'global'),
      tenants: Object.fromEntries(
        result.rows
          .filter((row): row is { scope: 'tenant'; tenant_id: string } =>
            Boolean(row.scope === 'tenant' && row.tenant_id),
          )
          .map((row) => [row.tenant_id, true]),
      ),
    };
  }

  async function killSnapshot(userId: string): Promise<KillSnapshot> {
    return withUserContext(db, { userId }, (trx) => readKillSnapshot(trx));
  }

  async function readMerchantRecovery(
    executor: Executor,
    input: {
      tenantId: string;
      status: string;
      limit: number;
      after: MerchantCursorPosition | null;
      checkoutId?: string;
    },
  ): Promise<MerchantPage<MerchantRecoveryRecord>> {
    const afterSort = input.after?.sortValue ?? null;
    const afterId = input.after?.id ?? null;
    const checkoutId = input.checkoutId ?? null;
    const result = await sql<MerchantRecoveryDbRow>`
      select checkout_session.id,
             checkout_session.quote_id,
             checkout_session.receipt,
             checkout_session.razorpay_order_id,
             checkout_session.amount_minor::text,
             checkout_session.status as checkout_status,
             checkout_session.payment_id,
             checkout_session.provider_status,
             checkout_session.copy,
             checkout_session.created_at,
             checkout_session.updated_at,
             capture.created_at as captured_at,
             consent.id as consent_id,
             consent.status as consent_status,
             consent.contact_value,
             latest_attempt.status as attempt_status,
             latest_attempt.attempt_number,
             (
               select count(*)::int
               from recovery.attempts counted_attempt
               where counted_attempt.tenant_id = checkout_session.tenant_id
                 and counted_attempt.checkout_id = checkout_session.id
                 and counted_attempt.status <> 'suppressed'
             ) as attempt_count,
             exists (
               select 1
               from recovery.suppressions suppression
               where suppression.tenant_id = checkout_session.tenant_id
                 and suppression.contact_value = consent.contact_value
                 and suppression.purpose = 'payment_recovery'
                 and suppression.channel = 'email'
                 and suppression.active
             ) as suppressed,
             app_private.is_checkout_killed(checkout_session.tenant_id) as killed,
             snapshot.outcome as reconciliation_outcome
      from payments.checkout_sessions checkout_session
      left join lateral (
        select entry.created_at
        from ledger.ledger_entries entry
        where entry.tenant_id = checkout_session.tenant_id
          and entry.checkout_id = checkout_session.id
          and entry.kind = 'capture'
          and checkout_session.provider_status = 'captured'
          and not exists (
            select 1
            from ledger.ledger_entries reversal
            where reversal.tenant_id = entry.tenant_id
              and reversal.checkout_id = entry.checkout_id
              and reversal.kind in ('refund', 'void', 'capture_reversal')
          )
        order by entry.created_at desc
        limit 1
      ) capture on true
      left join recovery.checkout_consents checkout_consent
        on checkout_consent.tenant_id = checkout_session.tenant_id
       and checkout_consent.checkout_id = checkout_session.id
      left join recovery.consents consent
        on consent.tenant_id = checkout_consent.tenant_id
       and consent.id = checkout_consent.consent_id
      left join lateral (
        select attempt.status, attempt.attempt_number, attempt.id
        from recovery.attempts attempt
        where attempt.tenant_id = checkout_session.tenant_id
          and attempt.checkout_id = checkout_session.id
        order by attempt.attempt_number desc, attempt.id desc
        limit 1
      ) latest_attempt on true
      left join payments.reconciliation_snapshots snapshot
        on snapshot.tenant_id = checkout_session.tenant_id
       and snapshot.checkout_id = checkout_session.id
      where checkout_session.tenant_id = ${input.tenantId}
        and (${checkoutId}::uuid is null or checkout_session.id = ${checkoutId}::uuid)
        and (
          ${checkoutId}::uuid is not null
          or checkout_session.status in ('FAILED_PROVISIONAL', 'RECONCILING')
          or latest_attempt.id is not null
        )
        and (
          ${input.status} = ''
          or checkout_session.status = ${input.status}
          or latest_attempt.status = ${input.status}
        )
        and (
          ${afterSort}::timestamptz is null
          or checkout_session.updated_at < ${afterSort}::timestamptz
          or (
            checkout_session.updated_at = ${afterSort}::timestamptz
            and checkout_session.id < ${afterId}::uuid
          )
        )
      order by checkout_session.updated_at desc, checkout_session.id desc
      limit ${input.limit + 1}
    `.execute(executor);
    const items = result.rows.slice(0, input.limit).map(merchantRecoveryRecord);
    const last = items[items.length - 1];
    return {
      items,
      cursor:
        result.rows.length > input.limit && last
          ? { sortValue: last.updatedAt, id: last.checkoutId }
          : null,
    };
  }

  async function readMerchantRules(
    executor: Executor,
    tenantId: string,
  ): Promise<MerchantRulesSnapshot | undefined> {
    const result = await sql<{
      hard_cap_minor: string;
      autonomous_cap_minor: string;
      forbidden_materials: string[];
      rules: unknown;
      version: number;
      updated_at: Date;
    }>`
      select policy.hard_cap_minor::text,
             policy.autonomous_cap_minor::text,
             policy.forbidden_materials,
             policy.rules,
             policy.version,
             policy.updated_at
      from policy.shop_policies policy
      where policy.tenant_id = ${tenantId}
      limit 1
    `.execute(executor);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      version: row.version,
      hardCapMinor: row.hard_cap_minor,
      hardCapDisplay: formatMinor(BigInt(row.hard_cap_minor)),
      autonomousCapMinor: row.autonomous_cap_minor,
      autonomousCapDisplay: formatMinor(BigInt(row.autonomous_cap_minor)),
      forbiddenMaterials: [...row.forbidden_materials],
      offers: policyOffers(row.rules).map(snapshotOffer),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async function readMerchantSettings(
    executor: Executor,
    tenantId: string,
    testMode: boolean,
    actorRole: ShopRole,
  ): Promise<MerchantSettingsSnapshot | undefined> {
    const shopResult = await sql<{
      name: string;
      blurb: string;
      slug: string;
      synthetic: boolean;
      version: number;
      gstin: string;
      address_line: string;
      refund_policy: string;
      profile_verified: boolean;
    }>`
      select shop.name, shop.blurb, shop.slug, shop.synthetic, shop.version,
             shop.gstin, shop.address_line, shop.refund_policy, shop.profile_verified
      from catalog.shops shop
      where shop.tenant_id = ${tenantId}
        and shop.status <> 'archived'
      limit 1
    `.execute(executor);
    const shop = shopResult.rows[0];
    if (!shop) {
      return undefined;
    }
    const memberResult = await sql<{
      user_id: string;
      role: string;
      status: string;
    }>`
      select membership.user_id::text, membership.role, membership.status
      from identity.shop_memberships membership
      where membership.tenant_id = ${tenantId}
      order by membership.role, membership.user_id
    `.execute(executor);
    return {
      version: shop.version,
      name: shop.name,
      blurb: shop.blurb,
      slug: shop.slug,
      publicPath: `/shops/${shop.slug}`,
      synthetic: shop.synthetic,
      testMode,
      paymentAccountDisclosure: testMode
        ? 'Razorpay test mode. No live money is accepted.'
        : 'Live payment account status is managed by the payment provider.',
      gstin: shop.gstin,
      addressLine: shop.address_line,
      refundPolicy: shop.refund_policy,
      profileVerified: shop.profile_verified,
      members: projectSettingsMembers(
        actorRole,
        memberResult.rows.map((member) => ({
          userId: member.user_id,
          role: member.role,
          status: member.status,
          label: member.role,
        })),
      ),
    };
  }

  return {
    async getMerchantOverview(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId);
          const result = await sql<{
            captured_gmv_minor: string;
            captured_orders: number;
            valid_quotes: number;
            failed_unresolved: number;
            recovered_minor: string;
            inventory_units: number;
            low_stock_variants: number;
            synthetic: boolean;
          }>`
          select
            coalesce((
              select coalesce(sum(quote.total_minor), 0)::text
              from commerce.quotes quote
              where quote.tenant_id = ${input.tenantId}
                and quote.created_at >= ${input.from}::date
                and quote.created_at < (${input.to}::date + interval '1 day')
                and exists (
                  select 1
                  from ledger.ledger_entries entry
                  where entry.tenant_id = quote.tenant_id
                    and entry.quote_id = quote.id
                    and entry.kind = 'capture'
                    and not exists (
                      select 1
                      from ledger.ledger_entries reversal
                      where reversal.tenant_id = entry.tenant_id
                        and reversal.checkout_id = entry.checkout_id
                        and reversal.kind in ('refund', 'void', 'capture_reversal')
                    )
                    and entry.created_at >= ${input.from}::date
                    and entry.created_at < (${input.to}::date + interval '1 day')
                )
            ), '0') as captured_gmv_minor,
            (
              select count(*)::int
              from commerce.quotes quote
              where quote.tenant_id = ${input.tenantId}
                and quote.created_at >= ${input.from}::date
                and quote.created_at < (${input.to}::date + interval '1 day')
                and exists (
                  select 1
                  from ledger.ledger_entries entry
                  where entry.tenant_id = quote.tenant_id
                    and entry.quote_id = quote.id
                    and entry.kind = 'capture'
                    and not exists (
                      select 1
                      from ledger.ledger_entries reversal
                      where reversal.tenant_id = entry.tenant_id
                        and reversal.checkout_id = entry.checkout_id
                        and reversal.kind in ('refund', 'void', 'capture_reversal')
                    )
                    and entry.created_at >= ${input.from}::date
                    and entry.created_at < (${input.to}::date + interval '1 day')
                )
            ) as captured_orders,
            (
              select count(*)::int
              from commerce.quotes quote
              where quote.tenant_id = ${input.tenantId}
                and quote.created_at >= ${input.from}::date
                and quote.created_at < (${input.to}::date + interval '1 day')
            ) as valid_quotes,
            (
              select count(*)::int
              from payments.checkout_sessions checkout_session
              where checkout_session.tenant_id = ${input.tenantId}
                and checkout_session.status in ('FAILED_PROVISIONAL', 'RECONCILING')
                and coalesce(checkout_session.provider_status, '') is distinct from 'refunded'
                and not exists (
                  select 1
                  from payments.reconciliation_snapshots snapshot
                  where snapshot.tenant_id = checkout_session.tenant_id
                    and snapshot.checkout_id = checkout_session.id
                    and snapshot.outcome = 'refunded'
                )
                and checkout_session.updated_at >= ${input.from}::date
                and checkout_session.updated_at < (${input.to}::date + interval '1 day')
            ) as failed_unresolved,
            coalesce((
              select coalesce(sum(quote.total_minor), 0)::text
              from commerce.quotes quote
              where quote.tenant_id = ${input.tenantId}
                and quote.created_at >= ${input.from}::date
                and quote.created_at < (${input.to}::date + interval '1 day')
                and exists (
                  select 1
                  from ledger.ledger_entries entry
                  where entry.tenant_id = quote.tenant_id
                    and entry.quote_id = quote.id
                    and entry.kind = 'capture'
                    and not exists (
                      select 1
                      from ledger.ledger_entries reversal
                      where reversal.tenant_id = entry.tenant_id
                        and reversal.checkout_id = entry.checkout_id
                        and reversal.kind in ('refund', 'void', 'capture_reversal')
                    )
                    and entry.created_at >= ${input.from}::date
                    and entry.created_at < (${input.to}::date + interval '1 day')
                    and exists (
                      select 1
                      from recovery.attempts attempt
                      where attempt.tenant_id = entry.tenant_id
                        and attempt.checkout_id = entry.checkout_id
                        and attempt.status in ('sent', 'delivered')
                        and attempt.attempted_at <= entry.created_at
                    )
                )
            ), '0') as recovered_minor,
            (
              select coalesce(sum(inventory.on_hand), 0)::int
              from catalog.inventory inventory
              join catalog.variants variant
                on variant.tenant_id = inventory.tenant_id
               and variant.id = inventory.variant_id
              join catalog.products product
                on product.tenant_id = variant.tenant_id
               and product.id = variant.product_id
              where inventory.tenant_id = ${input.tenantId}
                and variant.status <> 'archived'
                and product.status <> 'archived'
            ) as inventory_units,
            (
              select count(*)::int
              from catalog.inventory inventory
              join catalog.variants variant
                on variant.tenant_id = inventory.tenant_id
               and variant.id = inventory.variant_id
              join catalog.products product
                on product.tenant_id = variant.tenant_id
               and product.id = variant.product_id
              where inventory.tenant_id = ${input.tenantId}
                and inventory.available <= 5
                and variant.status <> 'archived'
                and product.status <> 'archived'
            ) as low_stock_variants,
            shop.synthetic
          from catalog.shops shop
          where shop.tenant_id = ${input.tenantId}
          limit 1
        `.execute(trx);
          const row = result.rows[0];
          if (!row) {
            throw new Error('TENANT_UNKNOWN');
          }
          const discovery = await sql<{ searches: number }>`
            select count(*)::int as searches
            from catalog.search_events
            where tenant_id = ${input.tenantId}
              and created_at >= ${input.from}::date
              and created_at < (${input.to}::date + interval '1 day')
          `.execute(trx);
          const skuRows = await sql<{ sku: string; title: string; count: number }>`
            select impression.sku,
                   coalesce(max(variant.title), impression.sku) as title,
                   count(*)::int as count
            from catalog.recommendation_impressions impression
            left join catalog.variants variant
              on variant.tenant_id = impression.tenant_id
             and variant.sku = impression.sku
            where impression.tenant_id = ${input.tenantId}
              and impression.sku is not null
              and impression.created_at >= ${input.from}::date
              and impression.created_at < (${input.to}::date + interval '1 day')
            group by impression.sku
            order by count desc, impression.sku
            limit 8
          `.execute(trx);
          const sourceRows = await sql<{ source: string; count: number }>`
            select agent_source as source, count(*)::int as count
            from catalog.recommendation_impressions
            where tenant_id = ${input.tenantId}
              and created_at >= ${input.from}::date
              and created_at < (${input.to}::date + interval '1 day')
            group by agent_source
            order by count desc, agent_source
          `.execute(trx);
          const capturedOrders = Number(row.captured_orders);
          const validQuotes = Number(row.valid_quotes);
          return {
            range: { from: input.from, to: input.to },
            capturedGmvMinor: row.captured_gmv_minor,
            capturedGmvDisplay: formatMinor(BigInt(row.captured_gmv_minor)),
            capturedOrders,
            validFrozenQuotes: validQuotes,
            conversion: {
              numerator: capturedOrders,
              denominator: validQuotes,
              rate: validQuotes === 0 ? null : capturedOrders / validQuotes,
            },
            failedUnresolvedPays: Number(row.failed_unresolved),
            recoveredAmountMinor: row.recovered_minor,
            recoveredAmountDisplay: formatMinor(BigInt(row.recovered_minor)),
            inventoryUnits: Number(row.inventory_units),
            lowStockVariants: Number(row.low_stock_variants),
            synthetic: row.synthetic,
            attributionNote:
              'Cohort is quotes created in this window. Captured GMV and conversion count only captures in the same window whose quote is in that cohort. Recovered amount is observed capture after a recorded recovery attempt; no incremental lift is claimed without a control.',
            searches: Number(discovery.rows[0]?.searches ?? 0),
            recommendationsBySku: skuRows.rows.map((item) => ({
              sku: item.sku,
              title: item.title,
              count: Number(item.count),
            })),
            recommendationsBySource: sourceRows.rows.map((item) => ({
              source: item.source,
              count: Number(item.count),
            })),
          };
        },
      );
    },
    async listMerchantCatalog(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId);
          return readMerchantCatalog(trx, input);
        },
      );
    },
    async createMerchantProduct(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, ['owner', 'admin', 'catalog']);
          return runMerchantCommand(
            trx,
            {
              userId: input.userId,
              tenantId: input.tenantId,
              operation: `catalog:create:${input.tenantId}`,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
            },
            async () => {
              const title = input.title.trim();
              const description = input.description.trim();
              const categoryTitle = input.category.trim();
              const sku = input.sku.trim();
              const priceMinor = BigInt(input.priceMinor);
              if (
                priceMinor < 0n ||
                !Number.isSafeInteger(input.stock) ||
                input.stock < 0 ||
                (input.status === 'published' &&
                  (title.length < 2 ||
                    !description ||
                    !categoryTitle ||
                    !sku ||
                    priceMinor <= 0n ||
                    input.stock <= 0))
              ) {
                throw new Error('CATALOG_PUBLISH_INVALID');
              }
              let categoryId: string | null = null;
              if (categoryTitle) {
                const categorySlug = slugify(categoryTitle);
                const existingCategory = await sql<{ id: string }>`
                select id
                from catalog.categories
                where tenant_id = ${input.tenantId}
                  and slug = ${categorySlug}
                limit 1
              `.execute(trx);
                categoryId = existingCategory.rows[0]?.id ?? randomUUID();
                if (!existingCategory.rows[0]) {
                  await sql`
                  insert into catalog.categories (
                    id, tenant_id, slug, title, status, position
                  )
                  values (
                    ${categoryId}::uuid,
                    ${input.tenantId},
                    ${categorySlug},
                    ${categoryTitle},
                    'active',
                    0
                  )
                `.execute(trx);
                }
              }
              const productId = randomUUID();
              const variantId = randomUUID();
              const productSlug = `${slugify(title).slice(0, 38)}-${randomUUID().slice(0, 8)}`;
              const published = input.status === 'published';
              await sql`
              insert into catalog.products (
                id, tenant_id, category_id, slug, title, description,
                status, currency, published_at
              )
              values (
                ${productId}::uuid,
                ${input.tenantId},
                ${categoryId}::uuid,
                ${productSlug},
                ${title},
                ${description},
                ${input.status},
                'INR',
                ${published ? new Date() : null}
              )
            `.execute(trx);
              await sql`
              insert into catalog.variants (
                id, tenant_id, product_id, sku, title, price_minor, currency,
                material, aliases, status, published_at
              )
              values (
                ${variantId}::uuid,
                ${input.tenantId},
                ${productId}::uuid,
                ${sku},
                ${title},
                ${priceMinor.toString()},
                'INR',
                ${input.material},
                array[${title.toLowerCase()}],
                ${input.status},
                ${published ? new Date() : null}
              )
            `.execute(trx);
              await sql`
              insert into catalog.inventory (tenant_id, variant_id, on_hand, reserved)
              values (${input.tenantId}, ${variantId}::uuid, ${input.stock}, 0)
            `.execute(trx);
              const created = await readMerchantCatalog(trx, {
                tenantId: input.tenantId,
                limit: 1,
                after: null,
                productId,
              });
              const item = created.items[0];
              if (!item) {
                throw new Error('CATALOG_PRODUCT_NOT_FOUND');
              }
              await sql`
              insert into catalog.product_audits (
                id, tenant_id, product_id, actor_id, version_before, version_after,
                reason, before_record, after_record
              )
              values (
                ${randomUUID()}::uuid,
                ${input.tenantId},
                ${productId}::uuid,
                ${input.userId.toLowerCase()}::uuid,
                0,
                ${item.productVersion},
                ${input.status === 'published' ? 'Direct published product creation' : 'Initial draft product creation'},
                '{}'::jsonb,
                ${JSON.stringify(item)}::jsonb
              )
            `.execute(trx);
              return item;
            },
          );
        },
      );
    },
    async updateMerchantProduct(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, ['owner', 'admin', 'catalog']);
          return runMerchantCommand(
            trx,
            {
              userId: input.userId,
              tenantId: input.tenantId,
              operation: `catalog:update:${input.tenantId}:${input.productId}`,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
            },
            async () => {
              const beforePage = await readMerchantCatalog(trx, {
                tenantId: input.tenantId,
                limit: 1,
                after: null,
                productId: input.productId,
              });
              const before = beforePage.items[0];
              if (!before) {
                throw new Error('CATALOG_PRODUCT_NOT_FOUND');
              }
              if (before.productVersion !== input.expectedVersion) {
                throw new Error('CATALOG_VERSION_CONFLICT');
              }
              const title = input.title.trim();
              const description = input.description.trim();
              const categoryTitle = input.category.trim();
              const sku = input.sku.trim();
              const priceMinor = BigInt(input.priceMinor);
              if (
                input.status === 'published' &&
                (title.length < 2 ||
                  !description ||
                  !categoryTitle ||
                  !sku ||
                  priceMinor <= 0n ||
                  before.inventory.available <= 0)
              ) {
                throw new Error('CATALOG_PUBLISH_INVALID');
              }
              let categoryId: string | null = null;
              if (categoryTitle) {
                const categorySlug = slugify(categoryTitle);
                const existingCategory = await sql<{ id: string }>`
                select id
                from catalog.categories
                where tenant_id = ${input.tenantId}
                  and slug = ${categorySlug}
                limit 1
              `.execute(trx);
                categoryId = existingCategory.rows[0]?.id ?? randomUUID();
                if (!existingCategory.rows[0]) {
                  await sql`
                  insert into catalog.categories (id, tenant_id, slug, title, status, position)
                  values (
                    ${categoryId}::uuid,
                    ${input.tenantId},
                    ${categorySlug},
                    ${categoryTitle},
                    'active',
                    0
                  )
                `.execute(trx);
                }
              }
              const publishedAt = input.status === 'published' ? new Date() : null;
              const updated = await sql<{ id: string }>`
              update catalog.products
              set category_id = ${categoryId}::uuid,
                  title = ${title},
                  description = ${description},
                  status = ${input.status},
                  published_at = case
                    when ${input.status} = 'published'
                      then coalesce(published_at, ${publishedAt})
                    else null
                  end,
                  version = version + 1
              where tenant_id = ${input.tenantId}
                and id = ${input.productId}::uuid
                and version = ${input.expectedVersion}
              returning id
            `.execute(trx);
              if (!updated.rows[0]) {
                throw new Error('CATALOG_VERSION_CONFLICT');
              }
              await sql`
              update catalog.variants
              set sku = ${sku},
                  title = ${title},
                  price_minor = ${priceMinor.toString()},
                  material = ${input.material},
                  status = ${input.status},
                  published_at = case
                    when ${input.status} = 'published'
                      then coalesce(published_at, ${publishedAt})
                    else null
                  end,
                  version = version + 1
              where tenant_id = ${input.tenantId}
                and id = ${before.variantId}::uuid
            `.execute(trx);
              const afterPage = await readMerchantCatalog(trx, {
                tenantId: input.tenantId,
                limit: 1,
                after: null,
                productId: input.productId,
              });
              const after = afterPage.items[0];
              if (!after) {
                throw new Error('CATALOG_PRODUCT_NOT_FOUND');
              }
              await sql`
              insert into catalog.product_audits (
                id, tenant_id, product_id, actor_id, version_before, version_after,
                reason, before_record, after_record
              )
              values (
                ${randomUUID()}::uuid,
                ${input.tenantId},
                ${input.productId}::uuid,
                ${input.userId.toLowerCase()}::uuid,
                ${before.productVersion},
                ${after.productVersion},
                ${input.reason.trim()},
                ${JSON.stringify(before)}::jsonb,
                ${JSON.stringify(after)}::jsonb
              )
            `.execute(trx);
              return after;
            },
          );
        },
      );
    },
    async adjustMerchantStock(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, ['owner', 'admin', 'catalog']);
          return runMerchantCommand(
            trx,
            {
              userId: input.userId,
              tenantId: input.tenantId,
              operation: `inventory:adjust:${input.tenantId}:${input.variantId}`,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
            },
            async () => {
              if (
                !Number.isSafeInteger(input.delta) ||
                input.delta === 0 ||
                input.reason.trim().length < 3
              ) {
                throw new Error('INVENTORY_ADJUSTMENT_INVALID');
              }
              const locked = await sql<{
                on_hand: number;
                reserved: number;
                version: number;
              }>`
              select inventory.on_hand, inventory.reserved, inventory.version
              from catalog.inventory inventory
              join catalog.variants variant
                on variant.tenant_id = inventory.tenant_id
               and variant.id = inventory.variant_id
              where inventory.tenant_id = ${input.tenantId}
                and inventory.variant_id = ${input.variantId}::uuid
              for update of inventory
            `.execute(trx);
              const current = locked.rows[0];
              if (!current) {
                throw new Error('CATALOG_VARIANT_NOT_FOUND');
              }
              if (current.version !== input.expectedVersion) {
                throw new Error('INVENTORY_VERSION_CONFLICT');
              }
              const next = current.on_hand + input.delta;
              if (next < current.reserved || next < 0) {
                throw new Error('INVENTORY_INSUFFICIENT');
              }
              const versionAfter = current.version + 1;
              await sql`
              update catalog.inventory
              set on_hand = ${next},
                  version = ${versionAfter},
                  updated_at = now()
              where tenant_id = ${input.tenantId}
                and variant_id = ${input.variantId}::uuid
                and version = ${input.expectedVersion}
            `.execute(trx);
              await sql`
              insert into catalog.inventory_adjustments (
                id, tenant_id, variant_id, actor_id, delta, before_on_hand,
                after_on_hand, version_before, version_after, reason
              )
              values (
                ${randomUUID()}::uuid,
                ${input.tenantId},
                ${input.variantId}::uuid,
                ${input.userId.toLowerCase()}::uuid,
                ${input.delta},
                ${current.on_hand},
                ${next},
                ${current.version},
                ${versionAfter},
                ${input.reason.trim()}
              )
            `.execute(trx);
              return {
                onHand: next,
                reserved: current.reserved,
                available: next - current.reserved,
                version: versionAfter,
              };
            },
          );
        },
      );
    },
    async listMerchantOrders(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, [
            'owner',
            'admin',
            'catalog',
            'support',
            'finance',
            'viewer',
          ]);
          const afterSort = input.after?.sortValue ?? null;
          const afterId = input.after?.id ?? null;
          const search = `%${input.query}%`;
          const result = await sql<MerchantOrderDbRow>`
          select checkout_session.id,
                 checkout_session.quote_id,
                 checkout_session.receipt,
                 checkout_session.razorpay_order_id,
                 checkout_session.amount_minor::text,
                 checkout_session.status as checkout_status,
                 checkout_session.payment_id,
                 checkout_session.provider_status,
                 checkout_session.copy,
                 checkout_session.created_at,
                 checkout_session.updated_at,
                 capture.created_at as captured_at
          from payments.checkout_sessions checkout_session
          left join lateral (
            select entry.created_at
            from ledger.ledger_entries entry
            where entry.tenant_id = checkout_session.tenant_id
              and entry.checkout_id = checkout_session.id
              and entry.kind = 'capture'
              and checkout_session.provider_status = 'captured'
              and not exists (
                select 1
                from ledger.ledger_entries reversal
                where reversal.tenant_id = entry.tenant_id
                  and reversal.checkout_id = entry.checkout_id
                  and reversal.kind in ('refund', 'void', 'capture_reversal')
              )
            order by entry.created_at desc
            limit 1
          ) capture on true
          where checkout_session.tenant_id = ${input.tenantId}
            and (
              ${input.query} = ''
              or checkout_session.receipt ilike ${search}
              or checkout_session.razorpay_order_id ilike ${search}
              or checkout_session.payment_id ilike ${search}
            )
            and (${input.status} = '' or checkout_session.status = ${input.status})
            and (
              ${input.from}::date is null
              or checkout_session.created_at >= ${input.from}::date
            )
            and (
              ${input.to}::date is null
              or checkout_session.created_at < (${input.to}::date + interval '1 day')
            )
            and (
              ${afterSort}::timestamptz is null
              or checkout_session.updated_at < ${afterSort}::timestamptz
              or (
                checkout_session.updated_at = ${afterSort}::timestamptz
                and checkout_session.id < ${afterId}::uuid
              )
            )
          order by checkout_session.updated_at desc, checkout_session.id desc
          limit ${input.limit + 1}
        `.execute(trx);
          const items: MerchantOrderSummary[] = [];
          for (const row of result.rows.slice(0, input.limit)) {
            const summary = merchantOrderSummary(row);
            if (!summary.fulfillmentReady) {
              items.push(summary);
              continue;
            }
            const sandbox = await ensureSandboxFulfillment(trx, input.tenantId, summary.id, true);
            items.push(withSandboxSummary(summary, sandbox));
          }
          const last = items[items.length - 1];
          return {
            items,
            cursor:
              result.rows.length > input.limit && last
                ? { sortValue: last.updatedAt, id: last.id }
                : null,
          };
        },
      );
    },
    async getMerchantOrder(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, [
            'owner',
            'admin',
            'catalog',
            'support',
            'finance',
            'viewer',
          ]);
          const orderResult = await sql<MerchantOrderDbRow>`
          select checkout_session.id,
                 checkout_session.quote_id,
                 checkout_session.receipt,
                 checkout_session.razorpay_order_id,
                 checkout_session.amount_minor::text,
                 checkout_session.status as checkout_status,
                 checkout_session.payment_id,
                 checkout_session.provider_status,
                 checkout_session.copy,
                 checkout_session.created_at,
                 checkout_session.updated_at,
                 capture.created_at as captured_at
          from payments.checkout_sessions checkout_session
          left join lateral (
            select entry.created_at
            from ledger.ledger_entries entry
            where entry.tenant_id = checkout_session.tenant_id
              and entry.checkout_id = checkout_session.id
              and entry.kind = 'capture'
              and checkout_session.provider_status = 'captured'
              and not exists (
                select 1
                from ledger.ledger_entries reversal
                where reversal.tenant_id = entry.tenant_id
                  and reversal.checkout_id = entry.checkout_id
                  and reversal.kind in ('refund', 'void', 'capture_reversal')
              )
            order by entry.created_at desc
            limit 1
          ) capture on true
          where checkout_session.tenant_id = ${input.tenantId}
            and checkout_session.id = ${input.orderId}::uuid
          limit 1
        `.execute(trx);
          const row = orderResult.rows[0];
          if (!row) {
            return undefined;
          }
          const quoteResult = await sql<{
            id: string;
            status: string;
            subtotal_minor: string;
            discount_minor: string;
            total_minor: string;
            delivery_by: string;
            created_at: Date;
          }>`
          select quote.id,
                 quote.status,
                 quote.subtotal_minor::text,
                 quote.discount_minor::text,
                 quote.total_minor::text,
                 to_char(quote.delivery_by, 'YYYY-MM-DD') as delivery_by,
                 quote.created_at
          from commerce.quotes quote
          where quote.tenant_id = ${input.tenantId}
            and quote.id = ${row.quote_id}::uuid
          limit 1
        `.execute(trx);
          const quote = quoteResult.rows[0];
          if (!quote) {
            return undefined;
          }
          const lineResult = await sql<{
            sku: string;
            title: string;
            quantity: number;
            unit_minor: string;
            line_minor: string;
          }>`
          select line.sku,
                 line.title,
                 line.quantity,
                 line.unit_minor::text,
                 line.line_minor::text
          from commerce.quote_lines line
          where line.tenant_id = ${input.tenantId}
            and line.quote_id = ${row.quote_id}::uuid
          order by line.sku
        `.execute(trx);
          const attemptResult = await sql<{
            id: string;
            status: string;
            attempted_at: Date;
            completed_at: Date | null;
            failure_code: string | null;
          }>`
          select attempt.id,
                 attempt.status,
                 attempt.attempted_at,
                 attempt.completed_at,
                 attempt.failure_code
          from recovery.attempts attempt
          where attempt.tenant_id = ${input.tenantId}
            and attempt.checkout_id = ${row.id}::uuid
          order by attempt.attempt_number, attempt.id
        `.execute(trx);
          const summary = merchantOrderSummary(row);
          const timeline: MerchantOrderDetail['timeline'] = [
            {
              id: `quote:${quote.id}`,
              at: quote.created_at.toISOString(),
              status: 'quote_frozen',
              label: 'Quote frozen',
              detail: 'Line prices and totals were frozen for this checkout.',
            },
            {
              id: `provider-order:${row.id}`,
              at: row.created_at.toISOString(),
              status: 'provider_order_created',
              label: 'Razorpay Order created',
              detail: `Receipt ${row.receipt}. Payment is not fulfilled at this stage.`,
            },
          ];
          const transitionResult = await sql<{
            id: string;
            observed_provider_status: string;
            to_checkout_status: string;
            occurred_at: Date;
            observed_at: Date;
            source: string;
            provider_reference: string;
          }>`
            select id,
                   observed_provider_status,
                   to_checkout_status,
                   occurred_at,
                   observed_at,
                   source,
                   provider_reference
            from payments.payment_transitions
            where tenant_id = ${input.tenantId}
              and checkout_id = ${row.id}::uuid
            order by occurred_at, observed_at, id
          `.execute(trx);
          for (const transition of transitionResult.rows) {
            timeline.push(timelineFromProviderTransition(transition));
          }
          if (transitionResult.rows.length === 0) {
            if (row.captured_at) {
              timeline.push({
                id: `capture:${row.id}`,
                at: row.captured_at.toISOString(),
                status: 'captured',
                label: 'Payment captured',
                detail: 'Captured ledger evidence. Eligible for fulfillment.',
              });
            } else if (row.checkout_status === 'FAILED_PROVISIONAL') {
              timeline.push({
                id: `failure:${row.id}`,
                at: row.updated_at.toISOString(),
                status: 'failed_provisional',
                label: 'Payment not confirmed',
                detail: 'Provisional provider failure. Reconciliation remains authoritative.',
              });
            } else if (row.checkout_status === 'CAPTURE_PENDING') {
              timeline.push({
                id: `authorization:${row.id}`,
                at: row.updated_at.toISOString(),
                status: 'authorized',
                label: 'Awaiting capture',
                detail: 'Waiting for automatic capture. Not fulfilled.',
              });
            } else if (row.checkout_status === 'RECONCILING') {
              timeline.push({
                id: `reconciling:${row.id}`,
                at: row.updated_at.toISOString(),
                status: 'reconciling',
                label: 'Reconciling',
                detail: 'Payment not confirmed. Provider state is being fetched.',
              });
            } else {
              timeline.push({
                id: `status:${row.id}`,
                at: row.updated_at.toISOString(),
                status: row.checkout_status.toLowerCase(),
                label: 'Provider status updated',
                detail: row.copy,
              });
            }
          }
          for (const attempt of attemptResult.rows) {
            timeline.push({
              id: `recovery:${attempt.id}`,
              at: (attempt.completed_at ?? attempt.attempted_at).toISOString(),
              status: `recovery_${attempt.status}`,
              label: `Recovery ${attempt.status}`,
              detail:
                attempt.status === 'sent'
                  ? 'A consented recovery email was sent.'
                  : `Recovery stopped with ${attempt.failure_code ?? attempt.status}.`,
            });
          }
          timeline.sort(
            (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
          );
          const sandbox = await ensureSandboxFulfillment(
            trx,
            input.tenantId,
            row.id,
            summary.fulfillmentReady,
          );
          timeline.push(...sandbox.events);
          timeline.sort(
            (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
          );
          return {
            ...withSandboxSummary(summary, sandbox),
            quote: {
              id: quote.id,
              status: quote.status,
              subtotalMinor: quote.subtotal_minor,
              discountMinor: quote.discount_minor,
              totalMinor: quote.total_minor,
              ...(quote.delivery_by ? { deliveryBy: quote.delivery_by } : {}),
              lines: lineResult.rows.map((line) => ({
                sku: line.sku,
                title: line.title,
                quantity: line.quantity,
                unitMinor: line.unit_minor,
                lineMinor: line.line_minor,
              })),
            },
            provider: {
              razorpayOrderId: row.razorpay_order_id,
              paymentId: row.payment_id,
              status: row.provider_status,
            },
            ...(sandbox.shippingAddress ? { shippingAddress: sandbox.shippingAddress } : {}),
            ...(sandbox.fulfillmentStatus
              ? { nextFulfillmentStatus: sandbox.nextFulfillmentStatus ?? null }
              : {}),
            timeline,
          };
        },
      );
    },
    async advanceMerchantFulfillment(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, [
            'owner',
            'admin',
            'catalog',
            'support',
          ]);
          const current = await loadBuyerOrderDetail(trx, input.tenantId, input.orderId);
          if (!current) {
            throw new Error('ORDER_NOT_FOUND');
          }
          if (!current.fulfillmentReady) {
            throw new Error('FULFILLMENT_NOT_READY');
          }
          const sandbox = await ensureSandboxFulfillment(trx, input.tenantId, input.orderId, true);
          if (sandbox.fulfillmentStatus === input.status) {
            return current;
          }
          if (sandbox.nextFulfillmentStatus !== input.status) {
            throw new Error('FULFILLMENT_STATUS_INVALID');
          }
          await sql`
            update commerce.fulfillment_shipments
               set status = ${input.status}
             where tenant_id = ${input.tenantId}
               and checkout_id = ${input.orderId}::uuid
          `.execute(trx);
          await sql`
            insert into commerce.fulfillment_events (
              tenant_id, checkout_id, status, note
            ) values (
              ${input.tenantId},
              ${input.orderId}::uuid,
              ${input.status},
              ${fulfillmentStatusDetail(input.status)}
            )
            on conflict (tenant_id, checkout_id, status) do nothing
          `.execute(trx);
          const updated = await loadBuyerOrderDetail(trx, input.tenantId, input.orderId);
          if (!updated) {
            throw new Error('ORDER_NOT_FOUND');
          }
          return updated;
        },
      );
    },
    async listMerchantRecovery(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, ['owner', 'admin', 'support']);
          return readMerchantRecovery(trx, input);
        },
      );
    },
    async getMerchantRecovery(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, ['owner', 'admin', 'support']);
          const page = await readMerchantRecovery(trx, {
            tenantId: input.tenantId,
            status: '',
            limit: 1,
            after: null,
            checkoutId: input.checkoutId,
          });
          return page.items[0];
        },
      );
    },
    async getMerchantRules(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId);
          return readMerchantRules(trx, input.tenantId);
        },
      );
    },
    async previewMerchantRules(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId);
          const rules = await readMerchantRules(trx, input.tenantId);
          if (!rules) {
            throw new Error('SHOP_POLICY_NOT_FOUND');
          }
          const catalog = await readMerchantCatalog(trx, {
            tenantId: input.tenantId,
            limit: 10_000,
            after: null,
          });
          return {
            version: rules.version,
            items: catalog.items
              .filter((item) => item.status !== 'archived')
              .map((item) => {
                if (rules.forbiddenMaterials.includes(item.material)) {
                  return {
                    sku: item.sku,
                    outcome: 'deny' as const,
                    reason: 'PRODUCT_MATERIAL_FORBIDDEN' as const,
                  };
                }
                if (BigInt(item.priceMinor) > BigInt(rules.hardCapMinor)) {
                  return {
                    sku: item.sku,
                    outcome: 'deny' as const,
                    reason: 'HARD_CAP_EXCEEDED' as const,
                  };
                }
                return {
                  sku: item.sku,
                  outcome: 'allow' as const,
                  reason: 'WITHIN_POLICY' as const,
                };
              }),
          };
        },
      );
    },
    async updateMerchantRules(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          await requireMembership(trx, input.userId, input.tenantId, ['owner', 'admin']);
          return runMerchantCommand(
            trx,
            {
              userId: input.userId,
              tenantId: input.tenantId,
              operation: `rules:update:${input.tenantId}`,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
            },
            async () => {
              const before = await readMerchantRules(trx, input.tenantId);
              if (!before) {
                throw new Error('SHOP_POLICY_NOT_FOUND');
              }
              if (before.version !== input.expectedVersion) {
                throw new Error('RULES_VERSION_CONFLICT');
              }
              const hardCapMinor = BigInt(input.hardCapMinor);
              const autonomousCapMinor = BigInt(input.autonomousCapMinor);
              if (
                hardCapMinor <= 0n ||
                autonomousCapMinor < 0n ||
                autonomousCapMinor > hardCapMinor ||
                input.reason.trim().length < 3 ||
                input.offers.some(
                  (offer) =>
                    !offer.id ||
                    BigInt(offer.discountMinor) <= 0n ||
                    BigInt(offer.discountMinor) > hardCapMinor ||
                    offer.requiredSkuGroups.length === 0 ||
                    offer.requiredSkuGroups.some((group) => group.length === 0),
                )
              ) {
                throw new Error('RULES_INVALID');
              }
              const forbiddenMaterials = [
                ...new Set(input.forbiddenMaterials.map((entry) => entry.trim().toLowerCase())),
              ].filter(Boolean);
              const rulesJson = offerRulesJson(input.offers);
              const updated = await sql<{ version: number }>`
              update policy.shop_policies
              set hard_cap_minor = ${hardCapMinor.toString()},
                  autonomous_cap_minor = ${autonomousCapMinor.toString()},
                  forbidden_materials = ${forbiddenMaterials},
                  rules = ${JSON.stringify(rulesJson)}::jsonb,
                  version = version + 1,
                  updated_by = ${input.userId.toLowerCase()}::uuid,
                  updated_at = now()
              where tenant_id = ${input.tenantId}
                and version = ${input.expectedVersion}
              returning version
            `.execute(trx);
              if (!updated.rows[0]) {
                throw new Error('RULES_VERSION_CONFLICT');
              }
              const after = await readMerchantRules(trx, input.tenantId);
              if (!after) {
                throw new Error('SHOP_POLICY_NOT_FOUND');
              }
              await sql`
              insert into policy.shop_policy_audits (
                id, tenant_id, actor_id, version_before, version_after,
                reason, before_record, after_record
              )
              values (
                ${randomUUID()}::uuid,
                ${input.tenantId},
                ${input.userId.toLowerCase()}::uuid,
                ${before.version},
                ${after.version},
                ${input.reason.trim()},
                ${JSON.stringify(before)}::jsonb,
                ${JSON.stringify(after)}::jsonb
              )
            `.execute(trx);
              return after;
            },
          );
        },
      );
    },
    async getMerchantSettings(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          const role = await requireMembership(trx, input.userId, input.tenantId);
          return readMerchantSettings(trx, input.tenantId, input.testMode, role);
        },
      );
    },
    async updateMerchantSettings(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          const role = await requireMembership(trx, input.userId, input.tenantId, [
            'owner',
            'admin',
          ]);
          return runMerchantCommand(
            trx,
            {
              userId: input.userId,
              tenantId: input.tenantId,
              operation: `settings:update:${input.tenantId}`,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
            },
            async () => {
              const before = await readMerchantSettings(trx, input.tenantId, input.testMode, role);
              if (!before) {
                throw new Error('TENANT_UNKNOWN');
              }
              if (before.version !== input.expectedVersion) {
                throw new Error('SETTINGS_VERSION_CONFLICT');
              }
              const name = input.name.trim();
              const blurb = input.blurb.trim();
              if (name.length < 2 || input.reason.trim().length < 3) {
                throw new Error('SETTINGS_INVALID');
              }
              const profile = normalizeShopProfile({
                ...(input.gstin === undefined ? {} : { gstin: input.gstin }),
                ...(input.addressLine === undefined ? {} : { addressLine: input.addressLine }),
                ...(input.refundPolicy === undefined ? {} : { refundPolicy: input.refundPolicy }),
                previous: {
                  gstin: before.gstin,
                  addressLine: before.addressLine,
                  refundPolicy: before.refundPolicy,
                },
              });
              const label = merchantDisplayName({ name, synthetic: before.synthetic });
              const updated = await sql<{ version: number }>`
              update catalog.shops
              set name = ${name},
                  label = ${label},
                  blurb = ${blurb},
                  gstin = ${profile.gstin},
                  address_line = ${profile.addressLine},
                  refund_policy = ${profile.refundPolicy},
                  version = version + 1,
                  updated_at = now()
              where tenant_id = ${input.tenantId}
                and version = ${input.expectedVersion}
              returning version
            `.execute(trx);
              if (!updated.rows[0]) {
                throw new Error('SETTINGS_VERSION_CONFLICT');
              }
              const after = await readMerchantSettings(trx, input.tenantId, input.testMode, role);
              if (!after) {
                throw new Error('TENANT_UNKNOWN');
              }
              await sql`
              insert into catalog.shop_audits (
                id, tenant_id, actor_id, version_before, version_after,
                reason, before_record, after_record
              )
              values (
                ${randomUUID()}::uuid,
                ${input.tenantId},
                ${input.userId.toLowerCase()}::uuid,
                ${before.version},
                ${after.version},
                ${input.reason.trim()},
                ${JSON.stringify(before)}::jsonb,
                ${JSON.stringify(after)}::jsonb
              )
            `.execute(trx);
              return after;
            },
          );
        },
      );
    },
    syncIdentity,
    async membershipRole(userId, tenantId) {
      return withAuthContext(db, { userId, tenantId }, async (trx) => {
        return activeMembershipRole(trx, userId, tenantId);
      });
    },
    async listMemberShops(userId) {
      return withUserContext(db, { userId }, async (trx) => {
        const result = await sql<{
          tenant_id: string;
          slug: string;
          name: string;
          label: string;
          blurb: string;
          status: ShopRecord['status'];
          synthetic: boolean;
          role: ShopRole;
        }>`
          select shop.tenant_id,
                 shop.slug,
                 shop.name,
                 shop.label,
                 shop.blurb,
                 shop.status,
                 shop.synthetic,
                 membership.role
          from identity.shop_memberships membership
          join identity.users application_user
            on application_user.id = membership.user_id
           and application_user.status = 'active'
          join identity.tenants tenant
            on tenant.id = membership.tenant_id
           and tenant.status = 'active'
          join catalog.shops shop
            on shop.tenant_id = membership.tenant_id
           and shop.status <> 'archived'
          where membership.user_id = ${userId.toLowerCase()}::uuid
            and membership.status = 'active'
          order by shop.slug
        `.execute(trx);
        return result.rows.map((row) => ({ ...shopRecord(row), role: row.role }));
      });
    },
    async platformRoles(userId) {
      return withUserContext(db, { userId }, async (trx) => {
        const result = await sql<{ role: PlatformRole }>`
          select platform_role.role
          from identity.platform_roles platform_role
          join identity.users application_user
            on application_user.id = platform_role.user_id
           and application_user.status = 'active'
          where platform_role.user_id = ${userId.toLowerCase()}::uuid
          order by platform_role.role
        `.execute(trx);
        return result.rows.map((row) => row.role);
      });
    },
    async listPublicShops() {
      return withPublicCatalogContext(db, async (trx) => {
        const sources = await readPublicCatalogSources(trx);
        return searchPublicShopSources(sources, unpagedQuery()).items;
      });
    },
    async searchPublicShops(query) {
      return withPublicCatalogContext(db, (trx) => queryPublicDirectory(trx, query));
    },
    async searchPublicCatalog(slug, query) {
      return withPublicCatalogContext(db, (trx) => queryPublicCatalog(trx, slug, query));
    },
    findShopBySlug(slug) {
      return withPublicCatalogContext(db, (trx) => readShop(trx, 'slug', slug, true));
    },
    findShopByTenantId(tenantId) {
      return withPublicCatalogContext(db, (trx) => readShop(trx, 'tenant_id', tenantId, true));
    },
    findShopByTenantIdForMember(userId, tenantId) {
      return withAuthContext(db, { userId, tenantId }, async (trx) => {
        await requireMembership(trx, userId, tenantId);
        return readShop(trx, 'tenant_id', tenantId, false);
      });
    },
    async provisionShop(identity, input, command) {
      const name = input.name.trim();
      if (name.length < 2) {
        throw new Error('SHOP_NAME_REQUIRED');
      }
      await syncIdentity(identity);
      const baseSlug = slugify(name);
      const blurb = input.blurb?.trim() || 'A shop on Charter.';
      if (command) {
        return withUserContext(db, { userId: identity.userId }, async (trx) =>
          runMerchantCommand(
            trx,
            {
              userId: identity.userId,
              tenantId: null,
              operation: 'shops:create',
              idempotencyKey: command.idempotencyKey,
              requestHash: command.requestHash,
            },
            async () => {
              const slug = `${baseSlug.slice(0, 39)}-${randomUUID().slice(0, 8)}`;
              const tenantId = `${slug}-${randomUUID().slice(0, 8)}`;
              await sql`
                select app_private.provision_shop(
                  ${tenantId},
                  ${slug},
                  ${name},
                  ${blurb}
                )
              `.execute(trx);
              return {
                tenantId,
                slug,
                name,
                label: name,
                blurb,
                currency: 'INR' as const,
                status: 'draft' as const,
                synthetic: false,
              };
            },
          ),
        );
      }
      let slug = baseSlug;
      let tenantId = `${slug}-${randomUUID().slice(0, 8)}`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await withUserContext(db, { userId: identity.userId }, async (trx) => {
            await sql`
              select app_private.provision_shop(
                ${tenantId},
                ${slug},
                ${name},
                ${blurb}
              )
            `.execute(trx);
          });
          break;
        } catch (error) {
          if (attempt !== 0 || !isUniqueViolation(error)) {
            throw error;
          }
          slug = `${baseSlug.slice(0, 39)}-${randomUUID().slice(0, 8)}`;
          tenantId = `${slug}-${randomUUID().slice(0, 8)}`;
        }
      }
      return {
        tenantId,
        slug,
        name,
        label: name,
        blurb,
        currency: 'INR',
        status: 'draft',
        synthetic: false,
      };
    },
    async listCatalog(tenantId) {
      return withPublicCatalogContext(db, (trx) => readCatalog(trx, tenantId, true));
    },
    async listCatalogForMember(userId, tenantId) {
      return withAuthContext(db, { userId, tenantId }, async (trx) => {
        await requireMembership(trx, userId, tenantId);
        return readCatalog(trx, tenantId, false);
      });
    },
    async addCatalogItem(userId, tenantId, input) {
      return withAuthContext(db, { userId, tenantId }, async (trx) => {
        await requireMembership(trx, userId, tenantId, ['owner', 'admin', 'catalog']);
        const title = input.title.trim();
        if (title.length < 2) {
          throw new Error('ITEM_TITLE_REQUIRED');
        }
        if (!Number.isFinite(input.priceRupees) || input.priceRupees <= 0) {
          throw new Error('ITEM_PRICE_REQUIRED');
        }
        const priceMinor = BigInt(Math.round(input.priceRupees * 100));
        const productId = randomUUID();
        const variantId = randomUUID();
        const baseSku = `item.${slugify(title)}`;
        const existing = await sql<{ sku: string }>`
          select sku
          from catalog.variants
          where tenant_id = ${tenantId}
            and sku = ${baseSku}
          limit 1
        `.execute(trx);
        const sku = existing.rows[0] ? `${baseSku}-${randomUUID().slice(0, 8)}` : baseSku;
        const productSlug = sku.replace(/^item\./, '').replaceAll('.', '-');
        const stock = Math.max(0, Math.floor(input.stock));
        const material = input.material ?? 'other';
        await sql`
          insert into catalog.products (
            id, tenant_id, category_id, slug, title, description,
            status, currency, published_at
          )
          values (
            ${productId}::uuid, ${tenantId}, null, ${productSlug}, ${title}, '',
            'published', 'INR', now()
          )
        `.execute(trx);
        await sql`
          insert into catalog.variants (
            id, tenant_id, product_id, sku, title, price_minor, currency,
            material, aliases, status, published_at
          )
          values (
            ${variantId}::uuid,
            ${tenantId},
            ${productId}::uuid,
            ${sku},
            ${title},
            ${priceMinor.toString()},
            'INR',
            ${material},
            array[${title.toLowerCase()}],
            'published',
            now()
          )
        `.execute(trx);
        await sql`
          insert into catalog.inventory (tenant_id, variant_id, on_hand, reserved)
          values (${tenantId}, ${variantId}::uuid, ${stock}, 0)
        `.execute(trx);
        return {
          id: variantId,
          sku,
          title,
          priceMinor: priceMinor.toString(),
          priceDisplay: formatMinor(priceMinor),
          stock,
          material,
          published: true,
          aliases: [title.toLowerCase()],
        };
      });
    },
    async setCatalogStock(userId, tenantId, sku, stock) {
      return withAuthContext(db, { userId, tenantId }, async (trx) => {
        await requireMembership(trx, userId, tenantId, ['owner', 'admin', 'catalog']);
        const normalized = Math.max(0, Math.floor(stock));
        const result = await sql<{ id: string }>`
          update catalog.inventory inventory
          set on_hand = ${normalized},
              version = version + 1,
              updated_at = now()
          from catalog.variants variant
          where inventory.tenant_id = ${tenantId}
            and inventory.variant_id = variant.id
            and variant.tenant_id = ${tenantId}
            and variant.sku = ${sku}
          returning variant.id
        `.execute(trx);
        if (!result.rows[0]) {
          return undefined;
        }
        return (await readCatalog(trx, tenantId, false)).find((item) => item.sku === sku);
      });
    },
    async getPolicy(tenantId) {
      return withMachineTenant(db, tenantId, async (trx) => {
        const result = await sql<{
          hard_cap_minor: string;
          autonomous_cap_minor: string;
          forbidden_materials: string[];
          rules: unknown;
          version: number;
        }>`
          select hard_cap_minor::text,
                 autonomous_cap_minor::text,
                 forbidden_materials,
                 rules,
                 version
          from policy.shop_policies
          where tenant_id = ${tenantId}
          limit 1
        `.execute(trx);
        const row = result.rows[0];
        return row
          ? ({
              hardCapMinor: BigInt(row.hard_cap_minor),
              autonomousCapMinor: BigInt(row.autonomous_cap_minor),
              forbiddenMaterials: row.forbidden_materials,
              offers: policyOffers(row.rules),
              version: row.version,
            } satisfies ShopPolicy)
          : undefined;
      });
    },
    async claimResource(kind, tenantId, resourceId, userId) {
      if (kind !== 'cart') {
        return;
      }
      await withMachineTenant(db, tenantId, async (trx) => {
        const result = await sql<{ id: string }>`
          update commerce.carts
          set user_id = ${userId.toLowerCase()}::uuid
          where tenant_id = ${tenantId}
            and id = ${resourceId}::uuid
            and (user_id is null or user_id = ${userId.toLowerCase()}::uuid)
          returning id
        `.execute(trx);
        if (!result.rows[0]) {
          throw new Error('RESOURCE_OWNERSHIP_CONFLICT');
        }
      });
    },
    async canAccessResource(kind, tenantId, resourceId, userId) {
      return withAuthContext(db, { userId, tenantId }, async (trx) => {
        const normalizedUser = userId.toLowerCase();
        let result: { rows: Array<{ allowed: boolean }> };
        switch (kind) {
          case 'cart':
            result = await sql<{ allowed: boolean }>`
            select exists (
              select 1 from commerce.carts
              where tenant_id = ${tenantId}
                and id = ${resourceId}::uuid
                and user_id = ${normalizedUser}::uuid
            ) as allowed
          `.execute(trx);
            break;
          case 'quote':
            result = await sql<{ allowed: boolean }>`
            select exists (
              select 1
              from commerce.quotes quote
              join commerce.carts cart
                on cart.tenant_id = quote.tenant_id
               and cart.id = quote.cart_id
              where quote.tenant_id = ${tenantId}
                and quote.id = ${resourceId}::uuid
                and cart.user_id = ${normalizedUser}::uuid
            ) as allowed
          `.execute(trx);
            break;
          case 'checkout':
          case 'order':
            result = await sql<{ allowed: boolean }>`
            select exists (
              select 1
              from payments.checkout_sessions checkout_session
              join commerce.quotes quote
                on quote.tenant_id = checkout_session.tenant_id
               and quote.id = checkout_session.quote_id
              join commerce.carts cart
                on cart.tenant_id = quote.tenant_id
               and cart.id = quote.cart_id
              where checkout_session.tenant_id = ${tenantId}
                and checkout_session.id = ${resourceId}::uuid
                and cart.user_id = ${normalizedUser}::uuid
            ) as allowed
          `.execute(trx);
            break;
          case 'conversation':
            result = await sql<{ allowed: boolean }>`
            select exists (
              select 1 from conversation.conversations
              where tenant_id = ${tenantId}
                and id = ${resourceId}::uuid
                and user_id = ${normalizedUser}::uuid
            ) as allowed
          `.execute(trx);
            break;
          default: {
            const exhaustive: never = kind;
            throw new Error(`RESOURCE_KIND_UNSUPPORTED: ${exhaustive}`);
          }
        }
        return result.rows[0]?.allowed === true;
      });
    },
    async listBuyerOrders(input) {
      const shops = await listPublishedBuyerShops(db);
      const rows: BuyerOrderSummary[] = [];
      for (const shop of shops) {
        const page = await withMachineTenant(db, shop.tenantId, async (trx) => {
          const result = await sql<MerchantOrderDbRow>`
              select checkout_session.id,
                     checkout_session.quote_id,
                     checkout_session.receipt,
                     checkout_session.razorpay_order_id,
                     checkout_session.amount_minor::text,
                     checkout_session.status as checkout_status,
                     checkout_session.payment_id,
                     checkout_session.provider_status,
                     checkout_session.copy,
                     checkout_session.created_at,
                     checkout_session.updated_at,
                     capture.created_at as captured_at
              from payments.checkout_sessions checkout_session
              join commerce.quotes quote
                on quote.tenant_id = checkout_session.tenant_id
               and quote.id = checkout_session.quote_id
              join commerce.carts cart
                on cart.tenant_id = quote.tenant_id
               and cart.id = quote.cart_id
               and cart.user_id = ${input.userId.toLowerCase()}::uuid
              left join lateral (
                select entry.created_at
                from ledger.ledger_entries entry
                where entry.tenant_id = checkout_session.tenant_id
                  and entry.checkout_id = checkout_session.id
                  and entry.kind = 'capture'
                  and checkout_session.provider_status = 'captured'
                  and not exists (
                    select 1
                    from ledger.ledger_entries reversal
                    where reversal.tenant_id = entry.tenant_id
                      and reversal.checkout_id = entry.checkout_id
                      and reversal.kind in ('refund', 'void', 'capture_reversal')
                  )
                order by entry.created_at desc
                limit 1
              ) capture on true
              where checkout_session.tenant_id = ${shop.tenantId}
              order by checkout_session.updated_at desc, checkout_session.id desc
            `.execute(trx);
          const summaries: MerchantOrderSummary[] = [];
          for (const row of result.rows) {
            const summary = merchantOrderSummary(row);
            if (!summary.fulfillmentReady) {
              summaries.push(summary);
              continue;
            }
            const sandbox = await ensureSandboxFulfillment(trx, shop.tenantId, summary.id, true);
            summaries.push(withSandboxSummary(summary, sandbox));
          }
          return summaries;
        });
        for (const item of page) {
          rows.push({ ...item, shop });
        }
      }
      rows.sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      );
      const afterIndex = input.after
        ? rows.findIndex(
            (row) => row.updatedAt === input.after?.sortValue && row.id === input.after.id,
          )
        : -1;
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      const items = rows.slice(start, start + input.limit);
      const last = items[items.length - 1];
      return {
        items,
        cursor:
          rows.length > start + input.limit && last
            ? { sortValue: last.updatedAt, id: last.id }
            : null,
      };
    },
    async getBuyerOrder(input) {
      const shops = await listPublishedBuyerShops(db);
      for (const shop of shops) {
        const detail = await withMachineTenant(db, shop.tenantId, async (trx) => {
          const owned = await sql<{ allowed: boolean }>`
            select exists (
              select 1
              from payments.checkout_sessions checkout_session
              join commerce.quotes quote
                on quote.tenant_id = checkout_session.tenant_id
               and quote.id = checkout_session.quote_id
              join commerce.carts cart
                on cart.tenant_id = quote.tenant_id
               and cart.id = quote.cart_id
              where checkout_session.tenant_id = ${shop.tenantId}
                and checkout_session.id = ${input.orderId}::uuid
                and cart.user_id = ${input.userId.toLowerCase()}::uuid
            ) as allowed
          `.execute(trx);
          if (owned.rows[0]?.allowed !== true) {
            return undefined;
          }
          const loaded = await loadBuyerOrderDetail(trx, shop.tenantId, input.orderId);
          return loaded ? { ...loaded, shop } : undefined;
        });
        if (detail) {
          return detail;
        }
      }
      return undefined;
    },
    async saveConversation(input) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error('CONVERSATION_VERSION_CONFLICT');
      }
      const state = persistedConversationState(input.state);
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          const saved =
            input.expectedRevision === 0
              ? await sql<{ revision: string }>`
                  insert into conversation.conversations (
                    id,
                    tenant_id,
                    user_id,
                    channel,
                    status,
                    state,
                    revision
                  )
                  values (
                    ${input.id}::uuid,
                    ${input.tenantId},
                    ${input.userId.toLowerCase()}::uuid,
                    'web',
                    'open',
                    ${JSON.stringify(state)}::jsonb,
                    1
                  )
                  on conflict (id) do update
                  set state = excluded.state,
                      revision = conversation.conversations.revision + 1,
                      updated_at = now()
                  where conversation.conversations.tenant_id = ${input.tenantId}
                    and conversation.conversations.user_id = ${input.userId.toLowerCase()}::uuid
                    and conversation.conversations.revision = ${input.expectedRevision}
                  returning revision::text
                `.execute(trx)
              : await sql<{ revision: string }>`
                  update conversation.conversations
                  set state = ${JSON.stringify(state)}::jsonb,
                      revision = revision + 1,
                      updated_at = now()
                  where id = ${input.id}::uuid
                    and tenant_id = ${input.tenantId}
                    and user_id = ${input.userId.toLowerCase()}::uuid
                    and revision = ${input.expectedRevision}
                  returning revision::text
                `.execute(trx);
          const savedRow = saved.rows[0];
          if (!savedRow) {
            throw new Error('CONVERSATION_VERSION_CONFLICT');
          }
          const countResult = await sql<{ count: number }>`
            select count(*)::int as count
            from conversation.messages
            where tenant_id = ${input.tenantId}
              and conversation_id = ${input.id}::uuid
          `.execute(trx);
          const persistedCount = countResult.rows[0]?.count ?? 0;
          for (const rawMessage of state.messages.slice(persistedCount)) {
            const message =
              rawMessage && typeof rawMessage === 'object'
                ? (rawMessage as {
                    role?: string;
                    content?: unknown;
                    tool_calls?: unknown;
                    tool_call_id?: unknown;
                  })
                : {};
            const actor =
              message.role === 'user'
                ? 'user'
                : message.role === 'assistant'
                  ? 'assistant'
                  : 'system';
            const content =
              typeof message.content === 'string' && message.content.length > 0
                ? message.content
                : JSON.stringify({
                    toolCalls: message.tool_calls ?? null,
                    toolCallId: message.tool_call_id ?? null,
                  });
            await sql`
              insert into conversation.messages (
                id,
                tenant_id,
                conversation_id,
                user_id,
                actor,
                content,
                metadata
              )
              values (
                ${randomUUID()}::uuid,
                ${input.tenantId},
                ${input.id}::uuid,
                ${actor === 'user' ? input.userId.toLowerCase() : null}::uuid,
                ${actor},
                ${content},
                ${JSON.stringify({ role: message.role ?? 'unknown' })}::jsonb
              )
            `.execute(trx);
          }
          return conversationRevision(savedRow.revision);
        },
      );
    },
    async loadConversation(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          const result = await sql<{ state: unknown; revision: string }>`
            select state, revision::text
            from conversation.conversations
            where tenant_id = ${input.tenantId}
              and id = ${input.id}::uuid
              and user_id = ${input.userId.toLowerCase()}::uuid
            limit 1
          `.execute(trx);
          const row = result.rows[0];
          const state = conversationState(row?.state);
          return row && state ? { revision: conversationRevision(row.revision), state } : undefined;
        },
      );
    },
    async consumePendingCheckout(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          const result = await sql<{ state: unknown; revision: string }>`
            select state, revision::text
            from conversation.conversations
            where tenant_id = ${input.tenantId}
              and id = ${input.id}::uuid
              and user_id = ${input.userId.toLowerCase()}::uuid
            for update
          `.execute(trx);
          const row = result.rows[0];
          const state = conversationState(row?.state);
          if (!row || !state) {
            return undefined;
          }
          const revision = conversationRevision(row.revision);
          const checkout = state?.pendingCheckout ?? null;
          if (checkout === null) {
            return { revision, checkout: null };
          }
          const updated = await sql<{ revision: string }>`
            update conversation.conversations
            set state = jsonb_set(state, '{pendingCheckout}', 'null'::jsonb, true),
                revision = revision + 1,
                updated_at = now()
            where tenant_id = ${input.tenantId}
              and id = ${input.id}::uuid
              and user_id = ${input.userId.toLowerCase()}::uuid
              and revision = ${revision}
            returning revision::text
          `.execute(trx);
          const updatedRow = updated.rows[0];
          if (!updatedRow) {
            throw new Error('CONVERSATION_VERSION_CONFLICT');
          }
          return {
            revision: conversationRevision(updatedRow.revision),
            checkout,
          };
        },
      );
    },
    async saveRecoveryConsent(consent) {
      return withAuthContext(
        db,
        { userId: consent.userId, tenantId: consent.tenantId },
        async (trx) => {
          const result = await sql<{ id: string; granted_at: Date }>`
          insert into recovery.consents (
            id,
            tenant_id,
            user_id,
            purpose,
            channel,
            contact_value,
            status,
            granted_at
          )
          values (
            ${consent.id}::uuid,
            ${consent.tenantId},
            ${consent.userId.toLowerCase()}::uuid,
            ${consent.purpose},
            ${consent.channel},
            ${consent.email.toLowerCase()},
            'granted',
            ${consent.grantedAt}
          )
          on conflict (tenant_id, contact_value, purpose, channel)
            where status = 'granted'
          do update
          set user_id = excluded.user_id,
              updated_at = now()
          returning id, granted_at
        `.execute(trx);
          const row = result.rows[0];
          if (!row) {
            throw new Error('CONSENT_SAVE_FAILED');
          }
          return {
            ...consent,
            id: row.id,
            grantedAt: row.granted_at.toISOString(),
          };
        },
      );
    },
    async bindRecoveryConsent(input) {
      await withAuthContext(db, { userId: input.userId, tenantId: input.tenantId }, async (trx) => {
        const result = await sql<{ consent_id: string }>`
          insert into recovery.checkout_consents (
            tenant_id,
            checkout_id,
            consent_id,
            user_id
          )
          select
            ${input.tenantId},
            ${input.checkoutId}::uuid,
            consent.id,
            consent.user_id
          from recovery.consents consent
          where consent.tenant_id = ${input.tenantId}
            and consent.id = ${input.consentId}::uuid
            and consent.user_id = ${input.userId.toLowerCase()}::uuid
            and consent.status = 'granted'
          on conflict (tenant_id, checkout_id) do update
          set consent_id = excluded.consent_id,
              user_id = excluded.user_id
          where recovery.checkout_consents.user_id = excluded.user_id
          returning consent_id
        `.execute(trx);
        if (!result.rows[0]) {
          throw new Error('CONSENT_NOT_FOUND');
        }
      });
    },
    async loadRecoveryConsent(input) {
      return withAuthContext(
        db,
        { userId: input.userId, tenantId: input.tenantId },
        async (trx) => {
          const result = await sql<{
            id: string;
            user_id: string;
            purpose: 'payment_recovery';
            channel: 'email';
            contact_value: string;
            granted_at: Date;
          }>`
          select consent.id,
                 consent.user_id,
                 consent.purpose,
                 consent.channel,
                 consent.contact_value,
                 consent.granted_at
          from recovery.checkout_consents checkout_consent
          join recovery.consents consent
            on consent.tenant_id = checkout_consent.tenant_id
           and consent.id = checkout_consent.consent_id
           and consent.status = 'granted'
          where checkout_consent.tenant_id = ${input.tenantId}
            and checkout_consent.checkout_id = ${input.checkoutId}::uuid
            and checkout_consent.user_id = ${input.userId.toLowerCase()}::uuid
          limit 1
        `.execute(trx);
          const row = result.rows[0];
          return row
            ? {
                id: row.id,
                tenantId: input.tenantId,
                userId: row.user_id,
                email: row.contact_value,
                purpose: row.purpose,
                channel: row.channel,
                grantedAt: row.granted_at.toISOString(),
              }
            : undefined;
        },
      );
    },
    async reserveRecoveryAttempt(input) {
      const { tenantId, checkoutId, purpose, channel, maxAttempts } = input;
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error('RECOVERY_MAX_ATTEMPTS_INVALID');
      }
      return withMachineTenant(db, tenantId, async (trx) => {
        const consentResult = await sql<{
          id: string;
          user_id: string;
          purpose: 'payment_recovery';
          channel: 'email';
          contact_value: string;
          granted_at: Date;
          checkout_status: string;
        }>`
          select consent.id,
                 consent.user_id,
                 consent.purpose,
                 consent.channel,
                 consent.contact_value,
                 consent.granted_at,
                 checkout_session.status as checkout_status
          from recovery.checkout_consents checkout_consent
          join recovery.consents consent
            on consent.tenant_id = checkout_consent.tenant_id
           and consent.id = checkout_consent.consent_id
           and consent.status = 'granted'
           and consent.purpose = ${purpose}
           and consent.channel = ${channel}
           and consent.user_id is not null
          join payments.checkout_sessions checkout_session
            on checkout_session.tenant_id = checkout_consent.tenant_id
           and checkout_session.id = checkout_consent.checkout_id
          where checkout_consent.tenant_id = ${tenantId}
            and checkout_consent.checkout_id = ${checkoutId}::uuid
          for update of checkout_consent, consent, checkout_session
        `.execute(trx);
        const consent = consentResult.rows[0];
        if (!consent) {
          return { action: 'suppressed', reason: 'NO_CONSENT' };
        }
        if (consent.checkout_status !== 'FAILED_PROVISIONAL') {
          return { action: 'suppressed', reason: 'NOT_FAILED_PROVISIONAL' };
        }
        if (input.evidence.outcome !== 'same_order_retry_safe' || !input.evidence.reconciledAt) {
          return { action: 'suppressed', reason: 'RECONCILIATION_REQUIRED' };
        }
        const snapshot = await sql<{
          outcome: string;
          reconciled_at: Date;
          correlation_id: string;
        }>`
          select snapshot.outcome,
                 snapshot.reconciled_at,
                 snapshot.correlation_id
          from payments.reconciliation_snapshots snapshot
          where snapshot.tenant_id = ${tenantId}
            and snapshot.checkout_id = ${checkoutId}::uuid
          for update
        `.execute(trx);
        const current = snapshot.rows[0];
        if (
          !current ||
          current.outcome !== 'same_order_retry_safe' ||
          current.reconciled_at.toISOString() !== input.evidence.reconciledAt
        ) {
          return { action: 'suppressed', reason: 'RECONCILIATION_REQUIRED' };
        }
        const suppression = await sql<{ suppressed: boolean }>`
          select exists (
            select 1
            from recovery.suppressions suppression
            where suppression.tenant_id = ${tenantId}
              and suppression.contact_value = ${consent.contact_value}
              and suppression.purpose = ${purpose}
              and suppression.channel = ${channel}
              and suppression.active
          ) as suppressed
        `.execute(trx);
        if (suppression.rows[0]?.suppressed) {
          return { action: 'suppressed', reason: 'SUPPRESSED' };
        }
        const count = await sql<{ next_attempt: number; key_attempts: number }>`
          select
            (coalesce(max(attempt_number), 0) + 1)::int as next_attempt,
            count(*) filter (
              where checkout_id = ${checkoutId}::uuid
                and purpose = ${purpose}
                and channel = ${channel}
                and status <> 'suppressed'
            )::int as key_attempts
          from recovery.attempts
          where tenant_id = ${tenantId}
            and consent_id = ${consent.id}::uuid
        `.execute(trx);
        const killed = await sql<{ killed: boolean }>`
          select app_private.is_checkout_killed(${tenantId}) as killed
        `.execute(trx);
        if (killed.rows[0]?.killed) {
          await sql`
            insert into recovery.attempts (
              id,
              tenant_id,
              consent_id,
              user_id,
              checkout_id,
              purpose,
              channel,
              attempt_number,
              status,
              provider,
              failure_code,
              completed_at
            )
            values (
              ${randomUUID()}::uuid,
              ${tenantId},
              ${consent.id}::uuid,
              ${consent.user_id}::uuid,
              ${checkoutId}::uuid,
              ${purpose},
              ${channel},
              ${count.rows[0]?.next_attempt ?? 1},
              'suppressed',
              'agentmail',
              'RECOVERY_CHECKOUT_KILLED',
              now()
            )
          `.execute(trx);
          return { action: 'suppressed', reason: 'CHECKOUT_KILLED' };
        }
        const active = await trx
          .withSchema('recovery')
          .selectFrom('attempts')
          .select(['id', 'status'])
          .where('tenant_id', '=', tenantId)
          .where('checkout_id', '=', checkoutId)
          .where('consent_id', '=', consent.id)
          .where('purpose', '=', purpose)
          .where('channel', '=', channel)
          .where('status', 'in', ['pending', 'sent', 'delivered'])
          .orderBy('attempted_at', 'desc')
          .forUpdate()
          .executeTakeFirst();
        if (active) {
          return {
            action: 'suppressed',
            reason: active.status === 'pending' ? 'ALREADY_PENDING' : 'ALREADY_SENT',
          };
        }
        const attemptCount = count.rows[0]?.key_attempts ?? 0;
        if (attemptCount >= maxAttempts) {
          return { action: 'suppressed', reason: 'RETRY_LIMIT_REACHED' };
        }
        const attemptId = randomUUID();
        const inserted = await sql<{ id: string }>`
          insert into recovery.attempts (
            id,
            tenant_id,
            consent_id,
            user_id,
            checkout_id,
            purpose,
            channel,
            attempt_number,
              status,
              provider,
              reconciliation_outcome,
              reconciled_at,
              reconciliation_correlation_id
            )
            values (
              ${attemptId}::uuid,
              ${tenantId},
              ${consent.id}::uuid,
              ${consent.user_id}::uuid,
              ${checkoutId}::uuid,
              ${purpose},
              ${channel},
              ${count.rows[0]?.next_attempt ?? 1},
              'pending',
              'agentmail',
              ${input.evidence.outcome},
              ${input.evidence.reconciledAt}::timestamptz,
              ${current.correlation_id}
            )
          on conflict (tenant_id, checkout_id, consent_id, purpose, channel)
            where status in ('pending', 'sent', 'delivered')
          do nothing
          returning id
        `.execute(trx);
        if (!inserted.rows[0]) {
          const conflicting = await trx
            .withSchema('recovery')
            .selectFrom('attempts')
            .select('status')
            .where('tenant_id', '=', tenantId)
            .where('checkout_id', '=', checkoutId)
            .where('consent_id', '=', consent.id)
            .where('purpose', '=', purpose)
            .where('channel', '=', channel)
            .where('status', 'in', ['pending', 'sent', 'delivered'])
            .executeTakeFirst();
          return {
            action: 'suppressed',
            reason: conflicting?.status === 'pending' ? 'ALREADY_PENDING' : 'ALREADY_SENT',
          };
        }
        return {
          action: 'reserved',
          attemptId,
          consent: {
            id: consent.id,
            tenantId,
            userId: consent.user_id,
            email: consent.contact_value,
            purpose: consent.purpose,
            channel: consent.channel,
            grantedAt: consent.granted_at.toISOString(),
          },
        };
      });
    },
    async markRecoveryAttemptSent(input) {
      await withMachineTenant(db, input.tenantId, async (trx) => {
        const updated = await trx
          .withSchema('recovery')
          .updateTable('attempts')
          .set({
            status: 'sent',
            provider_message_id: input.providerMessageId,
            failure_code: null,
            completed_at: new Date(),
          })
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.attemptId)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();
        if (!updated) {
          throw new Error('RECOVERY_ATTEMPT_NOT_PENDING');
        }
      });
    },
    async markRecoveryAttemptFailed(input) {
      await withMachineTenant(db, input.tenantId, async (trx) => {
        const updated = await trx
          .withSchema('recovery')
          .updateTable('attempts')
          .set({
            status: 'failed',
            provider_message_id: null,
            failure_code: input.failureCode,
            completed_at: new Date(),
          })
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.attemptId)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();
        if (!updated) {
          throw new Error('RECOVERY_ATTEMPT_NOT_PENDING');
        }
      });
    },
    async setKillSwitch(input) {
      const tenantId = input.scope === 'tenant' ? input.tenantId : null;
      if (input.scope === 'tenant' && !tenantId) {
        throw new Error('TENANT_ID_REQUIRED');
      }
      return withUserContext(db, { userId: input.changedBy }, async (trx) => {
        const existing = await sql<{ id: string }>`
          select id
          from operations.kill_switches
          where feature = 'checkout'
            and scope = ${input.scope}
            and (
              (${input.scope} = 'global' and tenant_id is null)
              or tenant_id = ${tenantId}
            )
          limit 1
        `.execute(trx);
        if (existing.rows[0]) {
          await sql`
            update operations.kill_switches
            set enabled = ${input.on},
                changed_by = ${input.changedBy.toLowerCase()}::uuid,
                updated_at = now()
            where id = ${existing.rows[0].id}::uuid
          `.execute(trx);
        } else {
          await sql`
            insert into operations.kill_switches (
              id, scope, tenant_id, feature, enabled, changed_by
            )
            values (
              ${randomUUID()}::uuid,
              ${input.scope},
              ${tenantId},
              'checkout',
              ${input.on},
              ${input.changedBy.toLowerCase()}::uuid
            )
          `.execute(trx);
        }
        return readKillSnapshot(trx);
      });
    },
    killSnapshot,
    async isCheckoutKilled(tenantId) {
      return withMachineTenant(db, tenantId, async (trx) => {
        const result = await sql<{ killed: boolean }>`
          select app_private.is_checkout_killed(${tenantId}) as killed
        `.execute(trx);
        return result.rows[0]?.killed === true;
      });
    },
    async recordDiscovery(input) {
      if (input.hits.length === 0) {
        return;
      }
      const requestId = input.requestId.slice(0, 80);
      const query = input.query.slice(0, 400);
      const uniqueTenants = [...new Set(input.hits.map((hit) => hit.tenantId))];
      const write = async (trx: Transaction<Database>) => {
        for (const tenantId of uniqueTenants) {
          await sql`
            insert into catalog.search_events (
              id, tenant_id, request_id, query_text, surface, agent_source
            )
            values (
              ${randomUUID()}::uuid,
              ${tenantId},
              ${requestId},
              ${query},
              ${input.surface},
              ${input.agentSource}
            )
          `.execute(trx);
        }
        for (const hit of input.hits) {
          await sql`
            insert into catalog.recommendation_impressions (
              id, tenant_id, request_id, shop_slug, sku, rank, surface, agent_source, query_text
            )
            values (
              ${randomUUID()}::uuid,
              ${hit.tenantId},
              ${requestId},
              ${hit.shopSlug},
              ${hit.sku ?? null},
              ${hit.rank},
              ${input.surface},
              ${input.agentSource},
              ${query}
            )
          `.execute(trx);
        }
      };
      if (uniqueTenants.length === 1) {
        await withMachineTenant(db, uniqueTenants[0]!, write);
        return;
      }
      await withPublicCatalogContext(db, write);
    },
  };
}
