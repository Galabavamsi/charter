import { describe, expect, it } from 'vitest';
import {
  accessTokenExpiresWithin,
  buildTalkAssistant,
  coalesceSameTurnText,
  isTalkSessionActive,
  resolveVoiceModelBase,
  startVoiceCall,
  TALK_MAX_SECONDS,
  talkButtonLabel,
  upsertVoiceTranscript,
  joinVoiceFragments,
  voiceCallEndCopy,
  voiceEndedReason,
  voiceErrorCopy,
  voiceOrbState,
  voiceStatusCopy,
  voiceTranscriptFromMessage,
} from './voiceTalk';

function jwtWithExp(exp: number): string {
  const payload = btoa(JSON.stringify({ sub: 'buyer', exp }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

describe('talk voice UI state', () => {
  it('maps connecting, listening, speaking, and error into visible orb and copy', () => {
    expect(voiceOrbState('connecting')).toBe('connecting');
    expect(voiceOrbState('listening')).toBe('listening');
    expect(voiceOrbState('speaking')).toBe('composing');
    expect(voiceOrbState('error')).toBeNull();
    expect(voiceOrbState('idle')).toBeNull();
    expect(voiceStatusCopy('connecting')).toBe('Connecting voice…');
    expect(voiceStatusCopy('listening')).toBe('Listening. Pause is fine — same tools as chat.');
    expect(voiceStatusCopy('speaking')).toBe('Speaking…');
    expect(voiceStatusCopy('error', 'VAPI_NOT_READY')).toMatch(/isn’t set up/);
    expect(voiceStatusCopy('error', 'VOICE_PUBLIC_URL_MISSING')).toMatch(/isn’t set up/);
    expect(voiceStatusCopy('error', 'VOICE_AUTH_REQUIRED')).toBe('Sign in again to use Talk.');
    expect(voiceStatusCopy('error', null)).toBe('Voice dropped. Tap Talk to retry, or type.');
    expect(voiceStatusCopy('error', 'Microphone permission denied. Allow the mic to Talk.')).toBe(
      'Microphone permission denied. Allow the mic to Talk.',
    );
    expect(talkButtonLabel('idle')).toBe('Talk');
    expect(talkButtonLabel('connecting')).toBe('Stop');
    expect(talkButtonLabel('listening')).toBe('Stop');
    expect(isTalkSessionActive('listening')).toBe(true);
    expect(isTalkSessionActive('error')).toBe(false);
  });

  it('uses clear copy for mic denial and missing Vapi config', () => {
    expect(
      voiceErrorCopy({ error: { type: 'NotAllowedError', message: 'Permission denied' } }),
    ).toBe('Microphone permission denied. Allow the mic to Talk.');
    expect(voiceErrorCopy(new DOMException('Permission denied', 'NotAllowedError'))).toBe(
      'Microphone permission denied. Allow the mic to Talk.',
    );
    expect(voiceErrorCopy({ type: 'audio-start-failed' })).toMatch(/playback/i);
    expect(voiceErrorCopy({ message: 'invalid public key' })).toBe('VAPI_NOT_READY');
    expect(voiceErrorCopy(new Error('VOICE_CONNECT_TIMEOUT'))).toMatch(/microphone/i);
    expect(
      voiceErrorCopy({
        message: [
          'assistant.startSpeakingPlan.each value in customEndpointingRules.type must be one of the following values: assistant, customer, both',
        ],
      }),
    ).toMatch(/customer/);
  });
});

describe('talk voice connection helpers', () => {
  it('prefers the live https origin so Vapi can reach this host', () => {
    expect(
      resolveVoiceModelBase(
        'https://stale.example/api/v1/voice',
        'https://core-api-production-087b.up.railway.app',
      ),
    ).toBe('https://core-api-production-087b.up.railway.app/api/v1/voice');
    expect(
      resolveVoiceModelBase('https://charter.example/api/v1/voice', 'http://localhost:5173'),
    ).toBe('https://charter.example/api/v1/voice');
    expect(resolveVoiceModelBase('', 'http://127.0.0.1:3000')).toBeNull();
  });

  it('explains why a Talk call ended and when the buyer token needs a refresh', () => {
    expect(
      voiceEndedReason({
        type: 'status-update',
        status: 'ended',
        endedReason: 'exceeded-max-duration',
      }),
    ).toBe('exceeded-max-duration');
    expect(voiceEndedReason({ type: 'transcript', endedReason: 'x' })).toBeNull();
    expect(voiceCallEndCopy('exceeded-max-duration')).toBe(
      'Talk sessions end after 3 minutes. Tap Talk to keep going.',
    );
    expect(voiceCallEndCopy(null)).toBe('Voice stopped.');
    const now = Date.UTC(2026, 9, 15);
    expect(accessTokenExpiresWithin(jwtWithExp(now / 1000 + 120), TALK_MAX_SECONDS + 60, now)).toBe(
      true,
    );
    expect(
      accessTokenExpiresWithin(jwtWithExp(now / 1000 + 3600), TALK_MAX_SECONDS + 60, now),
    ).toBe(false);
    expect(accessTokenExpiresWithin('not-a-jwt', 240, now)).toBe(false);
  });

  it('times out a hung Vapi start', async () => {
    await expect(startVoiceCall(() => new Promise(() => undefined), 20)).rejects.toThrow(
      'VOICE_CONNECT_TIMEOUT',
    );
  });
});

describe('talk transcript upsert', () => {
  it('ignores non-final Vapi messages and maps user/assistant finals into the chat thread', () => {
    expect(
      voiceTranscriptFromMessage({
        type: 'transcript',
        role: 'user',
        transcriptType: 'partial',
        transcript: 'add the ste',
      }),
    ).toBeNull();
    expect(
      voiceTranscriptFromMessage({
        type: 'speech-update',
        role: 'assistant',
        transcript: 'Hello',
      }),
    ).toBeNull();
    expect(
      voiceTranscriptFromMessage({
        type: 'transcript',
        role: 'user',
        transcriptType: 'final',
        transcript: 'Add the steel travel press',
      }),
    ).toEqual({
      role: 'you',
      text: 'Add the steel travel press',
      source: 'voice',
    });
    expect(
      voiceTranscriptFromMessage({
        type: "transcript[transcriptType='final']",
        role: 'assistant',
        transcript: 'Pay **₹2,347.00** when you are ready.',
      }),
    ).toEqual({
      role: 'concierge',
      text: 'Pay **₹2,347.00** when you are ready.',
      source: 'voice',
    });
    expect(
      voiceTranscriptFromMessage({
        type: 'transcript',
        role: 'assistant',
        transcriptType: 'final',
        transcript: 'Mm.',
      }),
    ).toBeNull();
  });

  it('keeps a hold reply out of the thread so split user fragments merge', () => {
    const first = voiceTranscriptFromMessage({
      type: 'transcript',
      role: 'user',
      transcriptType: 'final',
      transcript: 'Add the',
    });
    const hold = voiceTranscriptFromMessage({
      type: 'transcript',
      role: 'assistant',
      transcriptType: 'final',
      transcript: 'Mm.',
    });
    const second = voiceTranscriptFromMessage({
      type: 'transcript',
      role: 'user',
      transcriptType: 'final',
      transcript: 'steel travel press',
    });
    expect(hold).toBeNull();
    const merged = upsertVoiceTranscript(upsertVoiceTranscript([], first!, 1_000), second!, 3_000);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ role: 'you', text: 'Add the steel travel press' });
  });

  it('replaces a growing same-turn voice bubble and appends a new turn', () => {
    const first = upsertVoiceTranscript([], {
      role: 'you',
      text: 'Add the',
      source: 'voice',
    });
    const grown = upsertVoiceTranscript(first, {
      role: 'you',
      text: 'Add the steel travel press',
      source: 'voice',
    });
    expect(grown).toEqual([
      { role: 'you', text: 'Add the steel travel press', source: 'voice', at: expect.any(Number) },
    ]);
    const withReply = upsertVoiceTranscript(grown, {
      role: 'concierge',
      text: 'Try the **Steel travel press**.',
      source: 'voice',
    });
    expect(withReply).toHaveLength(2);
    const duplicate = upsertVoiceTranscript(withReply, {
      role: 'concierge',
      text: 'Try the **Steel travel press**.',
      source: 'voice',
    });
    expect(duplicate).toBe(withReply);
    const nextUser = upsertVoiceTranscript(withReply, {
      role: 'you',
      text: 'Checkout',
      source: 'voice',
    });
    expect(nextUser.at(-1)).toEqual({
      role: 'you',
      text: 'Checkout',
      source: 'voice',
      at: expect.any(Number),
    });
    const afterPay = upsertVoiceTranscript(
      [
        ...withReply,
        {
          role: 'concierge',
          text: 'Payment captured. One Charter order; inventory will commit once.',
        },
      ],
      { role: 'concierge', text: 'Anything else?', source: 'voice' },
    );
    expect(afterPay).toHaveLength(4);
  });

  it('coalesces fragmented lock-total transcripts into one shopper bubble', () => {
    const now = 1_700_000_000_000;
    const fragments = [
      'So we can log the total—',
      "Uh, let's log the total.",
      "Let's log the total.",
      "Okay, let's pick the.",
      'Amount.',
      'Checkout.',
    ];
    let messages: Array<{
      role: 'you' | 'concierge';
      text: string;
      source?: 'voice';
      at?: number;
    }> = [];
    for (const [index, text] of fragments.entries()) {
      messages = upsertVoiceTranscript(
        messages,
        { role: 'you', text, source: 'voice' },
        now + index * 400,
      );
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('you');
    expect(messages[0]?.text).toMatch(/log the total/i);
    expect(messages[0]?.text).toMatch(/Checkout/i);
    expect(messages[0]?.text).not.toBe('Checkout.');
    expect(joinVoiceFragments("Uh, let's log the total.", "Let's log the total.")).toBe(
      "Uh, let's log the total.",
    );
  });

  it('joins spoken concierge fragments into one bubble, including split amounts', () => {
    const now = 1_700_000_000_000;
    const fragments = [
      'Your total is locked at RS1997.',
      'For.',
      'Assorted chocolate box.',
      'RS9.',
      '97.',
      'You can change the quantity on any product card, and when the cart.',
      'Looks right, just say "buy.',
      'Now" to lock this total.',
    ];
    let messages: Array<{
      role: 'you' | 'concierge';
      text: string;
      source?: 'voice';
      at?: number;
    }> = [];
    for (const [index, text] of fragments.entries()) {
      messages = upsertVoiceTranscript(
        messages,
        { role: 'concierge', text, source: 'voice' },
        now + index * 300,
      );
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toMatch(/Assorted chocolate box/i);
    expect(messages[0]?.text).toMatch(/RS997|RS1997|1997/);
    expect(messages[0]?.text).toMatch(/buy Now/i);
    expect(joinVoiceFragments('RS9.', '97.')).toBe('RS997.');
    expect(joinVoiceFragments('Change quantity on the card, if.', 'You need to.')).toMatch(
      /card, if You need to/i,
    );
    expect(joinVoiceFragments('Looks right, just say "buy.', 'Now" to lock this total.')).toBe(
      'Looks right, just say "buy Now" to lock this total.',
    );
  });

  it('keeps a longer money-truth concierge bubble when a truncated voice final arrives', () => {
    const money = 'Pay **₹2,347.00** when you are ready. One Charter order.';
    const longer = upsertVoiceTranscript([], {
      role: 'concierge',
      text: money,
      source: 'voice',
    });
    expect(
      upsertVoiceTranscript(longer, {
        role: 'concierge',
        text: 'Pay **₹2,347.00**',
        source: 'voice',
      }),
    ).toEqual(longer);
    expect(coalesceSameTurnText(money, 'Pay **₹2,347.00**')).toBe('keep');
  });

  it('dedupes poll SETTLED then spoken voice final regardless of source', () => {
    const copy = 'Payment captured. One Charter order; inventory will commit once.';
    const polled = [{ role: 'concierge' as const, text: copy }];
    expect(
      upsertVoiceTranscript(polled, { role: 'concierge', text: copy, source: 'voice' }),
    ).toEqual(polled);
    const spokenLong = upsertVoiceTranscript([{ role: 'concierge', text: 'Payment captured.' }], {
      role: 'concierge',
      text: copy,
      source: 'voice',
    });
    expect(spokenLong).toEqual([
      expect.objectContaining({ role: 'concierge', text: copy, source: 'voice' }),
    ]);
  });
});

describe('talk assistant session config', () => {
  it('enables interruption, English STT, custom LLM auth, and shop slug metadata without streaming theater', () => {
    const assistant = buildTalkAssistant({
      merchantName: 'Northstar Travel Coffee',
      conversationId: '82000000-0000-4000-8000-000000000001',
      voiceModelBase: 'https://charter.example/api/v1/voice',
      shopSlug: 'northstar',
      accessToken: 'buyer-access-token',
    });
    expect(assistant.firstMessage).toBe(
      'Charter Concierge for Northstar Travel Coffee. What do you need?',
    );
    expect(assistant.firstMessageInterruptionsEnabled).toBe(true);
    expect(assistant.transcriber).toEqual({
      provider: 'deepgram',
      model: 'nova-3',
      language: 'en-IN',
      fallbackPlan: { transcribers: [{ provider: 'vapi', language: 'en' }] },
    });
    expect(assistant.maxDurationSeconds).toBe(180);
    expect(assistant.silenceTimeoutSeconds).toBe(30);
    expect(assistant.startSpeakingPlan).toMatchObject({
      waitSeconds: 0.55,
      smartEndpointingPlan: { provider: 'livekit' },
      customEndpointingRules: [{ type: 'customer' }],
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.8,
        onNoPunctuationSeconds: 1.6,
        onNumberSeconds: 1.2,
      },
    });
    expect(assistant.stopSpeakingPlan).toMatchObject({
      numWords: 1,
      voiceSeconds: 0.25,
      acknowledgementPhrases: expect.arrayContaining(['uh', 'um', 'okay']),
    });
    expect(assistant.model).toMatchObject({
      provider: 'custom-llm',
      url: 'https://charter.example/api/v1/voice/82000000-0000-4000-8000-000000000001',
      metadataSendMode: 'destructured',
      timeoutSeconds: 60,
      headers: { 'X-Charter-Shop-Slug': 'northstar' },
    });
    expect(assistant.credentials).toEqual([
      { provider: 'custom-llm', apiKey: 'buyer-access-token' },
    ]);
    expect(assistant.metadata).toEqual({ shopSlug: 'northstar' });
    expect(assistant.voice).toEqual({
      provider: 'vapi',
      voiceId: 'Naina',
      version: 2,
      fallbackPlan: { voices: [{ provider: 'vapi', voiceId: 'Elliot' }] },
    });
    expect(JSON.stringify(assistant.model)).not.toContain('stream:true');
  });
});
