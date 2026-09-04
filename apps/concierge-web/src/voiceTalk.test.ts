import { describe, expect, it } from 'vitest';
import {
  buildTalkAssistant,
  coalesceSameTurnText,
  isTalkSessionActive,
  resolveVoiceModelBase,
  startVoiceCall,
  talkButtonLabel,
  upsertVoiceTranscript,
  joinVoiceFragments,
  voiceErrorCopy,
  voiceOrbState,
  voiceStatusCopy,
  voiceTranscriptFromMessage,
} from './voiceTalk';

describe('talk voice UI state', () => {
  it('maps connecting, listening, speaking, and error into visible orb and copy', () => {
    expect(voiceOrbState('connecting')).toBe('connecting');
    expect(voiceOrbState('listening')).toBe('listening');
    expect(voiceOrbState('speaking')).toBe('composing');
    expect(voiceOrbState('error')).toBe('solving');
    expect(voiceOrbState('idle')).toBeNull();
    expect(voiceStatusCopy('connecting')).toBe('Connecting voice…');
    expect(voiceStatusCopy('listening')).toBe('Listening. Pause is fine — same tools as chat.');
    expect(voiceStatusCopy('speaking')).toBe('Speaking…');
    expect(voiceStatusCopy('error', 'VAPI_NOT_READY')).toBe('VAPI_NOT_READY');
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
    expect(spokenLong).toEqual([{ role: 'concierge', text: copy, source: 'voice' }]);
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
    expect(assistant.transcriber).toEqual({ provider: 'vapi', language: 'en' });
    expect(assistant.startSpeakingPlan).toMatchObject({
      waitSeconds: 0.55,
      smartEndpointingPlan: { provider: 'livekit' },
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
    expect(assistant.voice).toEqual({ provider: 'vapi', voiceId: 'Elliot' });
    expect(JSON.stringify(assistant.model)).not.toContain('stream:true');
  });
});
