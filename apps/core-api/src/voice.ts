import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@charter/config';
import { evictConversation } from '@charter/orchestrator';
import { RazorpayClient } from '@charter/razorpay';
import {
  conversationHooks,
  hydrateConversationMoney,
  persistConversationAfterTurn,
  runConversationTurn,
} from './conversations.js';
import type { MoneyPersist } from './persist.js';
import type { TenantRepository } from './tenant/repository.js';
import { hydratePersistedConversation } from './tenant/conversation-state.js';
import { hydrateCatalogCache } from './tenant/catalog-cache.js';
import { requireOwnedResource } from './auth/guards.js';
import { requireBuyer, requireBuyerPreValidation } from './auth/context.js';

type VoiceMessage = {
  role?: string;
  content?: unknown;
};

const SHOP_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const HANGING_VOICE =
  /(?:[—–\-…]|\b(?:the|a|an|to|and|or|for|of|uh+|um+|erm|so|let's))\s*[.!?]*$/iu;
const COMPLETE_VOICE_COMMAND =
  /^(yes|y|ok|okay|sure|please|pay|checkout|proceed|hello|hi|hey)(\s+please)?$/iu;
const LOCK_OR_PAY = /\b(lock this total|log the total|pay now|proceed to payment|razorpay)\b/iu;

export const VOICE_HOLD_REPLY = 'Mm.';

export function isIncompleteVoiceUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  if (/[—–…]$/u.test(trimmed) || /-$/u.test(trimmed)) {
    return true;
  }
  const stripped = trimmed.replace(/[.!?]+$/u, '').trim();
  if (COMPLETE_VOICE_COMMAND.test(stripped) || LOCK_OR_PAY.test(stripped)) {
    return false;
  }
  const words = stripped.split(/\s+/u).filter(Boolean);
  if (words.length <= 2 && /^(amount|total|the|and|or|to|of|uh+|um+|okay|ok)$/iu.test(stripped)) {
    return true;
  }
  return HANGING_VOICE.test(stripped);
}

export function resolveVoiceShopSlug(input: {
  body?: Record<string, unknown> | null;
  header?: string | string[] | undefined;
  query?: unknown;
}): string | undefined {
  const candidates: unknown[] = [];
  const body = input.body;
  if (body && typeof body === 'object') {
    candidates.push(body.shopSlug);
    const metadata = body.metadata;
    if (metadata && typeof metadata === 'object' && metadata !== null && 'shopSlug' in metadata) {
      candidates.push((metadata as { shopSlug?: unknown }).shopSlug);
    }
  }
  if (typeof input.header === 'string') {
    candidates.push(input.header);
  } else if (Array.isArray(input.header)) {
    candidates.push(...input.header);
  }
  if (
    input.query &&
    typeof input.query === 'object' &&
    input.query !== null &&
    'shopSlug' in input.query
  ) {
    candidates.push((input.query as { shopSlug?: unknown }).shopSlug);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const slug = candidate.trim();
    if (slug.length >= 1 && slug.length <= 64 && SHOP_SLUG_PATTERN.test(slug)) {
      return slug;
    }
  }
  return undefined;
}

function lastUserText(messages: VoiceMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }
    if (typeof message.content === 'string') {
      return message.content.trim();
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          if (typeof part === 'string') {
            return part;
          }
          if (part && typeof part === 'object' && 'text' in part) {
            return String((part as { text?: string }).text ?? '');
          }
          return '';
        })
        .join(' ')
        .trim();
    }
  }
  return '';
}

function completionPayload(content: string, stream: boolean, requestId: string) {
  const id = `chatcmpl_${randomUUID()}`;
  if (!stream) {
    return {
      id,
      requestId,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
  }
  return {
    id,
    requestId,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
}

export async function registerVoiceRoutes(
  app: FastifyInstance,
  config: AppConfig,
  razorpay: RazorpayClient | null,
  repository: TenantRepository,
  persist?: MoneyPersist,
): Promise<void> {
  app.post(
    '/v1/voice/:conversationId/chat/completions',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['conversationId'],
          properties: { conversationId: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          additionalProperties: true,
          properties: {
            shopSlug: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            },
          },
        },
        body: {
          type: 'object',
          additionalProperties: true,
          properties: {
            shopSlug: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            },
            stream: { type: 'boolean' },
            messages: {
              type: 'array',
              maxItems: 100,
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { conversationId } = request.params as { conversationId: string };
      const body = (request.body ?? {}) as {
        messages?: VoiceMessage[];
        stream?: boolean;
        shopSlug?: string;
      } & Record<string, unknown>;
      const buyer = requireBuyer(request, reply);
      if (!buyer) {
        return;
      }
      const shopSlug = resolveVoiceShopSlug({
        body,
        header: request.headers['x-charter-shop-slug'],
        query: request.query,
      });
      if (!shopSlug) {
        return reply.status(400).send({ error: 'SHOP_SLUG_REQUIRED' });
      }
      const shop = await repository.findShopBySlug(shopSlug);
      if (!shop) {
        return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'conversation',
        tenantId: shop.tenantId,
        resourceId: conversationId,
      });
      if (!principal) {
        return;
      }
      const base = await repository.loadConversation({
        id: conversationId,
        tenantId: shop.tenantId,
        userId: buyer.userId,
      });
      const conversation = base
        ? hydratePersistedConversation({
            id: conversationId,
            tenantId: shop.tenantId,
            ...base,
          })
        : undefined;
      if (!base || !conversation || shop.tenantId !== conversation.tenantId) {
        return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
      }
      await hydrateCatalogCache(repository, shop);
      await hydrateConversationMoney(conversation, persist);
      const hooks = conversationHooks(config, razorpay, repository, principal.userId, persist, {
        requestId: request.id,
        tenantId: shop.tenantId,
        shopSlug: shop.slug,
        agentSource: 'concierge_voice',
      });
      const text = lastUserText(body.messages ?? []);
      let content = "Charter Concierge. I'm listening.";
      try {
        if (text && isIncompleteVoiceUtterance(text)) {
          content = VOICE_HOLD_REPLY;
        } else if (text) {
          content = (await runConversationTurn(config, conversation, text, hooks, 'voice')).reply;
        }
      } catch (error) {
        try {
          await persistConversationAfterTurn({
            repository,
            conversation,
            userId: principal.userId,
            base,
          });
        } catch (persistenceError) {
          if (
            persistenceError instanceof Error &&
            persistenceError.message === 'CONVERSATION_VERSION_CONFLICT'
          ) {
            evictConversation(conversation.id);
            return reply.status(409).send({ error: 'CONVERSATION_VERSION_CONFLICT' });
          }
          throw persistenceError;
        }
        throw error;
      }
      try {
        await persistConversationAfterTurn({
          repository,
          conversation,
          userId: principal.userId,
          base,
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'CONVERSATION_VERSION_CONFLICT') {
          evictConversation(conversation.id);
          return reply.status(409).send({ error: 'CONVERSATION_VERSION_CONFLICT' });
        }
        throw error;
      }
      // Vapi custom-LLM requests often set stream:true. Turns are still one-shot
      // (Fireworks + tools); this SSE is the OpenAI wire format, not token streaming.
      if (body.stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-request-id': request.id,
        });
        const chunk = completionPayload(content, true, request.id);
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        reply.raw.write(
          `data: ${JSON.stringify({
            id: chunk.id,
            requestId: request.id,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        return;
      }
      return completionPayload(content, false, request.id);
    },
  );
}
