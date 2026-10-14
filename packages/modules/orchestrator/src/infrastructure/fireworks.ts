import { FIREWORKS_DEFAULT_MODEL, TOOL_DEFINITIONS, type ChatMessage } from '../domain/index.js';

/** Turn facts a scripted client needs and a live model ignores. */
export type ModelTurnContext = {
  /** A locked total existed before the shopper sent this message. */
  hadQuote: boolean;
};

export type FireworksClient = {
  complete(messages: ChatMessage[], context?: ModelTurnContext): Promise<ChatMessage>;
};

type FireworksResponse = {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: unknown };
      }>;
    };
  }>;
};

export const FIREWORKS_TIMEOUT_MS = 8_000;

/** Reasoning models can leak their scratchpad into content; never speak it. */
export function stripThinking(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim();
}

function toolArguments(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  return JSON.stringify(raw ?? {});
}

export function createFireworksClient(
  apiKey: string,
  model: string,
  httpFetch: typeof fetch = fetch,
  timeoutMs = FIREWORKS_TIMEOUT_MS,
): FireworksClient {
  const resolvedModel = model || FIREWORKS_DEFAULT_MODEL;
  return {
    async complete(messages) {
      const response = await httpFetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: resolvedModel,
          temperature: 0,
          max_tokens: 1024,
          messages,
          tools: TOOL_DEFINITIONS,
          tool_choice: 'auto',
        }),
      });
      if (!response.ok) {
        throw new Error(`FIREWORKS_HTTP_${response.status}`);
      }
      const body = (await response.json()) as FireworksResponse;
      const message = body.choices?.[0]?.message;
      if (!message) {
        throw new Error('FIREWORKS_EMPTY');
      }
      // Some models omit tool-call ids or send arguments as an object; keep the
      // call (with a synthetic id) instead of silently dropping the action.
      const stamp = Date.now().toString(36);
      const toolCalls = (message.tool_calls ?? [])
        .filter((row) => row.function?.name)
        .map((row, index) => ({
          id: row.id || `call_${index}_${stamp}`,
          type: 'function' as const,
          function: {
            name: row.function?.name as string,
            arguments: toolArguments(row.function?.arguments),
          },
        }));
      const content = typeof message.content === 'string' ? stripThinking(message.content) : '';
      return {
        role: 'assistant' as const,
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    },
  };
}
