import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type VerifiedIdentity = {
  userId: string;
  email?: string;
};

export interface AuthVerifier {
  verify(accessToken: string): Promise<VerifiedIdentity>;
}

export type SupabaseAuthVerifierConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
};

export type AuthErrorCode = 'AUTH_TOKEN_EXPIRED' | 'AUTH_INVALID_TOKEN';

export class AuthTokenError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = 'AuthTokenError';
    this.code = code;
  }
}

export function createSupabaseAuthVerifier(config: SupabaseAuthVerifierConfig): AuthVerifier {
  const issuer = new URL(config.issuer).toString().replace(/\/$/, '');
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });

  return {
    async verify(accessToken) {
      try {
        const { payload } = await jwtVerify(accessToken, jwks, {
          issuer,
          audience: config.audience,
          algorithms: ['ES256', 'RS256'],
        });
        if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
          throw new AuthTokenError('AUTH_INVALID_TOKEN');
        }
        const email =
          typeof payload.email === 'string' && EMAIL.test(payload.email.trim())
            ? payload.email.trim().toLowerCase()
            : undefined;
        return {
          userId: payload.sub.toLowerCase(),
          ...(email === undefined ? {} : { email }),
        };
      } catch (error) {
        if (error instanceof AuthTokenError) {
          throw error;
        }
        if (error instanceof errors.JWTExpired) {
          throw new AuthTokenError('AUTH_TOKEN_EXPIRED');
        }
        throw new AuthTokenError('AUTH_INVALID_TOKEN');
      }
    },
  };
}
