export function safeErrorCode(
  error: unknown,
  allowed: readonly string[],
  fallback: string,
): string {
  const code = error instanceof Error ? error.message : '';
  return allowed.includes(code) ? code : fallback;
}
