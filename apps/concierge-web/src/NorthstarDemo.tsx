import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChatMarkdown } from './ChatMarkdown';
import { ApiError, apiFetch, fetchPendingConversationSnapshot, getAccessToken } from './api';
import {
  buyerFacingError,
  conciergeWorkCopy,
  orderConfirmedCopy,
  razorpayWorkCopy,
} from './buyer-session';
import { CatalogThumb } from './CatalogThumb';
import { MicIcon, SendIcon } from './ComposerIcons';
import { ProcessOrb, type ProcessState } from './ProcessOrb';
import { MentionedProducts, ShopShelf } from './ProductCards';
import {
  BROWSE_SHOP_LABEL,
  BUY_NOW_HINT,
  BUY_NOW_LABEL,
  VIEW_CART_HINT,
  VIEW_CART_LABEL,
  buyNowPrompt,
  cartSnapshotFromTurn,
  cartShelfItems,
  displayQuantity,
  pickCount,
  picksDifferFromCart,
  picksFromCart,
  shouldOfferLockTotal,
  type CartPick,
} from './chat-actions';
import { resolveCatalogItem } from './catalog-visuals';
import {
  consumePendingTurn,
  getThread,
  openingThreadMessages,
  titleFrom,
  upsertThread,
  type ChatMessage,
  type StoredCart,
  type StoredQuote,
} from './threads';
import {
  buildTalkAssistant,
  coalesceSameTurnText,
  isTalkSessionActive,
  requestTalkMicrophone,
  resolveVoiceModelBase,
  startVoiceCall,
  talkButtonLabel,
  upsertVoiceTranscript,
  voiceErrorCopy,
  voiceOrbState,
  voiceStatusCopy,
  voiceTranscriptFromMessage,
  type VoicePhase,
} from './voiceTalk';

export function shouldSubmitComposerKey(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
}): boolean {
  if (event.key !== 'Enter' || event.shiftKey) {
    return false;
  }
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
    return false;
  }
  return true;
}

type Decision = { outcome: string; reason: string; message: string };
type Quote = StoredQuote;

type RecoveryAttempt = { action: string; reason?: string; messageId?: string };

type CheckoutSession = {
  id?: string;
  status: string;
  copy: string;
  paymentId: string | null;
  providerStatus: string | null;
  reconciliationOutcome?: string | null;
  retryAllowed?: boolean;
  recovery?: RecoveryAttempt | null;
};

export function shouldHideDirectPay(status: string | undefined): boolean {
  return (
    status === 'FAILED_PROVISIONAL' ||
    status === 'RECONCILING' ||
    status === 'CAPTURE_PENDING' ||
    status === 'SETTLED'
  );
}

export function shouldShowSameOrderRetry(outcome: string | null | undefined): boolean {
  return outcome === 'same_order_retry_safe';
}

export function shouldShowSameOrderRetryControl(
  status: string | undefined,
  outcome: string | null | undefined,
): boolean {
  if (!shouldShowSameOrderRetry(outcome)) {
    return false;
  }
  return status !== 'SETTLED' && status !== 'CAPTURE_PENDING' && status !== 'RECONCILING';
}

export function shouldRenderDirectPayButton(
  status: string | undefined,
  outcome: string | null | undefined,
): boolean {
  if (shouldShowSameOrderRetryControl(status, outcome)) {
    return true;
  }
  return !shouldHideDirectPay(status);
}

export function checkoutFromBlockedCode(
  code: string,
): Pick<
  CheckoutSession,
  'status' | 'copy' | 'providerStatus' | 'retryAllowed' | 'reconciliationOutcome'
> | null {
  if (code === 'PAYMENT_REFUNDED') {
    return {
      status: 'RECONCILING',
      copy: 'Payment not confirmed. Reconciling provider state.',
      providerStatus: 'refunded',
      retryAllowed: false,
      reconciliationOutcome: 'refunded',
    };
  }
  if (code === 'PAYMENT_AUTHORIZED') {
    return {
      status: 'CAPTURE_PENDING',
      copy: 'Awaiting capture. Authorized payment is not fulfilled and cannot be retried.',
      providerStatus: 'authorized',
      retryAllowed: false,
      reconciliationOutcome: 'authorized',
    };
  }
  if (code === 'QUOTE_ALREADY_PAID') {
    return {
      status: 'SETTLED',
      copy: 'Payment captured. One Charter order; inventory will commit once.',
      providerStatus: 'captured',
      retryAllowed: false,
      reconciliationOutcome: 'captured',
    };
  }
  return null;
}

export function withPaymentThreadMessage(
  messages: ChatMessage[],
  session: Pick<CheckoutSession, 'status' | 'copy'>,
): ChatMessage[] {
  if (
    session.status !== 'SETTLED' &&
    session.status !== 'FAILED_PROVISIONAL' &&
    session.status !== 'RECONCILING' &&
    session.status !== 'CAPTURE_PENDING'
  ) {
    return messages;
  }
  const text = session.copy.trim();
  if (!text) {
    return messages;
  }
  const last = messages.at(-1);
  if (last?.role === 'concierge') {
    const decision = coalesceSameTurnText(last.text, text);
    if (decision === 'keep') {
      return messages;
    }
    if (decision === 'replace') {
      return [...messages.slice(0, -1), { role: 'concierge', text }];
    }
  }
  return [...messages, { role: 'concierge', text }];
}

export function FrozenQuotePayButtons({
  quoteDisplay,
  pay,
  onPay,
  onCheckStatus,
}: {
  quoteDisplay: string;
  pay: CheckoutSession | null;
  onPay(): void;
  onCheckStatus(): void;
}) {
  const retry = shouldShowSameOrderRetryControl(pay?.status, pay?.reconciliationOutcome);
  return (
    <>
      {shouldRenderDirectPayButton(pay?.status, pay?.reconciliationOutcome) ? (
        <button type="button" onClick={onPay}>
          {retry ? 'Retry same order' : `Pay ${quoteDisplay}`}
        </button>
      ) : null}
      {pay?.status === 'FAILED_PROVISIONAL' && !retry ? (
        <button type="button" onClick={onCheckStatus}>
          Check payment status
        </button>
      ) : null}
    </>
  );
}

type CheckoutLaunch = {
  checkoutId: string;
  keyId?: string;
  orderId: string;
  amount: number;
  currency: string;
  name?: string;
  description?: string;
  status?: string;
  retryAllowed?: boolean;
  reconciliationOutcome?: string | null;
  copy?: string;
};

type Trace = {
  name: string;
  result: { decision?: Decision; proposedDisplay?: string; error?: string };
};

type DemoProps = {
  userId: string;
  email: string;
  tenantId: string;
  shopSlug: string;
  merchantName: string;
  threadId: string | null;
  seededMessages?: ChatMessage[];
  initialDraft?: string;
  autoSend?: boolean;
  onBound: (id: string) => void;
  onHistory: () => void;
};

type VoiceClient = {
  start(options: Record<string, unknown>): Promise<unknown>;
  stop(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function razorpayScript(): HTMLScriptElement {
  const existing = document.querySelector<HTMLScriptElement>('script[data-charter-razorpay="1"]');
  if (existing) {
    return existing;
  }
  const script = document.createElement('script');
  script.src = RAZORPAY_CHECKOUT_SRC;
  script.async = true;
  script.dataset.charterRazorpay = '1';
  script.addEventListener(
    'error',
    () => {
      script.dataset.charterRazorpayFailed = '1';
    },
    { once: true },
  );
  document.head.appendChild(script);
  return script;
}

async function loadRazorpay(): Promise<void> {
  if (window.Razorpay) {
    return;
  }
  const script = razorpayScript();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (window.Razorpay) {
      return;
    }
    if (script.dataset.charterRazorpayFailed === '1') {
      throw new Error('CHECKOUT_SCRIPT_FAILED');
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 50);
    });
  }
  throw new Error('CHECKOUT_SCRIPT_FAILED');
}

export function NorthstarDemo({
  userId,
  email,
  tenantId,
  shopSlug,
  merchantName,
  threadId,
  seededMessages = [],
  initialDraft = '',
  autoSend = false,
  onBound,
  onHistory,
}: DemoProps) {
  const [status, setStatus] = useState('Ready.');
  const [process, setProcess] = useState<ProcessState | null>(null);
  const [pay, setPay] = useState<CheckoutSession | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(() =>
    threadId ? (getThread({ userId, shopId: tenantId }, threadId)?.conversationId ?? null) : null,
  );
  const [localId, setLocalId] = useState<string | null>(threadId);
  const [draft, setDraft] = useState(initialDraft);
  const [log, setLog] = useState<ChatMessage[]>(() =>
    openingThreadMessages(userId, tenantId, threadId, seededMessages),
  );
  const [quote, setQuote] = useState<Quote | null>(() =>
    threadId ? (getThread({ userId, shopId: tenantId }, threadId)?.quote ?? null) : null,
  );
  const [cart, setCart] = useState<StoredCart | null>(() =>
    threadId ? (getThread({ userId, shopId: tenantId }, threadId)?.cart ?? null) : null,
  );
  const [picks, setPicks] = useState<Record<string, CartPick>>({});
  const [shelf, setShelf] = useState<'browse' | 'cart' | null>(null);
  const [shelfQuery, setShelfQuery] = useState('');
  const [traces, setTraces] = useState<Trace[]>([]);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [voiceReady, setVoiceReady] = useState(false);
  const [, setRecoveryReady] = useState(false);
  const [recoveryWanted, setRecoveryWanted] = useState(false);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const [shop, setShop] = useState<
    Array<{ sku: string; title: string; priceDisplay: string; stock: number; material?: string }>
  >([]);
  const vapiRef = useRef<VoiceClient | null>(null);
  const talkPoll = useRef<number | null>(null);
  const talkStarting = useRef(false);
  const talkGeneration = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const autoSendStarted = useRef(false);
  const sendingRef = useRef(false);
  const localIdRef = useRef<string | null>(threadId);
  const sendChatRef = useRef<(text?: string, options?: { echo?: boolean }) => Promise<void>>(
    async () => undefined,
  );
  const logRef = useRef<ChatMessage[]>([]);
  const quoteRef = useRef<Quote | null>(null);
  const cartRef = useRef<StoredCart | null>(null);
  const picksDirty = useRef(false);
  const conversationRef = useRef<string | null>(null);
  const talking = isTalkSessionActive(voicePhase);
  const threadScope = useMemo(() => ({ userId, shopId: tenantId }), [tenantId, userId]);
  logRef.current = log;
  quoteRef.current = quote;
  cartRef.current = cart;
  conversationRef.current = conversationId;

  useEffect(() => {
    if (threadId && threadId === localId && log.length > 0) {
      return;
    }
    const stored = threadId ? getThread(threadScope, threadId) : null;
    const messages = stored?.messages ?? [];
    localIdRef.current = threadId;
    logRef.current = messages;
    setLocalId(threadId);
    setConversationId(stored?.conversationId ?? null);
    setLog(messages);
    setQuote(stored?.quote ?? null);
    setCart(stored?.cart ?? null);
    picksDirty.current = false;
    setPicks(picksFromCart(stored?.cart ?? null));
    setShelf(null);
    setShelfQuery('');
    setDraft(stored ? '' : initialDraft);
    setPay(null);
    setTraces([]);
    setRecoveryNote(null);
    setStatus(stored ? 'Continue this chat.' : 'Ready.');
    setProcess(null);
    setVoicePhase('idle');
    talkGeneration.current += 1;
    talkStarting.current = false;
    if (talkPoll.current) {
      window.clearInterval(talkPoll.current);
      talkPoll.current = null;
    }
    const voice = vapiRef.current;
    vapiRef.current = null;
    try {
      voice?.stop();
    } catch {
      // already stopped
    }
  }, [initialDraft, threadId, threadScope]);

  useEffect(() => {
    const transcript = scroller.current;
    if (!transcript) {
      return;
    }
    if (typeof transcript.scrollTo === 'function') {
      transcript.scrollTo({ top: transcript.scrollHeight });
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [log, process]);

  useEffect(() => {
    void loadRazorpay().catch(() => undefined);
  }, []);

  useEffect(() => {
    void apiFetch<{
      items?: Array<{
        sku: string;
        title: string;
        priceDisplay: string;
        stock: number;
        material?: string;
      }>;
    }>(`/v1/merchants/${tenantId}/catalog`)
      .then((body) => setShop(body.items ?? []))
      .catch(() => setShop([]));
  }, [tenantId]);

  useEffect(() => {
    if (picksDirty.current) {
      return;
    }
    setPicks(picksFromCart(cart, shop));
  }, [cart, shop]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    let cancelled = false;
    void apiFetch<{ quote?: Quote | null; cart?: StoredCart | null }>(
      `/v1/conversations/${conversationId}?shopSlug=${encodeURIComponent(shopSlug)}`,
    )
      .then((snap) => {
        if (cancelled) {
          return;
        }
        if (snap.quote) {
          setQuote(snap.quote);
        }
        if (snap.cart !== undefined) {
          const nextCart = cartSnapshotFromTurn({ cart: snap.cart, quote: snap.quote });
          setCart(nextCart);
          if (localIdRef.current) {
            void ensureLocal(
              logRef.current,
              snap.quote ?? quoteRef.current,
              conversationId,
              nextCart,
            );
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId, shopSlug]);

  useEffect(() => {
    void apiFetch<{ voiceEnabled?: boolean; recoveryEnabled?: boolean }>('/v1/concierge/config')
      .then((config) => {
        setVoiceReady(Boolean(config.voiceEnabled));
        setRecoveryReady(Boolean(config.recoveryEnabled));
      })
      .catch(() => {
        setVoiceReady(false);
        setRecoveryReady(false);
      });
    return () => {
      talkGeneration.current += 1;
      talkStarting.current = false;
      if (talkPoll.current) {
        window.clearInterval(talkPoll.current);
        talkPoll.current = null;
      }
      try {
        vapiRef.current?.stop();
      } catch {
        // already stopped
      }
      vapiRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!autoSend) {
      return;
    }
    const text = initialDraft.trim();
    if (!text || autoSendStarted.current) {
      return;
    }
    const handle = window.setTimeout(() => {
      if (autoSendStarted.current) {
        return;
      }
      autoSendStarted.current = true;
      void sendChatRef.current(text);
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [autoSend, initialDraft]);

  useEffect(() => {
    if (!threadId) {
      return;
    }
    const pending = consumePendingTurn(threadScope, threadId);
    if (!pending) {
      return;
    }
    const handle = window.setTimeout(() => {
      void sendChatRef.current(pending, { echo: false });
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [threadId, threadScope]);

  function persist(next: {
    id: string;
    conversationId: string | null;
    messages: ChatMessage[];
    quote: Quote | null;
    cart: StoredCart | null;
  }) {
    const first = next.messages.find((row) => row.role === 'you')?.text ?? 'New chat';
    upsertThread(threadScope, {
      id: next.id,
      conversationId: next.conversationId,
      title: titleFrom(first),
      updatedAt: new Date().toISOString(),
      messages: next.messages,
      quote: next.quote,
      cart: next.cart,
      shopSlug,
      shopName: merchantName,
      pendingTurn: null,
    });
    onHistory();
  }

  function describeRecovery(attempt?: RecoveryAttempt | null): string | null {
    if (!attempt) {
      return null;
    }
    if (attempt.action === 'sent') {
      return 'Recovery mail sent. Payment is not confirmed; retry the same frozen quote.';
    }
    if (attempt.reason === 'NO_CONSENT') {
      return 'No recovery mail. Consent was not granted.';
    }
    if (attempt.reason === 'ALREADY_SENT') {
      return 'Recovery mail already sent for this checkout.';
    }
    if (attempt.reason === 'NOT_CONFIGURED') {
      return 'Recovery mail skipped. AgentMail is not configured.';
    }
    if (attempt.action === 'failed') {
      return `Recovery mail failed (${attempt.reason ?? 'send error'}).`;
    }
    return null;
  }

  async function grantAndBind(checkoutId: string): Promise<void> {
    if (!recoveryWanted) {
      return;
    }
    const granted = await apiFetch<{ consentId: string }>('/v1/recovery/consent', {
      method: 'POST',
      body: JSON.stringify({
        shopSlug,
        purpose: 'payment_recovery',
        channel: 'email',
      }),
    });
    await apiFetch(`/v1/checkouts/${checkoutId}/recovery`, {
      method: 'POST',
      body: JSON.stringify({ shopSlug, consentId: granted.consentId }),
    });
  }

  function applyTraces(rows: Trace[]) {
    setTraces(rows);
  }

  function recordCheckoutOutcome(session: CheckoutSession) {
    const copy = orderConfirmedCopy(quoteRef.current, session);
    const nextSession = copy === session.copy ? session : { ...session, copy };
    setPay(nextSession);
    setStatus(copy);
    setRecoveryNote(describeRecovery(nextSession.recovery));
    setProcess(null);
    const next = withPaymentThreadMessage(logRef.current, nextSession);
    if (next === logRef.current) {
      return;
    }
    logRef.current = next;
    setLog(next);
    void ensureLocal(next, quoteRef.current, conversationRef.current);
  }

  async function openCheckout(started: CheckoutLaunch) {
    try {
      if (started.status === 'SETTLED' || started.reconciliationOutcome === 'captured') {
        recordCheckoutOutcome({
          id: started.checkoutId,
          status: 'SETTLED',
          copy: started.copy ?? 'Payment captured. One Charter order; inventory will commit once.',
          paymentId: null,
          providerStatus: 'captured',
          retryAllowed: false,
          reconciliationOutcome: 'captured',
        });
        return;
      }
      if (!started.keyId || !started.orderId) {
        throw new Error('CHECKOUT_SCRIPT_FAILED');
      }
      const amount = Number(started.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('CHECKOUT_SCRIPT_FAILED');
      }
      await grantAndBind(started.checkoutId);
      await loadRazorpay();
      if (!window.Razorpay) {
        throw new Error('CHECKOUT_SCRIPT_FAILED');
      }
      const checkout = new window.Razorpay({
        key: started.keyId,
        amount,
        currency: started.currency,
        name: started.name,
        description: started.description,
        order_id: started.orderId,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          const result = await apiFetch<CheckoutSession>(
            `/v1/checkouts/${started.checkoutId}/callback`,
            {
              method: 'POST',
              body: JSON.stringify({ shopSlug, ...response }),
            },
          );
          recordCheckoutOutcome(result);
        },
        modal: {
          ondismiss: async () => {
            const result = await apiFetch<CheckoutSession>(
              `/v1/checkouts/${started.checkoutId}/dismissed`,
              {
                method: 'POST',
                body: JSON.stringify({ shopSlug }),
              },
            );
            recordCheckoutOutcome(result);
          },
        },
      });
      try {
        checkout.open();
      } catch {
        throw new Error('CHECKOUT_SCRIPT_FAILED');
      }
      setStatus(razorpayWorkCopy('pay-window'));
    } finally {
      setProcess(null);
    }
  }

  async function startQuoteCheckout(): Promise<CheckoutLaunch> {
    if (!quote) {
      throw new Error('QUOTE_NOT_FOUND');
    }
    return apiFetch<CheckoutLaunch>(`/v1/quotes/${quote.id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ shopSlug }),
      signal: AbortSignal.timeout(20_000),
    });
  }

  async function checkPaymentStatus() {
    if (!quote) {
      return;
    }
    setProcess('working');
    setStatus(razorpayWorkCopy('check-status'));
    try {
      const started = await startQuoteCheckout();
      if (started.status === 'SETTLED' || started.reconciliationOutcome === 'captured') {
        recordCheckoutOutcome({
          id: started.checkoutId,
          status: 'SETTLED',
          copy: started.copy ?? 'Payment captured. One Charter order; inventory will commit once.',
          paymentId: null,
          providerStatus: 'captured',
          retryAllowed: false,
          reconciliationOutcome: 'captured',
        });
        return;
      }
      const retrySafe = Boolean(
        started.retryAllowed || started.reconciliationOutcome === 'same_order_retry_safe',
      );
      if (retrySafe) {
        setPay({
          id: started.checkoutId,
          status: 'CREATED',
          copy:
            started.copy ??
            'Retry on the same Razorpay Order after authoritative reconciliation. Frozen quote unchanged.',
          paymentId: null,
          providerStatus: null,
          retryAllowed: true,
          reconciliationOutcome: 'same_order_retry_safe',
        });
        setStatus('Same Razorpay Order is ready to retry. Frozen quote unchanged.');
        return;
      }
      recordCheckoutOutcome({
        id: started.checkoutId,
        status: 'FAILED_PROVISIONAL',
        copy: started.copy ?? 'Payment not confirmed.',
        paymentId: null,
        providerStatus: null,
        retryAllowed: false,
        reconciliationOutcome: started.reconciliationOutcome,
      });
    } catch (error) {
      const code =
        error instanceof ApiError
          ? error.code === 'TURN_TIMEOUT'
            ? 'CHECKOUT_TIMEOUT'
            : error.code
          : 'RECONCILIATION_REQUIRED';
      const blocked = checkoutFromBlockedCode(code);
      if (blocked) {
        recordCheckoutOutcome({
          id: pay?.id,
          paymentId: pay?.paymentId ?? null,
          ...blocked,
        });
      } else {
        setPay((current) =>
          current
            ? {
                ...current,
                reconciliationOutcome:
                  code === 'RECONCILIATION_REQUIRED'
                    ? 'unknown_attempts'
                    : current.reconciliationOutcome,
              }
            : current,
        );
        setStatus(buyerFacingError(code));
      }
    } finally {
      setProcess(null);
    }
  }

  async function payFrozenQuote() {
    if (!quote) {
      return;
    }
    setProcess('working');
    setStatus(razorpayWorkCopy('create-order'));
    try {
      const started = await startQuoteCheckout();
      setStatus(razorpayWorkCopy('open-checkout'));
      await openCheckout(started);
    } catch (error) {
      const code =
        error instanceof ApiError
          ? error.code === 'TURN_TIMEOUT'
            ? 'CHECKOUT_TIMEOUT'
            : error.code
          : error instanceof Error && error.message === 'CHECKOUT_SCRIPT_FAILED'
            ? 'CHECKOUT_SCRIPT_FAILED'
            : 'CHECKOUT_ERROR';
      const blocked = checkoutFromBlockedCode(code);
      if (blocked) {
        recordCheckoutOutcome({
          id: pay?.id,
          paymentId: pay?.paymentId ?? null,
          ...blocked,
        });
      } else {
        setStatus(buyerFacingError(code));
      }
      setProcess(null);
    }
  }

  async function ensureLocal(
    messages: ChatMessage[],
    nextQuote: Quote | null,
    nextConversation: string | null,
    nextCart: StoredCart | null = cartRef.current,
  ): Promise<string> {
    const created = !localIdRef.current;
    const id = localIdRef.current ?? crypto.randomUUID();
    localIdRef.current = id;
    persist({ id, conversationId: nextConversation, messages, quote: nextQuote, cart: nextCart });
    if (created) {
      setLocalId(id);
      onBound(id);
    }
    return id;
  }

  async function sendChat(textOverride?: string, options?: { echo?: boolean }) {
    const text = (textOverride ?? draft).trim();
    const echo = options?.echo !== false;
    if (!text || isTalkSessionActive(voicePhase) || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setDraft('');
    setProcess('searching');
    setStatus(conciergeWorkCopy(text));
    const nextLog = echo
      ? [...logRef.current, { role: 'you' as const, text }]
      : [...logRef.current];
    logRef.current = nextLog;
    setLog(nextLog);
    try {
      let id = conversationRef.current;
      if (!id) {
        const created = await apiFetch<{ id: string }>('/v1/conversations', {
          method: 'POST',
          body: JSON.stringify({ shopSlug }),
        });
        id = created.id;
        conversationRef.current = id;
        setConversationId(id);
      }
      await ensureLocal(nextLog, quoteRef.current, id);
      type TurnResult = {
        reply?: string;
        quote?: Quote | null;
        cart?: StoredCart | null;
        checkout?: CheckoutLaunch | null;
        traces?: Trace[];
      };
      let body: TurnResult;
      const turnController = new AbortController();
      const turnTimer = window.setTimeout(() => turnController.abort(), 20_000);
      try {
        try {
          body = await apiFetch<TurnResult>(`/v1/conversations/${id}/turns`, {
            method: 'POST',
            body: JSON.stringify({ shopSlug, text }),
            signal: turnController.signal,
          });
        } catch (error) {
          if (error instanceof ApiError && error.code === 'CONVERSATION_NOT_FOUND') {
            const created = await apiFetch<{ id: string }>('/v1/conversations', {
              method: 'POST',
              body: JSON.stringify({ shopSlug }),
            });
            id = created.id;
            conversationRef.current = id;
            setConversationId(id);
            body = await apiFetch<TurnResult>(`/v1/conversations/${id}/turns`, {
              method: 'POST',
              body: JSON.stringify({ shopSlug, text }),
              signal: turnController.signal,
            });
          } else {
            throw error;
          }
        }
      } finally {
        window.clearTimeout(turnTimer);
      }
      const withReply = [...nextLog, { role: 'concierge' as const, text: body.reply ?? '' }];
      logRef.current = withReply;
      setLog(withReply);
      applyTraces(body.traces ?? []);
      const nextQuote = body.quote ?? quoteRef.current;
      if (body.quote) {
        setQuote(body.quote);
      }
      const nextCart =
        body.cart !== undefined
          ? cartSnapshotFromTurn({ cart: body.cart, quote: nextQuote })
          : (cartSnapshotFromTurn({ quote: body.quote, traces: body.traces }) ?? cartRef.current);
      if (/^put these in my cart/i.test(text)) {
        picksDirty.current = false;
      }
      setCart(nextCart);
      setStatus(
        body.quote ? `Locked ${body.quote.totalDisplay}. Pay when you are ready.` : 'Ready.',
      );
      setProcess(null);
      await ensureLocal(withReply, nextQuote, id, nextCart);
    } catch (error) {
      const code =
        error instanceof ApiError
          ? error.code
          : error instanceof Error && error.message === 'CHECKOUT_SCRIPT_FAILED'
            ? 'CHECKOUT_SCRIPT_FAILED'
            : 'CONVERSATION_ERROR';
      const copy = buyerFacingError(code);
      const failed = [...logRef.current, { role: 'concierge' as const, text: copy }];
      logRef.current = failed;
      setLog(failed);
      setStatus(copy);
      setProcess(null);
    } finally {
      sendingRef.current = false;
    }
  }
  sendChatRef.current = sendChat;

  async function ensureConversation(): Promise<string> {
    if (conversationId) {
      return conversationId;
    }
    const created = await apiFetch<{ id: string }>('/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ shopSlug }),
    });
    setConversationId(created.id);
    await ensureLocal(log, quote, created.id);
    return created.id;
  }

  function applyVoiceTranscript(event: unknown) {
    if (!event || typeof event !== 'object') {
      return;
    }
    const row = voiceTranscriptFromMessage(event);
    if (!row) {
      return;
    }
    const next = upsertVoiceTranscript(logRef.current, row);
    if (next === logRef.current) {
      return;
    }
    logRef.current = next;
    setLog(next);
    void ensureLocal(next, quoteRef.current, conversationRef.current);
  }

  function stopTalkSession(nextStatus: string, nextPhase: VoicePhase = 'idle') {
    talkGeneration.current += 1;
    talkStarting.current = false;
    if (talkPoll.current) {
      window.clearInterval(talkPoll.current);
      talkPoll.current = null;
    }
    const client = vapiRef.current;
    vapiRef.current = null;
    try {
      client?.stop();
    } catch {
      // already stopped
    }
    setVoicePhase(nextPhase);
    setProcess(nextPhase === 'error' ? voiceOrbState('error') : null);
    setStatus(nextStatus);
  }

  function bindTalkClient(vapi: VoiceClient, generation: number) {
    vapi.on('call-start', () => {
      if (generation !== talkGeneration.current) {
        return;
      }
      setVoicePhase('listening');
      setProcess('listening');
      setStatus(voiceStatusCopy('listening'));
    });
    vapi.on('speech-start', () => {
      if (generation !== talkGeneration.current) {
        return;
      }
      setVoicePhase('speaking');
      setProcess('composing');
      setStatus(voiceStatusCopy('speaking'));
    });
    vapi.on('speech-end', () => {
      if (generation !== talkGeneration.current) {
        return;
      }
      setVoicePhase('listening');
      setProcess('listening');
      setStatus(voiceStatusCopy('listening'));
    });
    vapi.on('message', (message: unknown) => {
      if (generation !== talkGeneration.current) {
        return;
      }
      applyVoiceTranscript(message);
    });
    vapi.on('error', (error: unknown) => {
      if (generation !== talkGeneration.current) {
        return;
      }
      stopTalkSession(voiceErrorCopy(error), 'error');
    });
    vapi.on('call-start-failed', (event: unknown) => {
      if (generation !== talkGeneration.current) {
        return;
      }
      stopTalkSession(voiceErrorCopy(event), 'error');
    });
    vapi.on('call-end', () => {
      if (generation !== talkGeneration.current) {
        return;
      }
      stopTalkSession(voiceStatusCopy('idle'));
    });
  }

  async function toggleTalk() {
    if (talkStarting.current && !isTalkSessionActive(voicePhase)) {
      return;
    }
    if (isTalkSessionActive(voicePhase) || vapiRef.current) {
      stopTalkSession(voiceStatusCopy('idle'));
      return;
    }
    talkStarting.current = true;
    const generation = talkGeneration.current;
    setVoicePhase('connecting');
    setProcess('connecting');
    setStatus(voiceStatusCopy('connecting'));
    try {
      const config = await apiFetch<{
        vapiPublicKey?: string | null;
        voiceEnabled?: boolean;
        voiceModelBase?: string | null;
      }>('/v1/concierge/config');
      if (generation !== talkGeneration.current) {
        return;
      }
      const voiceModelBase = resolveVoiceModelBase(config.voiceModelBase);
      if (!config.voiceEnabled || !config.vapiPublicKey || !voiceModelBase) {
        stopTalkSession(
          config.vapiPublicKey ? 'VOICE_PUBLIC_URL_MISSING' : 'VAPI_NOT_READY',
          'error',
        );
        return;
      }
      await requestTalkMicrophone();
      if (generation !== talkGeneration.current) {
        return;
      }
      const token = await getAccessToken();
      if (generation !== talkGeneration.current) {
        return;
      }
      if (!token) {
        stopTalkSession('VOICE_AUTH_REQUIRED', 'error');
        return;
      }
      const id = await ensureConversation();
      if (generation !== talkGeneration.current) {
        return;
      }
      const { default: Vapi } = await import('@vapi-ai/web');
      if (generation !== talkGeneration.current) {
        return;
      }
      const vapi = new Vapi(config.vapiPublicKey) as VoiceClient;
      vapiRef.current = vapi;
      bindTalkClient(vapi, generation);
      await startVoiceCall(() =>
        vapi.start(
          buildTalkAssistant({
            merchantName,
            conversationId: id,
            voiceModelBase,
            shopSlug,
            accessToken: token,
          }),
        ),
      );
      if (generation !== talkGeneration.current) {
        try {
          vapi.stop();
        } catch {
          // user already stopped
        }
        return;
      }
      setVoicePhase('listening');
      setProcess('listening');
      setStatus(voiceStatusCopy('listening'));
      talkPoll.current = window.setInterval(() => {
        void fetchPendingConversationSnapshot<{
          quote?: Quote | null;
          cart?: StoredCart | null;
          checkout?: CheckoutLaunch | null;
        }>({
          conversationId: id,
          shopSlug,
        }).then(async (snap) => {
          if (!snap || generation !== talkGeneration.current) {
            return;
          }
          if (snap.quote) {
            setQuote(snap.quote);
          }
          if (snap.cart !== undefined) {
            setCart(cartSnapshotFromTurn({ cart: snap.cart, quote: snap.quote }));
          }
          if (snap.checkout?.checkoutId) {
            setProcess('working');
            await openCheckout(snap.checkout);
          }
        });
      }, 1500);
    } catch (error) {
      if (generation !== talkGeneration.current) {
        return;
      }
      stopTalkSession(voiceErrorCopy(error), 'error');
    } finally {
      if (generation === talkGeneration.current) {
        talkStarting.current = false;
      }
    }
  }

  const lastConciergeIndex = log.reduce(
    (found, row, index) => (row.role === 'concierge' ? index : found),
    -1,
  );
  const dirtyPicks = picksDifferFromCart(picks, cart);
  const selectedCount = pickCount(picks);
  const offerBuyNow =
    (dirtyPicks && selectedCount > 0) ||
    shouldOfferLockTotal(
      log[lastConciergeIndex]?.text ?? '',
      Boolean(quote),
      Boolean(cart?.lines.length) || selectedCount > 0,
    );

  function applyPickQuantity(item: { sku: string; title: string }, quantity: number) {
    const resolved = resolveCatalogItem(item, shop);
    picksDirty.current = true;
    setPicks((current) => {
      const next = { ...current };
      delete next[item.sku];
      if (quantity <= 0) {
        delete next[resolved.sku];
        return next;
      }
      next[resolved.sku] = {
        sku: resolved.sku,
        title: resolved.title,
        quantity,
      };
      return next;
    });
  }

  function submitBuyNow() {
    const prompt = buyNowPrompt(picks, dirtyPicks);
    if (!prompt) {
      return;
    }
    setShelf(null);
    void sendChatRef.current(prompt, { echo: false });
  }

  return (
    <div className={quote || pay ? 'workspace has-rail' : 'workspace'}>
      <div className="chat-col">
        <div className="transcript" ref={scroller}>
          {log.length === 0 ? (
            <div className="blank">
              <p>Ask, pick items, Buy now, and pay.</p>
            </div>
          ) : null}
          {log.map((row, index) => (
            <article key={`${row.role}-${index}`} className="bubble" data-role={row.role}>
              <strong className="bubble-role">{row.role === 'you' ? 'You' : 'Concierge'}</strong>
              {row.role === 'concierge' ? (
                <>
                  <ChatMarkdown text={row.text} />
                  <MentionedProducts
                    text={row.text}
                    items={shop}
                    busy={Boolean(process) || talking}
                    active={!quote}
                    locked={Boolean(quote)}
                    quantityFor={(item) => displayQuantity(picks, cart, item, shop)}
                    onAsk={(item) => void sendChatRef.current(`Tell me more about ${item.title}`)}
                    onQuantity={applyPickQuantity}
                  />
                  {index === lastConciergeIndex && !quote ? (
                    <div className="chat-moves">
                      {shop.length > 0 ? (
                        <button
                          type="button"
                          className="chat-move-secondary"
                          disabled={Boolean(process) || talking}
                          onClick={() => {
                            setShelfQuery('');
                            setShelf('browse');
                          }}
                        >
                          {BROWSE_SHOP_LABEL}
                        </button>
                      ) : null}
                      {selectedCount > 0 ? (
                        <button
                          type="button"
                          className="chat-move-secondary"
                          disabled={Boolean(process) || talking}
                          onClick={() => {
                            setShelfQuery('');
                            setShelf('cart');
                          }}
                        >
                          {VIEW_CART_LABEL}
                        </button>
                      ) : null}
                      {offerBuyNow ? (
                        <button
                          type="button"
                          className="chat-move"
                          disabled={Boolean(process) || talking}
                          onClick={submitBuyNow}
                        >
                          {BUY_NOW_LABEL}
                        </button>
                      ) : null}
                      <p className="chat-move-hint">
                        {dirtyPicks && selectedCount > 0 ? VIEW_CART_HINT : BUY_NOW_HINT}
                      </p>
                    </div>
                  ) : null}
                  {index === lastConciergeIndex && quote ? (
                    <div className="chat-moves">
                      <FrozenQuotePayButtons
                        quoteDisplay={quote.totalDisplay}
                        pay={pay}
                        onPay={() => void payFrozenQuote()}
                        onCheckStatus={() => void checkPaymentStatus()}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="bubble-plain">{row.text}</div>
              )}
            </article>
          ))}
          {process && voicePhase === 'idle' ? (
            <ProcessOrb state={process} label={status} size={64} theme="light" />
          ) : null}
          {voiceOrbState(voicePhase) ? (
            <ProcessOrb
              className="process-orb-voice"
              state={voiceOrbState(voicePhase)!}
              label={voiceStatusCopy(voicePhase, voicePhase === 'error' ? status : null)}
              size={64}
              theme="dark"
            />
          ) : null}
        </div>
        <form
          className="composer"
          data-voice-phase={voicePhase}
          onSubmit={(event) => {
            event.preventDefault();
            void sendChat();
          }}
        >
          <div className="composer-box">
            <textarea
              id="buyer-composer"
              aria-label="Message to Concierge"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (!shouldSubmitComposerKey(event) || composing.current) {
                  return;
                }
                if (talking || (process && voicePhase === 'idle')) {
                  return;
                }
                event.preventDefault();
                void sendChat();
              }}
              placeholder="Message Concierge…"
              rows={1}
            />
            <div className="composer-actions">
              <button
                type="button"
                className={talking ? 'composer-icon talk-stop' : 'composer-icon composer-talk'}
                aria-label={talkButtonLabel(voicePhase)}
                aria-pressed={talking}
                data-voice-ready={voiceReady ? 'true' : 'false'}
                onClick={() => void toggleTalk()}
              >
                <MicIcon />
                <span className="sr-only">{talkButtonLabel(voicePhase)}</span>
              </button>
              <button
                type="submit"
                className="composer-icon composer-send"
                aria-label="Send"
                disabled={talking || (Boolean(process) && voicePhase === 'idle')}
              >
                <SendIcon />
                <span className="sr-only">Send</span>
              </button>
            </div>
          </div>
          <p
            className={
              status === 'Ready.' ||
              status === 'Continue this chat.' ||
              isTalkSessionActive(voicePhase)
                ? 'sr-only'
                : 'composer-note'
            }
            role="status"
            aria-live="polite"
          >
            {status}
          </p>
        </form>
      </div>
      {quote || pay ? (
        <aside className="rail">
          <details className="sheet catalog-strip">
            <summary>Catalog (optional)</summary>
            {shop.length === 0 ? <p>Catalog is loading…</p> : null}
            {shop.map((item) => (
              <button
                key={item.sku}
                type="button"
                className="shop-item"
                onClick={() => setDraft(`Add ${item.title}`)}
              >
                <CatalogThumb label={item.title} seed={item.sku} />
                <span>
                  {item.title}
                  {item.stock <= 0 ? ' · out of stock' : ''}
                </span>
                <strong>{item.priceDisplay}</strong>
              </button>
            ))}
          </details>
          {quote ? (
            <section className="sheet">
              <h2>{pay?.status === 'SETTLED' ? 'Order confirmed' : 'Locked total'}</h2>
              <p>
                <strong>{quote.totalDisplay}</strong>
              </p>
              <p className="chat-move-hint">
                {pay?.status === 'SETTLED'
                  ? 'Paid. Delivery is booked on this quote.'
                  : 'This amount is pinned for checkout.'}
              </p>
              <p>Shop window {quote.deliveryBy}</p>
              {quote.lines.map((line) => (
                <p key={line.sku}>
                  {line.title} × {line.quantity}
                </p>
              ))}
              <FrozenQuotePayButtons
                quoteDisplay={quote.totalDisplay}
                pay={pay}
                onPay={() => void payFrozenQuote()}
                onCheckStatus={() => void checkPaymentStatus()}
              />
              {pay ? (
                <div className="pay-status">
                  <span className="tag" data-tone={pay.status === 'SETTLED' ? 'ok' : 'hold'}>
                    {pay.status}
                  </span>
                  <ChatMarkdown text={pay.copy} />
                </div>
              ) : null}
              {pay?.status === 'SETTLED' && pay.id ? (
                <p>
                  <Link to={`/orders/${pay.id}`}>View buyer receipt</Link>
                </p>
              ) : null}
              {pay?.status === 'FAILED_PROVISIONAL' ? (
                <>
                  <p>
                    <label>
                      <input
                        type="checkbox"
                        checked={recoveryWanted}
                        onChange={(event) => setRecoveryWanted(event.target.checked)}
                      />
                      Email me a retry if this pay did not confirm
                    </label>
                  </p>
                  {recoveryWanted ? (
                    <>
                      <p>Recovery will use the verified account email: {email}</p>
                      {pay.id ? (
                        <button
                          type="button"
                          onClick={() => {
                            void apiFetch<{
                              recovery?: RecoveryAttempt | null;
                            }>('/v1/recovery/consent', {
                              method: 'POST',
                              body: JSON.stringify({
                                shopSlug,
                                purpose: 'payment_recovery',
                                channel: 'email',
                                checkoutId: pay.id,
                              }),
                            })
                              .then((body) => {
                                setRecoveryNote(describeRecovery(body.recovery) ?? 'Recorded.');
                              })
                              .catch((error: unknown) => {
                                setRecoveryNote(
                                  error instanceof ApiError ? error.code : 'CONSENT_ERROR',
                                );
                              });
                          }}
                        >
                          Send the email
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  {recoveryNote ? <p>{recoveryNote}</p> : null}
                </>
              ) : null}
            </section>
          ) : null}
          {traces.some((row) => row.result.decision && row.result.decision.outcome !== 'allow') ? (
            <section className="sheet">
              <h2>Held by the shop</h2>
              {traces.map((row, index) =>
                row.result.decision && row.result.decision.outcome !== 'allow' ? (
                  <p key={`${row.name}-${index}`}>
                    {row.result.decision.message || row.result.decision.reason}
                  </p>
                ) : null,
              )}
            </section>
          ) : null}
        </aside>
      ) : null}
      {!quote ? (
        <ShopShelf
          open={shelf !== null}
          title={shelf === 'cart' ? 'Your cart' : merchantName}
          hint={
            shelf === 'cart'
              ? 'This is the mix you will buy. Change quantity here, then Buy now.'
              : 'Search the shop and set quantities. Buy now when the mix looks right.'
          }
          items={shelf === 'cart' ? cartShelfItems(shop, picks) : shop}
          query={shelfQuery}
          onQuery={setShelfQuery}
          showSearch={shelf === 'browse'}
          quantityFor={(item) => displayQuantity(picks, cart, item, shop)}
          onQuantity={applyPickQuantity}
          busy={Boolean(process) || talking || Boolean(quote)}
          onClose={() => setShelf(null)}
          onBuyNow={offerBuyNow ? submitBuyNow : undefined}
        />
      ) : null}
    </div>
  );
}
