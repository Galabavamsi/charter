import { FIREWORKS_DEFAULT_MODEL, TOOL_DEFINITIONS, type ChatMessage } from '../domain/index.js';

export type FireworksClient = {
  complete(messages: ChatMessage[]): Promise<ChatMessage>;
};

type FireworksResponse = {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

export const FIREWORKS_TIMEOUT_MS = 8_000;

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
      const toolCalls = (message.tool_calls ?? [])
        .filter((row) => row.id && row.function?.name)
        .map((row) => ({
          id: row.id as string,
          type: 'function' as const,
          function: {
            name: row.function?.name as string,
            arguments: row.function?.arguments ?? '{}',
          },
        }));
      return {
        role: 'assistant' as const,
        content: message.content ?? null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    },
  };
}
