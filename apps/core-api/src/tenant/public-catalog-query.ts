import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PUBLIC_CATALOG_LIMIT_DEFAULT = 12;
export const PUBLIC_CATALOG_LIMIT_MAX = 48;
export const PUBLIC_CATALOG_SORTS = ['relevance', 'newest', 'name', 'rating'] as const;

export type PublicCatalogSort = (typeof PUBLIC_CATALOG_SORTS)[number];

export type PublicCatalogQuery = {
  q: string;
  sku: string;
  category: string;
  inStock: boolean;
  minPriceMinor: string | null;
  maxPriceMinor: string | null;
  sort: PublicCatalogSort;
  limit: number;
  fingerprint: string;
  after: PublicCatalogCursorPosition | null;
};

export type PublicCatalogCursorPosition = {
  relevance: number;
  publishedAt: string;
  name: string;
  id: string;
  ratingMilli: number;
  reviewCount: number;
};

export type RawPublicCatalogQuery = {
  q?: string;
  sku?: string;
  category?: string;
  inStock?: string;
  minPriceMinor?: string;
  maxPriceMinor?: string;
  sort?: PublicCatalogSort;
  cursor?: string;
  limit?: string;
};

export const PUBLIC_CATALOG_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 120 },
    sku: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$',
    },
    category: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    },
    inStock: { type: 'string', enum: ['true', 'false'] },
    minPriceMinor: { type: 'string', pattern: '^[0-9]{1,13}$' },
    maxPriceMinor: { type: 'string', pattern: '^[0-9]{1,13}$' },
    sort: { type: 'string', enum: PUBLIC_CATALOG_SORTS },
    cursor: { type: 'string', minLength: 8, maxLength: 512 },
    limit: { type: 'string', pattern: '^[0-9]{1,2}$' },
  },
} as const;

export class PublicCatalogQueryError extends Error {
  readonly code: 'CURSOR_INVALID' | 'QUERY_INVALID';

  constructor(code: 'CURSOR_INVALID' | 'QUERY_INVALID') {
    super(code);
    this.name = 'PublicCatalogQueryError';
    this.code = code;
  }
}

function normalizedSearch(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
}

function parseMinor(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (!/^[0-9]{1,13}$/.test(value)) {
    throw new PublicCatalogQueryError('QUERY_INVALID');
  }
  const minor = BigInt(value);
  if (minor > 9_999_999_999_999n) {
    throw new PublicCatalogQueryError('QUERY_INVALID');
  }
  return minor.toString();
}

function queryFingerprint(
  scope: string,
  input: Omit<PublicCatalogQuery, 'after' | 'fingerprint'>,
): string {
  const canonical = JSON.stringify([
    scope,
    input.q,
    input.sku,
    input.category,
    input.inStock,
    input.minPriceMinor,
    input.maxPriceMinor,
    input.sort,
    input.limit,
  ]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 24);
}

function cursorSignature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`charter-public-catalog-v2:${payload}`).digest();
}

function validPosition(value: unknown): value is PublicCatalogCursorPosition {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const position = value as Partial<PublicCatalogCursorPosition>;
  return (
    typeof position.relevance === 'number' &&
    Number.isSafeInteger(position.relevance) &&
    position.relevance >= 0 &&
    typeof position.publishedAt === 'string' &&
    !Number.isNaN(Date.parse(position.publishedAt)) &&
    typeof position.name === 'string' &&
    position.name.length <= 180 &&
    typeof position.id === 'string' &&
    position.id.length > 0 &&
    position.id.length <= 160 &&
    typeof position.ratingMilli === 'number' &&
    Number.isSafeInteger(position.ratingMilli) &&
    position.ratingMilli >= 0 &&
    position.ratingMilli <= 5000 &&
    typeof position.reviewCount === 'number' &&
    Number.isSafeInteger(position.reviewCount) &&
    position.reviewCount >= 0
  );
}

function decodeCursor(
  cursor: string,
  fingerprint: string,
  secret: string,
): PublicCatalogCursorPosition {
  const [payload, signature, extra] = cursor.split('.');
  if (!payload || !signature || extra !== undefined || !secret) {
    throw new PublicCatalogQueryError('CURSOR_INVALID');
  }
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    throw new PublicCatalogQueryError('CURSOR_INVALID');
  }
  if (
    supplied.toString('base64url') !== signature ||
    Buffer.from(payload, 'base64url').toString('base64url') !== payload
  ) {
    throw new PublicCatalogQueryError('CURSOR_INVALID');
  }
  const expected = cursorSignature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new PublicCatalogQueryError('CURSOR_INVALID');
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v?: unknown;
      f?: unknown;
      k?: unknown;
    };
    if (decoded.v !== 2 || decoded.f !== fingerprint || !validPosition(decoded.k)) {
      throw new PublicCatalogQueryError('CURSOR_INVALID');
    }
    return decoded.k;
  } catch (error) {
    if (error instanceof PublicCatalogQueryError) {
      throw error;
    }
    throw new PublicCatalogQueryError('CURSOR_INVALID');
  }
}

export function parsePublicCatalogQuery(
  raw: RawPublicCatalogQuery,
  scope: string,
  secret: string,
): PublicCatalogQuery {
  const q = normalizedSearch(raw.q);
  const sku = raw.sku ?? '';
  if ((scope === 'shops' && sku) || (sku && (q || raw.cursor))) {
    throw new PublicCatalogQueryError('QUERY_INVALID');
  }
  const category = raw.category ?? '';
  const inStock = raw.inStock === 'true';
  const minPriceMinor = parseMinor(raw.minPriceMinor);
  const maxPriceMinor = parseMinor(raw.maxPriceMinor);
  if (
    minPriceMinor !== null &&
    maxPriceMinor !== null &&
    BigInt(minPriceMinor) > BigInt(maxPriceMinor)
  ) {
    throw new PublicCatalogQueryError('QUERY_INVALID');
  }
  const limit = raw.limit === undefined ? PUBLIC_CATALOG_LIMIT_DEFAULT : Number(raw.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLIC_CATALOG_LIMIT_MAX) {
    throw new PublicCatalogQueryError('QUERY_INVALID');
  }
  const sort = raw.sort ?? (scope === 'shops' ? 'rating' : 'relevance');
  if (!PUBLIC_CATALOG_SORTS.includes(sort)) {
    throw new PublicCatalogQueryError('QUERY_INVALID');
  }
  const base = {
    q,
    sku,
    category,
    inStock,
    minPriceMinor,
    maxPriceMinor,
    sort,
    limit,
  } satisfies Omit<PublicCatalogQuery, 'after' | 'fingerprint'>;
  const fingerprint = queryFingerprint(scope, base);
  const after = raw.cursor ? decodeCursor(raw.cursor, fingerprint, secret) : null;
  return { ...base, after, fingerprint };
}

export function nextPublicCatalogCursor(
  query: PublicCatalogQuery,
  position: PublicCatalogCursorPosition | null,
  secret: string,
): string | null {
  if (!position) {
    return null;
  }
  const payload = Buffer.from(
    JSON.stringify({ v: 2, f: query.fingerprint, k: position }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${cursorSignature(payload, secret).toString('base64url')}`;
}
