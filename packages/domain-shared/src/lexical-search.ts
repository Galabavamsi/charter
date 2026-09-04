const MIN_TOKEN_LENGTH = 3;

export function expandBuyerSearchQuery(query: string): string {
  return query
    .replace(/\b(t-?shirts?|tees?)\b/gi, 'tshirt tee shirt')
    .replace(/\b(gf|girlfriend|boyfriend|wife|husband|partner|fiancee|fiance)\b/gi, 'gift')
    .replace(/\b(presents?|souvenirs?)\b/gi, 'gift');
}

/** Function/browse scaffolding only — not product nouns or category slugs. */
const FUNCTION_WORDS = new Set([
  'all',
  'an',
  'and',
  'any',
  'are',
  'available',
  'about',
  'buy',
  'can',
  'find',
  'for',
  'from',
  'have',
  'how',
  'looking',
  'need',
  'please',
  'product',
  'products',
  'search',
  'show',
  'shop',
  'shops',
  'some',
  'store',
  'the',
  'want',
  'what',
  'with',
  'you',
  'your',
]);

export function lexicalSearchTokens(query: string): string[] {
  return expandBuyerSearchQuery(query)
    .trim()
    .toLocaleLowerCase('en-IN')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !FUNCTION_WORDS.has(token));
}

export function lexicalPhrase(query: string): string {
  return lexicalSearchTokens(query).join(' ');
}

export function isLexicalSmallTalk(query: string): boolean {
  return lexicalSearchTokens(query).length === 0;
}

export function lexicalEditDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const rows = left.length + 1;
  const cols = right.length + 1;
  const previous = Array.from({ length: cols }, (_, index) => index);
  for (let i = 1; i < rows; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const insertOrDelete = Math.min(previous[j]!, previous[j - 1]!) + 1;
      const substitute = diagonal + (left[i - 1] === right[j - 1] ? 0 : 1);
      diagonal = previous[j]!;
      previous[j] = Math.min(insertOrDelete, substitute);
    }
  }
  return previous[right.length]!;
}

export function lexicalTokensResemble(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  if (left.length < 4 || right.length < 4) {
    return false;
  }
  if (left.startsWith(right) || right.startsWith(left)) {
    return true;
  }
  if (Math.abs(left.length - right.length) > 2) {
    return false;
  }
  if (left.slice(0, 4) !== right.slice(0, 4)) {
    return false;
  }
  const maxDistance = left.length >= 8 || right.length >= 8 ? 2 : 1;
  return lexicalEditDistance(left, right) <= maxDistance;
}

export function lexicalTokenHits(token: string, text: string): boolean {
  if (!token || !text) {
    return false;
  }
  if (text.includes(token)) {
    return true;
  }
  return text
    .split(/[^a-z0-9]+/)
    .some((word) => word.length >= 4 && lexicalTokensResemble(token, word));
}

export function lexicalOverlapScore(value: string, query: string, weight: number): number {
  const text = value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
  const tokens = lexicalSearchTokens(query);
  if (!text || tokens.length === 0) {
    return 0;
  }
  const phrase = tokens.join(' ');
  if (text === phrase) {
    return weight * 4;
  }
  if (text.startsWith(phrase)) {
    return weight * 3;
  }
  if (text.includes(phrase)) {
    return weight * 2;
  }
  const hits = tokens.filter((token) => lexicalTokenHits(token, text)).length;
  if (hits === 0) {
    return 0;
  }
  return Math.max(1, Math.trunc((weight * hits) / tokens.length));
}
