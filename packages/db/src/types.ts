import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string | undefined>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null | undefined
>;
type MoneyMinor = ColumnType<string, string | number | bigint, string | number | bigint>;
type DefaultMoneyMinor = ColumnType<
  string,
  string | number | bigint | undefined,
  string | number | bigint
>;
type DateOnly = ColumnType<string, string | Date, string | Date>;
type NullableText = ColumnType<string | null, string | null | undefined, string | null | undefined>;
type NullableUuid = ColumnType<string | null, string | null | undefined, string | null | undefined>;
type StringArray = ColumnType<string[], readonly string[] | undefined, readonly string[]>;
type JsonObject = ColumnType<unknown, unknown | undefined, unknown>;

export type UserStatus = 'active' | 'disabled' | 'deleted';
export type ShopMembershipRole = 'owner' | 'admin' | 'catalog' | 'support' | 'finance' | 'viewer';
export type ShopMembershipStatus = 'invited' | 'active' | 'suspended';
export type PlatformRole = 'admin' | 'operator' | 'auditor';
export type PublicationStatus = 'draft' | 'published' | 'archived';

export type SchemaMigrationRow = {
  id: string;
  checksum: string;
  applied_at: Timestamp;
};

export type UserRow = {
  id: string;
  email: NullableText;
  status: Generated<UserStatus>;
  synthetic: Generated<boolean>;
  auth_synced_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ProfileRow = {
  user_id: string;
  display_name: string;
  avatar_url: NullableText;
  locale: Generated<string>;
  time_zone: Generated<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type TenantRow = {
  id: string;
  label: string;
  synthetic: Generated<boolean>;
  status: Generated<'active' | 'suspended' | 'archived'>;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ShopMembershipRow = {
  tenant_id: string;
  user_id: string;
  role: ShopMembershipRole;
  status: Generated<ShopMembershipStatus>;
  invited_by: NullableUuid;
  joined_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type PlatformRoleRow = {
  user_id: string;
  role: PlatformRole;
  granted_by: NullableUuid;
  created_at: Timestamp;
};

export type CartRow = {
  id: string;
  tenant_id: string;
  user_id: NullableUuid;
  version: number;
  approved_through_minor: DefaultMoneyMinor;
  created_at: Timestamp;
};

export type CartLineRow = {
  tenant_id: string;
  cart_id: string;
  sku: string;
  quantity: number;
};

export type QuoteRow = {
  id: string;
  tenant_id: string;
  cart_id: string;
  cart_version: number;
  status: 'FROZEN' | 'BOUND' | 'SETTLED';
  bound_checkout_id: NullableUuid;
  currency: 'INR';
  subtotal_minor: MoneyMinor;
  discount_minor: MoneyMinor;
  total_minor: MoneyMinor;
  delivery_by: DateOnly;
  merchant: string;
  catalog_version: Generated<number>;
  policy_version: Generated<number>;
  fact_hash: string;
  created_at: Timestamp;
};

export type QuoteLineRow = {
  tenant_id: string;
  quote_id: string;
  sku: string;
  title: string;
  quantity: number;
  unit_minor: MoneyMinor;
  line_minor: MoneyMinor;
};

export type CheckoutRow = {
  id: string;
  tenant_id: string;
  quote_id: string;
  receipt: string;
  razorpay_order_id: string;
  amount_minor: MoneyMinor;
  currency: 'INR';
  status:
    'CREATED' | 'VERIFYING' | 'RECONCILING' | 'CAPTURE_PENDING' | 'SETTLED' | 'FAILED_PROVISIONAL';
  payment_id: NullableText;
  provider_status: NullableText;
  copy: string;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type PaymentTransitionRow = {
  id: string;
  tenant_id: string;
  checkout_id: string;
  source: string;
  provider_reference: string;
  observed_provider_status: string;
  from_checkout_status: NullableText;
  to_checkout_status: string;
  applied: boolean;
  occurred_at: Timestamp;
  observed_at: Timestamp;
  correlation_id: string;
  evidence: JsonObject;
  created_at: Timestamp;
};

export type ReconciliationSnapshotRow = {
  tenant_id: string;
  checkout_id: string;
  quote_id: string;
  order_id: string;
  order_status: string;
  outcome: string;
  payment_attempts: JsonObject;
  reconciled_at: Timestamp;
  correlation_id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type InboxRow = {
  tenant_id: NullableText;
  provider: string;
  event_id: string;
  event_type: string;
  payload: JsonObject;
  state: Generated<'unresolved' | 'attributed' | 'quarantined'>;
  order_id: NullableText;
  quarantine_reason: NullableText;
  resolved_at: NullableTimestamp;
  received_at: Timestamp;
};

export type LedgerEntryRow = {
  id: string;
  tenant_id: string;
  checkout_id: string;
  quote_id: string;
  kind: string;
  amount_minor: MoneyMinor;
  currency: 'INR';
  provider_payment_id: NullableText;
  created_at: Timestamp;
};

export type ShopRow = {
  tenant_id: string;
  slug: string;
  name: string;
  label: string;
  blurb: Generated<string>;
  currency: Generated<'INR'>;
  status: Generated<'draft' | 'published' | 'suspended' | 'archived'>;
  synthetic: Generated<boolean>;
  version: Generated<number>;
  published_at: NullableTimestamp;
  rating_milli: Generated<number>;
  review_count: Generated<number>;
  gstin: Generated<string>;
  address_line: Generated<string>;
  refund_policy: Generated<string>;
  profile_verified: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type CategoryRow = {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  status: Generated<'active' | 'archived'>;
  position: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ProductRow = {
  id: string;
  tenant_id: string;
  category_id: NullableUuid;
  slug: string;
  title: string;
  description: Generated<string>;
  status: Generated<PublicationStatus>;
  currency: Generated<'INR'>;
  version: Generated<number>;
  published_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type VariantRow = {
  id: string;
  tenant_id: string;
  product_id: string;
  sku: string;
  title: string;
  price_minor: MoneyMinor;
  currency: Generated<'INR'>;
  material: Generated<'steel' | 'glass' | 'paper' | 'other'>;
  aliases: StringArray;
  status: Generated<PublicationStatus>;
  version: Generated<number>;
  published_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type InventoryRow = {
  tenant_id: string;
  variant_id: string;
  on_hand: Generated<number>;
  reserved: Generated<number>;
  available: ColumnType<number, never, never>;
  version: Generated<number>;
  updated_at: Timestamp;
};

export type InventoryAdjustmentRow = {
  id: string;
  tenant_id: string;
  variant_id: string;
  actor_id: string;
  delta: number;
  before_on_hand: number;
  after_on_hand: number;
  version_before: number;
  version_after: number;
  reason: string;
  created_at: Timestamp;
};

export type ProductAuditRow = {
  id: string;
  tenant_id: string;
  product_id: string;
  actor_id: string;
  version_before: number;
  version_after: number;
  reason: string;
  before_record: JsonObject;
  after_record: JsonObject;
  created_at: Timestamp;
};

export type ShopPolicyRow = {
  tenant_id: string;
  currency: Generated<'INR'>;
  hard_cap_minor: MoneyMinor;
  autonomous_cap_minor: MoneyMinor;
  forbidden_materials: StringArray;
  rules: JsonObject;
  version: Generated<number>;
  updated_by: NullableUuid;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ShopPolicyAuditRow = {
  id: string;
  tenant_id: string;
  actor_id: string;
  version_before: number;
  version_after: number;
  reason: string;
  before_record: JsonObject;
  after_record: JsonObject;
  created_at: Timestamp;
};

export type ShopAuditRow = {
  id: string;
  tenant_id: string;
  actor_id: string;
  version_before: number;
  version_after: number;
  reason: string;
  before_record: JsonObject;
  after_record: JsonObject;
  created_at: Timestamp;
};

export type ApprovalRow = {
  id: string;
  tenant_id: string;
  cart_id: NullableUuid;
  from_sku: NullableText;
  to_sku: NullableText;
  proposed_total_minor: MoneyMinor;
  approved_through_minor: ColumnType<
    string | null,
    string | number | bigint | null | undefined,
    string | number | bigint | null | undefined
  >;
  requested_by: string;
  decided_by: NullableUuid;
  status: Generated<'pending' | 'approved' | 'denied' | 'expired'>;
  kind: Generated<'cart_spend' | 'catalog_publish' | 'refund' | 'campaign' | 'platform'>;
  action_hash: NullableText;
  currency: Generated<'INR'>;
  resource_id: NullableText;
  resource_version: ColumnType<number | null, number | null | undefined, number | null | undefined>;
  reason: NullableText;
  expires_at: NullableTimestamp;
  decided_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ConversationRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  channel: 'web' | 'voice' | 'mcp';
  status: Generated<'open' | 'closed'>;
  external_session_id: NullableText;
  state: JsonObject;
  revision: Generated<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type MessageRow = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  user_id: NullableUuid;
  actor: 'user' | 'assistant' | 'system' | 'operator';
  content: string;
  metadata: JsonObject;
  created_at: Timestamp;
};

export type RecoveryConsentRow = {
  id: string;
  tenant_id: string;
  user_id: NullableUuid;
  purpose: 'payment_recovery';
  channel: 'email';
  contact_value: string;
  status: Generated<'granted' | 'revoked'>;
  granted_at: Timestamp;
  revoked_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type RecoveryAttemptRow = {
  id: string;
  tenant_id: string;
  consent_id: string;
  user_id: NullableUuid;
  checkout_id: NullableUuid;
  purpose: 'payment_recovery';
  channel: 'email';
  attempt_number: number;
  status: Generated<'pending' | 'sent' | 'delivered' | 'failed' | 'suppressed'>;
  provider: string;
  provider_message_id: NullableText;
  failure_code: NullableText;
  reconciliation_outcome: NullableText;
  reconciled_at: NullableTimestamp;
  reconciliation_correlation_id: NullableText;
  attempted_at: Timestamp;
  completed_at: NullableTimestamp;
  created_at: Timestamp;
};

export type RecoveryCheckoutConsentRow = {
  tenant_id: string;
  checkout_id: string;
  consent_id: string;
  user_id: string;
  created_at: Timestamp;
};

export type RecoverySuppressionRow = {
  id: string;
  tenant_id: string;
  contact_value: string;
  purpose: 'payment_recovery';
  channel: 'email';
  reason: string;
  active: Generated<boolean>;
  created_by: string;
  created_at: Timestamp;
  ended_at: NullableTimestamp;
};

export type KillSwitchRow = {
  id: string;
  scope: 'global' | 'tenant';
  tenant_id: NullableText;
  feature: string;
  enabled: Generated<boolean>;
  reason: NullableText;
  changed_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type MerchantCommandRow = {
  actor_id: string;
  tenant_id: NullableText;
  operation: string;
  idempotency_key: string;
  request_hash: string;
  response: JsonObject;
  created_at: Timestamp;
};

export type OfferRedemptionRow = {
  tenant_id: string;
  quote_id: string;
  offer_id: string;
  discount_minor: MoneyMinor;
  created_at: Timestamp;
};

export type Database = {
  schema_migrations: SchemaMigrationRow;
  users: UserRow;
  profiles: ProfileRow;
  tenants: TenantRow;
  shop_memberships: ShopMembershipRow;
  platform_roles: PlatformRoleRow;
  carts: CartRow;
  cart_lines: CartLineRow;
  quotes: QuoteRow;
  quote_lines: QuoteLineRow;
  offer_redemptions: OfferRedemptionRow;
  checkout_sessions: CheckoutRow;
  payment_transitions: PaymentTransitionRow;
  reconciliation_snapshots: ReconciliationSnapshotRow;
  inbox_events: InboxRow;
  ledger_entries: LedgerEntryRow;
  shops: ShopRow;
  categories: CategoryRow;
  products: ProductRow;
  variants: VariantRow;
  inventory: InventoryRow;
  inventory_adjustments: InventoryAdjustmentRow;
  product_audits: ProductAuditRow;
  shop_audits: ShopAuditRow;
  shop_policies: ShopPolicyRow;
  shop_policy_audits: ShopPolicyAuditRow;
  approvals: ApprovalRow;
  conversations: ConversationRow;
  messages: MessageRow;
  consents: RecoveryConsentRow;
  attempts: RecoveryAttemptRow;
  checkout_consents: RecoveryCheckoutConsentRow;
  suppressions: RecoverySuppressionRow;
  kill_switches: KillSwitchRow;
  merchant_commands: MerchantCommandRow;
};
