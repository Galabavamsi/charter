import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthTokenError, createSupabaseAuthVerifier } from './verifier.js';

const issuer = 'https://example.supabase.co/auth/v1';
const audience = 'authenticated';
const subject = '51000000-0000-4000-8000-000000000001';

describe('Supabase access-token verifier', () => {
  let server: Server;
  let jwksUrl: string;
  let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    signingKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [{ ...publicJwk, alg: 'ES256', kid: 'current' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('TEST_JWKS_ADDRESS_UNAVAILABLE');
    }
    jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function token(
    overrides: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ): Promise<string> {
    return new SignJWT({
      email: 'Buyer@Example.com',
      role: 'service_role',
      tenantId: 'forged-tenant',
      user_metadata: { role: 'admin' },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'current' })
      .setSubject(subject)
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? '5m')
      .sign(signingKey);
  }

  it('accepts the current issuer, audience, and remote JWKS while projecting only identity claims', async () => {
    const verifier = createSupabaseAuthVerifier({ issuer, audience, jwksUrl });

    await expect(verifier.verify(await token())).resolves.toEqual({
      userId: subject,
      email: 'buyer@example.com',
    });
  });

  it('rejects expired access tokens with a stable authentication code', async () => {
    const verifier = createSupabaseAuthVerifier({ issuer, audience, jwksUrl });

    await expect(verifier.verify(await token({ expiresIn: '-1s' }))).rejects.toEqual(
      new AuthTokenError('AUTH_TOKEN_EXPIRED'),
    );
  });

  it('rejects tokens signed by an untrusted key or issued for another audience', async () => {
    const verifier = createSupabaseAuthVerifier({ issuer, audience, jwksUrl });
    const forgedPair = await generateKeyPair('ES256');
    const forged = await new SignJWT({ email: 'buyer@example.com' })
      .setProtectedHeader({ alg: 'ES256', kid: 'forged' })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(forgedPair.privateKey);

    await expect(verifier.verify(forged)).rejects.toEqual(new AuthTokenError('AUTH_INVALID_TOKEN'));
    await expect(verifier.verify(await token({ audience: 'service_role' }))).rejects.toEqual(
      new AuthTokenError('AUTH_INVALID_TOKEN'),
    );
  });
});
