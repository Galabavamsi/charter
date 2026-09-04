export { DEFAULT_SIGNED_IN_PATH } from './buyer-session';

const AUTH_PATHS = new Set(['/auth/sign-in', '/auth/sign-up']);

export function safeNextPath(value: string | null | undefined, origin?: string): string | null {
  if (!value || value.includes('\\')) {
    return null;
  }

  const baseOrigin =
    origin ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  let parsed: URL;
  try {
    parsed = new URL(value, baseOrigin);
  } catch {
    return null;
  }

  if (parsed.origin !== new URL(baseOrigin).origin || !parsed.pathname.startsWith('/')) {
    return null;
  }
  if (AUTH_PATHS.has(parsed.pathname)) {
    return null;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
