import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TenantRepository } from '../tenant/repository.js';
import { AuthTokenError, type AuthVerifier } from './verifier.js';

export type PublicPrincipal = { kind: 'public' };
export type BuyerPrincipal = {
  kind: 'authenticated';
  userId: string;
  email?: string;
};
export type Principal = PublicPrincipal | BuyerPrincipal;

export const publicPrincipal: PublicPrincipal = Object.freeze({ kind: 'public' });

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

function authenticationError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: string,
): FastifyReply {
  return reply.status(401).send({ error, requestId: request.id });
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1];
}

export async function registerAuthContext(
  app: FastifyInstance,
  verifier: AuthVerifier,
  repository: TenantRepository,
): Promise<void> {
  const principals = new WeakMap<FastifyRequest, Principal>();
  app.decorateRequest('principal', {
    getter() {
      return principals.get(this) ?? publicPrincipal;
    },
    setter(value) {
      principals.set(this, value);
    },
  });
  app.addHook('preValidation', async (request, reply) => {
    request.principal = publicPrincipal;
    const authorization = request.headers.authorization;
    if (!authorization) {
      return;
    }
    const token = bearerToken(authorization);
    if (!token) {
      return authenticationError(reply, request, 'AUTH_INVALID_TOKEN');
    }
    try {
      const identity = await verifier.verify(token);
      await repository.syncIdentity(identity);
      request.principal = {
        kind: 'authenticated',
        userId: identity.userId,
        ...(identity.email === undefined ? {} : { email: identity.email }),
      };
    } catch (error) {
      const code = error instanceof AuthTokenError ? error.code : 'AUTH_INVALID_TOKEN';
      return authenticationError(reply, request, code);
    }
  });
}

export function requireBuyer(
  request: FastifyRequest,
  reply: FastifyReply,
): BuyerPrincipal | undefined {
  if (request.principal.kind !== 'authenticated') {
    authenticationError(reply, request, 'AUTH_REQUIRED');
    return undefined;
  }
  return request.principal;
}

export async function requireBuyerPreValidation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  requireBuyer(request, reply);
}
