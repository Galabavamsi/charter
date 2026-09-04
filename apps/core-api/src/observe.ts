import { Langfuse } from 'langfuse';
import type { AppConfig } from '@charter/config';
import { PROMPT_VERSION } from '@charter/orchestrator';
import type { ToolTrace } from '@charter/orchestrator';

export type ObservedTurn = {
  conversationId: string;
  channel: 'text' | 'voice';
  input: string;
  reply: string;
  traces: ToolTrace[];
  quoteTotal: string | null;
};

function redactTraces(traces: ToolTrace[]) {
  return traces.map((row) => {
    const result =
      row.result && typeof row.result === 'object' ? (row.result as Record<string, unknown>) : {};
    const decision = result.decision;
    return {
      name: row.name,
      error: typeof result.error === 'string' ? result.error : null,
      decision:
        decision && typeof decision === 'object'
          ? {
              outcome: (decision as { outcome?: string }).outcome ?? null,
              reason: (decision as { reason?: string }).reason ?? null,
            }
          : null,
    };
  });
}

export async function observeTurn(config: AppConfig, turn: ObservedTurn): Promise<void> {
  if (config.CHARTER_ENV === 'test' || !config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY) {
    return;
  }
  const langfuse = new Langfuse({
    publicKey: config.LANGFUSE_PUBLIC_KEY,
    secretKey: config.LANGFUSE_SECRET_KEY,
    baseUrl: config.LANGFUSE_HOST || 'https://jp.cloud.langfuse.com',
  });
  const trace = langfuse.trace({
    name: 'concierge.turn',
    sessionId: turn.conversationId,
    input: turn.input,
    metadata: {
      promptVersion: PROMPT_VERSION,
      channel: turn.channel,
    },
  });
  const generation = trace.generation({
    name: 'fireworks',
    model: config.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4-flash-0731',
    input: turn.input,
    metadata: {
      tools: redactTraces(turn.traces),
      quoteTotal: turn.quoteTotal,
    },
  });
  generation.end({ output: turn.reply });
  await langfuse.flushAsync();
}

export { redactTraces };
