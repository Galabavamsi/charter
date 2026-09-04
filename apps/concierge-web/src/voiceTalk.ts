import type { ProcessState } from './ProcessOrb';
import type { ChatMessage } from './threads';

export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

export type VoiceTranscriptEvent = {
  type?: unknown;
  role?: unknown;
  transcriptType?: unknown;
  transcript?: unknown;
};

export function isTalkSessionActive(phase: VoicePhase): boolean {
  return phase === 'connecting' || phase === 'listening' || phase === 'speaking';
}

export function talkButtonLabel(phase: VoicePhase): 'Talk' | 'Stop' {
  return isTalkSessionActive(phase) ? 'Stop' : 'Talk';
}

export function voiceOrbState(phase: VoicePhase): ProcessState | null {
  if (phase === 'connecting') {
    return 'connecting';
  }
  if (phase === 'listening') {
    return 'listening';
  }
  if (phase === 'speaking') {
    return 'composing';
  }
  if (phase === 'error') {
    return 'solving';
  }
  return null;
}

export function voiceStatusCopy(phase: VoicePhase, error?: string | null): string {
  if (phase === 'connecting') {
    return 'Connecting voice…';
  }
  if (phase === 'listening') {
    return 'Listening. Pause is fine — same tools as chat.';
  }
  if (phase === 'speaking') {
    return 'Speaking…';
  }
  if (phase === 'error') {
    return error?.trim() || 'VOICE_ERROR';
  }
  return 'Voice stopped.';
}

function errorBlob(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return `${error.name} ${error.message}`;
  }
  if (!error || typeof error !== 'object') {
    return '';
  }
  const record = error as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : null;
  const parts = [
    record.message,
    record.errorMsg,
    record.errorMessage,
    nested?.message,
    nested?.msg,
    nested?.type,
    record.type,
    record.action,
  ];
  return parts.filter((part): part is string => typeof part === 'string').join(' ');
}

export function voiceErrorCopy(error: unknown): string {
  const text = errorBlob(error);
  if (
    /notallowederror|permission denied|mic(rophone)? (permission )?denied|notallowed/i.test(text)
  ) {
    return 'Microphone permission denied. Allow the mic to Talk.';
  }
  if (/audio-start-failed|autoplay/i.test(text)) {
    return 'Browser blocked voice playback. Tap Talk again after interacting with the page.';
  }
  if (/not.?ready|public.?key|invalid.?key/i.test(text)) {
    return 'VAPI_NOT_READY';
  }
  if (/VOICE_PUBLIC_URL_MISSING|public.?url/i.test(text)) {
    return 'VOICE_PUBLIC_URL_MISSING';
  }
  if (/VOICE_CONNECT_TIMEOUT/i.test(text)) {
    return 'Voice did not connect. Allow the microphone and try Talk again.';
  }
  return 'VOICE_ERROR';
}

export function resolveVoiceModelBase(
  configured: string | null | undefined,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
): string | null {
  const fromConfig = configured?.trim() ?? '';
  const local = /localhost|127\.0\.0\.1/i.test(origin);
  if (/^https:\/\//i.test(origin) && !local) {
    return `${origin.replace(/\/$/, '')}/api/v1/voice`;
  }
  return fromConfig || null;
}

export async function requestTalkMicrophone(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function startVoiceCall(
  start: () => Promise<unknown>,
  timeoutMs = 20_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('VOICE_CONNECT_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function voiceTranscriptFromMessage(event: VoiceTranscriptEvent): ChatMessage | null {
  const type = typeof event.type === 'string' ? event.type : '';
  const isTranscript = type === 'transcript' || type === "transcript[transcriptType='final']";
  if (!isTranscript) {
    return null;
  }
  const isFinal = event.transcriptType === 'final' || type === "transcript[transcriptType='final']";
  if (!isFinal) {
    return null;
  }
  const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
  if (!text) {
    return null;
  }
  if (event.role === 'user') {
    return { role: 'you', text, source: 'voice' };
  }
  if (event.role === 'assistant') {
    return { role: 'concierge', text, source: 'voice' };
  }
  return null;
}

const VOICE_USER_COALESCE_MS = 8_000;

function normalizeVoiceUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[—–….,!?]+/g, ' ')
    .replace(/\b(uh+|um+|erm|okay|ok|so)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function joinVoiceFragments(lastText: string, nextText: string): string {
  const last = lastText.trim();
  const next = nextText.trim();
  if (!last) {
    return next;
  }
  if (!next) {
    return last;
  }
  const lastNorm = normalizeVoiceUtterance(last);
  const nextNorm = normalizeVoiceUtterance(next);
  if (nextNorm && lastNorm.includes(nextNorm)) {
    return last;
  }
  if (lastNorm && nextNorm.includes(lastNorm)) {
    return next;
  }
  return `${last} ${next}`.replace(/\s+/g, ' ');
}

/** Same turn if texts match or one is a prefix of the other. Never shrink. */
export function coalesceSameTurnText(
  lastText: string,
  nextText: string,
): 'keep' | 'replace' | 'append' {
  const last = lastText.trim();
  const next = nextText.trim();
  if (!last || !next) {
    return 'append';
  }
  if (next === last || last.startsWith(next)) {
    return 'keep';
  }
  if (next.startsWith(last)) {
    return 'replace';
  }
  return 'append';
}

export function upsertVoiceTranscript(
  messages: ChatMessage[],
  next: ChatMessage,
  now = Date.now(),
): ChatMessage[] {
  const stamped =
    next.role === 'you' && next.source === 'voice' ? { ...next, at: next.at ?? now } : next;
  const last = messages.at(-1);
  if (!last || last.role !== stamped.role) {
    return [...messages, stamped];
  }
  const conciergeAnySource = last.role === 'concierge';
  if (!conciergeAnySource && (last.source !== 'voice' || stamped.source !== 'voice')) {
    return [...messages, stamped];
  }
  const decision = coalesceSameTurnText(last.text, stamped.text);
  if (decision === 'keep') {
    return messages;
  }
  if (decision === 'replace') {
    return [...messages.slice(0, -1), stamped];
  }
  const liveUserVoice =
    last.role === 'you' &&
    stamped.role === 'you' &&
    last.source === 'voice' &&
    stamped.source === 'voice' &&
    last.at != null &&
    now - last.at < VOICE_USER_COALESCE_MS;
  if (liveUserVoice) {
    const text = joinVoiceFragments(last.text, stamped.text);
    if (text === last.text) {
      return messages;
    }
    return [...messages.slice(0, -1), { role: 'you', text, source: 'voice', at: now }];
  }
  return [...messages, stamped];
}

export function buildTalkAssistant(input: {
  merchantName: string;
  conversationId: string;
  voiceModelBase: string;
  shopSlug: string;
  accessToken: string;
}): Record<string, unknown> {
  return {
    name: 'Charter Concierge',
    firstMessage: `Charter Concierge for ${input.merchantName}. What do you need?`,
    firstMessageInterruptionsEnabled: true,
    transcriber: {
      provider: 'vapi',
      language: 'en',
    },
    model: {
      provider: 'custom-llm',
      model: 'charter-concierge',
      url: `${input.voiceModelBase.replace(/\/$/, '')}/${input.conversationId}`,
      metadataSendMode: 'destructured',
      timeoutSeconds: 60,
      headers: {
        'X-Charter-Shop-Slug': input.shopSlug,
      },
    },
    voice: {
      provider: 'vapi',
      voiceId: 'Elliot',
    },
    credentials: [{ provider: 'custom-llm', apiKey: input.accessToken }],
    metadata: { shopSlug: input.shopSlug },
    clientMessages: ['transcript', 'speech-update', 'status-update'],
    startSpeakingPlan: {
      waitSeconds: 0.55,
      smartEndpointingPlan: {
        provider: 'livekit',
        waitFunction: '(20 + 500 * sqrt(x) + 2500 * x^3 + 700 + 4000 * max(0, x-0.5)) / 2',
      },
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.8,
        onNoPunctuationSeconds: 1.6,
        onNumberSeconds: 1.2,
      },
      customEndpointingRules: [
        {
          type: 'user',
          regex:
            "(?i)(\\b(the|a|an|to|and|or|for|of|uh|um|so|let's)\\s*[.?!]*$)|[\u2014\u2013\u2026-]$",
          timeoutSeconds: 2.2,
        },
      ],
    },
    stopSpeakingPlan: {
      numWords: 1,
      voiceSeconds: 0.25,
      backoffSeconds: 0.8,
      acknowledgementPhrases: ['okay', 'ok', 'right', 'uh-huh', 'yeah', 'mm-hmm', 'uh', 'um'],
    },
    maxDurationSeconds: 600,
  };
}
