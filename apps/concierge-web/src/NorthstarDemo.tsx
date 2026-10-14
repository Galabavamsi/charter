import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChatMarkdown } from './ChatMarkdown';
import { ApiError, apiFetch, fetchPendingConversationSnapshot, getAccessToken } from './api';
import {
  buyerFacingError,
  conciergeWorkCopy,
  orderConfirmedCopy,
  payStatusLabel,
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
  accessTokenExpiresWithin,
  buildTalkAssistant,
  coalesceSameTurnText,
  isTalkSessionActive,
  requestTalkMicrophone,
  resolveVoiceModelBase,
  startVoiceCall,
  TALK_MAX_SECONDS,
  talkButtonLabel,
  upsertVoiceTranscript,
  voiceCallEndCopy,
  voiceEndedReason,
  voiceErrorCopy,
  voiceOrbState,
  voiceStatusCopy,
  voiceTranscriptFromMessage,
  type VoicePhase,
} from './voiceTalk';
import './concierge-extra.css';

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

/** A quote the server marked SETTLED is paid: show the receipt, never Pay again. */
export function settledPay(quote: Quote | null | undefined): CheckoutSession | null {
  if (quote?.status !== 'SETTLED') {
    return null;
  }
  return {
    ...(quote.boundCheckoutId ? { id: quote.boundCheckoutId } : {}),
    status: 'SETTLED',
    copy: orderConfirmedCopy(quote, {
      status: 'SETTLED',
      copy: 'Payment captured. One Charter order; inventory will commit once.',
    }),
    paymentId: null,
    providerStatus: 'captured',
    retryAllowed: false,
    reconciliationOutcome: 'captured',
  };
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

const CHECKABLE_PAY_STATUS = new Set(['FAILED_PROVISIONAL', 'CAPTURE_PENDING', 'RECONCILING']);

export const TEST_MODE_PAY_HINT =
  'Test mode — pay with UPI success@razorpay or Netbanking → Success. No real money moves.';

export function FrozenQuotePayButtons({
  quoteDisplay,
  pay,
  busy = false,
  receiptHref = null,
  newOrderHref = null,
  testHint = false,
  onPay,
  onCheckStatus,
}: {
  quoteDisplay: string;
  pay: CheckoutSession | null;
  busy?: boolean;
  /** Router links after capture; omitted where there is no router or a link elsewhere. */
  receiptHref?: string | null;
  newOrderHref?: string | null;
  testHint?: boolean;
  onPay(): void;
  onCheckStatus(): void;
}) {
  if (pay?.status === 'SETTLED') {
    return (
      <>
        {receiptHref ? (
          <Link className="chat-move-link" to={receiptHref}>
            View receipt
          </Link>
        ) : null}
        {newOrderHref ? (
          <Link className="chat-move-link chat-move-link-secondary" to={newOrderHref}>
            Start a new order
          </Link>
        ) : null}
      </>
    );
  }
  const retry = shouldShowSameOrderRetryControl(pay?.status, pay?.reconciliationOutcome);
  const showPay = shouldRenderDirectPayButton(pay?.status, pay?.reconciliationOutcome);
  return (
    <>
      {showPay ? (
        <button type="button" disabled={busy} onClick={onPay}>
          {retry ? 'Retry same order' : `Pay ${quoteDisplay}`}
        </button>
      ) : null}
      {pay && CHECKABLE_PAY_STATUS.has(pay.status) && !retry ? (
        <button type="button" disabled={busy} onClick={onCheckStatus}>
          Check payment status
        </button>
      ) : null}
      {testHint && showPay ? (
        <p className="chat-move-hint pay-test-hint">{TEST_MODE_PAY_HINT}</p>
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

type ConversationSnapshot = {
  quote?: Quote | null;
  cart?: StoredCart | null;
  checkout?: CheckoutLaunch | null;
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
  /** Fresh buyer access token (Talk hands it to Vapi for the whole call). */
  refreshAccessToken?: () => Promise<string | null>;
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
  refreshAccessToken,
}: DemoProps) {
  const [status, setStatus] = useState('Ready.');
  const [process, setProcess] = useState<ProcessState | null>(null);
  const [pay, setPay] = useState<CheckoutSession | null>(() =>
    threadId ? settledPay(getThread({ userId, shopId: tenantId }, threadId)?.quote) : null,
  );
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
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [razorpayMode, setRazorpayMode] = useState<string | null>(null);
  const [recoveryWanted, setRecoveryWanted] = useState(false);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const [shop, setShop] = useState<
    Array<{ sku: string; title: string; priceDisplay: string; stock: number; material?: string }>
  >([]);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const vapiRef = useRef<VoiceClient | null>(null);
  const talkPoll = useRef<number | null>(null);
  const talkStarting = useRef(false);
  const talkGeneration = useRef(0);
  const endedReasonRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composing = useRef(false);
  const autoSendStarted = useRef(false);
  const sendingRef = useRef(false);
  const payingRef = useRef(false);
  const payRef = useRef<CheckoutSession | null>(null);
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
  payRef.current = pay;
  conversationRef.current = conversationId;

  useEffect(() => {
    const ownThread = Boolean(
      threadId && (threadId === localId || threadId === localIdRef.current),
    );
    // A brand-new chat gets its id mid-send or mid-Talk; that is still this chat, not a switch.
    if (ownThread && (log.length > 0 || talkStarting.current || vapiRef.current)) {
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
    payRef.current = settledPay(stored?.quote);
    setPay(payRef.current);
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
    if (logRef.current.length === 0) {
      return;
    }
    // The page (not only .transcript) may be the scroller, so bring the end sentinel into view,
    // then the composer below it, so the latest reply sits just above the message box.
    endRef.current?.scrollIntoView?.({ block: 'end' });
    composerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [log, process, quote?.id, pay?.status]);

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
      .then((body) => {
        setShop(body.items ?? []);
        setCatalogFailed(false);
      })
      .catch(() => {
        setShop([]);
        setCatalogFailed(true);
      });
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
    void apiFetch<ConversationSnapshot>(
      `/v1/conversations/${conversationId}?shopSlug=${encodeURIComponent(shopSlug)}`,
    )
      .then((snap) => {
        if (!cancelled) {
          applySnapshot(snap, conversationId);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId, shopSlug]);

  useEffect(() => {
    void apiFetch<{ voiceEnabled?: boolean; recoveryEnabled?: boolean; razorpayMode?: string }>(
      '/v1/concierge/config',
    )
      .then((config) => {
        setVoiceReady(Boolean(config.voiceEnabled));
        setRecoveryReady(Boolean(config.recoveryEnabled));
        setRazorpayMode(typeof config.razorpayMode === 'string' ? config.razorpayMode : null);
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
      return 'Email reminders are off in this demo.';
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
    payRef.current = nextSession;
    setPay(nextSession);
    setStatus(nextSession.status === 'SETTLED' ? 'Payment captured. Order confirmed.' : copy);
    setRecoveryNote(describeRecovery(nextSession.recovery));
    setProcess(null);
    // Remember the capture on the quote itself so a reload shows the receipt, not Pay.
    const current = quoteRef.current;
    const settleQuote =
      nextSession.status === 'SETTLED' &&
      current !== null &&
      (current.status !== 'SETTLED' || (!current.boundCheckoutId && Boolean(nextSession.id)));
    if (settleQuote) {
      const settled: Quote = {
        ...current,
        status: 'SETTLED',
        boundCheckoutId: nextSession.id ?? current.boundCheckoutId ?? null,
      };
      quoteRef.current = settled;
      setQuote(settled);
    }
    const next = withPaymentThreadMessage(logRef.current, nextSession);
    if (next === logRef.current && !settleQuote) {
      return;
    }
    logRef.current = next;
    setLog(next);
    void ensureLocal(next, quoteRef.current, conversationRef.current);
  }

  /** Take a quote from the server; a new quote id starts a fresh pay state. */
  function adoptQuote(incoming: Quote): Quote {
    const previous = quoteRef.current;
    if (incoming.id !== previous?.id) {
      payRef.current = null;
      setPay(null);
      setRecoveryNote(null);
    }
    // Never downgrade a capture this browser already saw for the same quote.
    const next =
      previous?.id === incoming.id && previous.status === 'SETTLED' && incoming.status !== 'SETTLED'
        ? {
            ...incoming,
            status: previous.status,
            boundCheckoutId: previous.boundCheckoutId ?? null,
          }
        : incoming;
    quoteRef.current = next;
    setQuote(next);
    const settled = settledPay(next);
    if (settled && payRef.current?.status !== 'SETTLED') {
      payRef.current = settled;
      setPay(settled);
    }
    return next;
  }

  function applySnapshot(snap: ConversationSnapshot, id: string) {
    const nextQuote = snap.quote ? adoptQuote(snap.quote) : quoteRef.current;
    if (snap.cart === undefined) {
      if (snap.quote && localIdRef.current) {
        void ensureLocal(logRef.current, nextQuote, id);
      }
      return;
    }
    // A restarted server can answer cart: null for a cart this browser still has; keep ours.
    if (snap.cart === null && !snap.quote && cartRef.current?.lines.length) {
      return;
    }
    const nextCart = cartSnapshotFromTurn({ cart: snap.cart, quote: snap.quote });
    cartRef.current = nextCart;
    setCart(nextCart);
    if (localIdRef.current) {
      void ensureLocal(logRef.current, nextQuote, id, nextCart);
    }
  }

  async function syncSnapshot(id: string) {
    try {
      const snap = await apiFetch<ConversationSnapshot>(
        `/v1/conversations/${id}?shopSlug=${encodeURIComponent(shopSlug)}`,
      );
      if (conversationRef.current === id) {
        applySnapshot(snap, id);
      }
    } catch {
      // best effort; the next turn or reload catches up
    }
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
      try {
        await grantAndBind(started.checkoutId);
      } catch (error) {
        // The email reminder is optional; it must never block the payment itself.
        const code = error instanceof ApiError ? error.code : 'CONSENT_ERROR';
        setRecoveryNote(`Email reminder not set up. ${buyerFacingError(code)}`);
      }
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
        ...(email ? { prefill: { email } } : {}),
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          setProcess('working');
          setStatus('Confirming your payment with Razorpay…');
          try {
            const result = await apiFetch<CheckoutSession>(
              `/v1/checkouts/${started.checkoutId}/callback`,
              {
                method: 'POST',
                body: JSON.stringify({ shopSlug, ...response }),
              },
            );
            recordCheckoutOutcome(result);
          } catch {
            // Razorpay may have taken the money; record "not confirmed" so Check payment status shows.
            recordCheckoutOutcome({
              id: started.checkoutId,
              status: 'FAILED_PROVISIONAL',
              copy: buyerFacingError('CALLBACK_ERROR'),
              paymentId: response.razorpay_payment_id ?? null,
              providerStatus: null,
            });
          } finally {
            setProcess(null);
          }
        },
        modal: {
          ondismiss: async () => {
            try {
              const result = await apiFetch<CheckoutSession>(
                `/v1/checkouts/${started.checkoutId}/dismissed`,
                {
                  method: 'POST',
                  body: JSON.stringify({ shopSlug }),
                },
              );
              recordCheckoutOutcome(result);
              if (result.status === 'FAILED_PROVISIONAL' && !result.paymentId) {
                // Closed without paying: re-check once so Retry shows without an extra click.
                void checkPaymentStatus();
              }
            } catch {
              recordCheckoutOutcome({
                id: started.checkoutId,
                status: 'FAILED_PROVISIONAL',
                copy: 'Payment not confirmed. Check payment status before paying again.',
                paymentId: null,
                providerStatus: null,
              });
            }
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
    // Refs, not render state: Razorpay callbacks call this from an older render.
    const current = quoteRef.current;
    if (!current) {
      throw new Error('QUOTE_NOT_FOUND');
    }
    return apiFetch<CheckoutLaunch>(`/v1/quotes/${current.id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ shopSlug }),
      signal: AbortSignal.timeout(20_000),
    });
  }

  async function checkPaymentStatus() {
    if (!quoteRef.current || payingRef.current) {
      return;
    }
    payingRef.current = true;
    setProcess('working');
    setStatus(razorpayWorkCopy('check-status'));
    const known = payRef.current;
    try {
      if (known?.id && (known.status === 'CAPTURE_PENDING' || known.status === 'RECONCILING')) {
        // A webhook may have settled it since; read the checkout instead of starting another.
        const latest = await apiFetch<CheckoutSession>(
          `/v1/checkouts/${known.id}?shopSlug=${encodeURIComponent(shopSlug)}`,
        );
        recordCheckoutOutcome({
          id: latest.id ?? known.id,
          status: latest.status,
          copy: latest.copy,
          paymentId: latest.paymentId ?? known.paymentId,
          providerStatus: latest.providerStatus ?? known.providerStatus,
          reconciliationOutcome: known.reconciliationOutcome ?? null,
        });
        return;
      }
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
          id: payRef.current?.id ?? quoteRef.current?.boundCheckoutId ?? undefined,
          paymentId: payRef.current?.paymentId ?? null,
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
      payingRef.current = false;
      setProcess(null);
    }
  }

  async function payFrozenQuote() {
    if (!quoteRef.current || payingRef.current) {
      return;
    }
    payingRef.current = true;
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
          id: payRef.current?.id ?? quoteRef.current?.boundCheckoutId ?? undefined,
          paymentId: payRef.current?.paymentId ?? null,
          ...blocked,
        });
      } else {
        setStatus(buyerFacingError(code));
      }
      setProcess(null);
    } finally {
      payingRef.current = false;
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
    if (voicePhase === 'error') {
      setVoicePhase('idle');
    }
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
      // A tool-heavy model turn can take a while; give it room before calling it a timeout.
      const turnTimer = window.setTimeout(() => turnController.abort(), 60_000);
      try {
        try {
          body = await apiFetch<TurnResult>(`/v1/conversations/${id}/turns`, {
            method: 'POST',
            body: JSON.stringify({ shopSlug, text }),
            signal: turnController.signal,
          });
        } catch (error) {
          if (
            error instanceof ApiError &&
            (error.code === 'CONVERSATION_NOT_FOUND' || error.code === 'RESOURCE_FORBIDDEN')
          ) {
            // The server lost this conversation (reset or re-seed): start a fresh one and drop
            // the quote, cart and pay state that belonged to the old one.
            quoteRef.current = null;
            setQuote(null);
            cartRef.current = null;
            setCart(null);
            payRef.current = null;
            setPay(null);
            picksDirty.current = false;
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
      const nextQuote = body.quote ? adoptQuote(body.quote) : quoteRef.current;
      const nextCart =
        body.cart !== undefined
          ? cartSnapshotFromTurn({ cart: body.cart, quote: nextQuote })
          : (cartSnapshotFromTurn({ quote: body.quote, traces: body.traces }) ?? cartRef.current);
      if (/^put these in my cart/i.test(text)) {
        picksDirty.current = false;
      }
      setCart(nextCart);
      const paid = nextQuote?.status === 'SETTLED' || payRef.current?.status === 'SETTLED';
      setStatus(
        body.quote && !paid
          ? `Locked ${body.quote.totalDisplay}. Pay when you are ready.`
          : 'Ready.',
      );
      setProcess(null);
      await ensureLocal(withReply, nextQuote, id, nextCart);
      const launch = body.checkout;
      if (launch && typeof launch === 'object' && 'checkoutId' in launch && launch.checkoutId) {
        // Typed "pay" / "yes": the server already prepared Razorpay, so open it like voice does.
        setProcess('working');
        setStatus(razorpayWorkCopy('open-checkout'));
        void openCheckout(launch).catch(() => {
          setStatus(buyerFacingError('CHECKOUT_SCRIPT_FAILED'));
        });
      }
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
      const pendingId = conversationRef.current;
      if (code === 'TURN_TIMEOUT' && pendingId) {
        // The server keeps working after we stop waiting; pick up its cart/quote when it lands.
        void syncSnapshot(pendingId);
        window.setTimeout(() => void syncSnapshot(pendingId), 20_000);
      } else if (echo) {
        setDraft((current) => current || text);
      }
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
    conversationRef.current = created.id;
    setConversationId(created.id);
    await ensureLocal(logRef.current, quoteRef.current, created.id);
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
    endedReasonRef.current = null;
    try {
      client?.stop();
    } catch {
      // already stopped
    }
    setVoicePhase(nextPhase);
    // Always clear: a stuck process disables Buy now, Browse shop and the quantity steppers.
    setProcess(null);
    setStatus(nextPhase === 'error' ? voiceStatusCopy('error', nextStatus) : nextStatus);
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
      const endedReason = voiceEndedReason(message);
      if (endedReason) {
        endedReasonRef.current = endedReason;
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
      stopTalkSession(voiceCallEndCopy(endedReasonRef.current));
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
    endedReasonRef.current = null;
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
      let token = await getAccessToken();
      if (generation !== talkGeneration.current) {
        return;
      }
      if (token && refreshAccessToken && accessTokenExpiresWithin(token, TALK_MAX_SECONDS + 60)) {
        // Vapi sends this token on every turn of the call, so it must outlive the call.
        token = (await refreshAccessToken().catch(() => null)) ?? token;
        if (generation !== talkGeneration.current) {
          return;
        }
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
      let pollFailures = 0;
      talkPoll.current = window.setInterval(() => {
        void fetchPendingConversationSnapshot<ConversationSnapshot>({
          conversationId: id,
          shopSlug,
        })
          .then(async (snap) => {
            pollFailures = 0;
            if (!snap || generation !== talkGeneration.current) {
              return;
            }
            if (snap.quote) {
              adoptQuote(snap.quote);
            }
            if (snap.cart !== undefined) {
              setCart(cartSnapshotFromTurn({ cart: snap.cart, quote: snap.quote }));
            }
            if (snap.checkout?.checkoutId) {
              setProcess('working');
              await openCheckout(snap.checkout);
            }
          })
          .catch(() => {
            // Stop hammering a failing API (shared rate limit); the call itself keeps going.
            pollFailures += 1;
            if (pollFailures >= 5 && talkPoll.current) {
              window.clearInterval(talkPoll.current);
              talkPoll.current = null;
            }
          });
      }, 3000);
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

  const movesBusy = Boolean(process) || talking;
  // During Talk, process mirrors the voice orb; Pay stays usable there (payingRef guards repeats).
  const payBusy = Boolean(process) && !talking;
  const blankStarters = [
    'What do you sell?',
    shop[0] ? `Tell me about ${shop[0].title}` : 'What is popular here?',
  ];

  return (
    <div className={quote || pay ? 'workspace has-rail' : 'workspace'}>
      <div className="chat-col">
        <div className="transcript">
          {log.length === 0 ? (
            <div className="blank concierge-blank">
              <p>Ask, pick items, Buy now, and pay.</p>
              <div className="starter-chips">
                {shop.length > 0 && !quote ? (
                  <button
                    type="button"
                    disabled={movesBusy}
                    onClick={() => {
                      setShelfQuery('');
                      setShelf('browse');
                    }}
                  >
                    {BROWSE_SHOP_LABEL}
                  </button>
                ) : null}
                {blankStarters.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    disabled={movesBusy}
                    onClick={() => void sendChatRef.current(starter)}
                  >
                    {starter}
                  </button>
                ))}
              </div>
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
                    busy={movesBusy}
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
                          disabled={movesBusy}
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
                          disabled={movesBusy}
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
                          disabled={movesBusy}
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
                        busy={payBusy}
                        receiptHref={pay?.id ? `/orders/${pay.id}` : null}
                        newOrderHref={`/buyer/${encodeURIComponent(shopSlug)}`}
                        testHint={razorpayMode === 'test'}
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
          {process && !talking ? (
            <ProcessOrb state={process} label={status} size={64} theme="light" />
          ) : null}
          {voiceOrbState(voicePhase) ? (
            <ProcessOrb
              className="process-orb-voice"
              state={voiceOrbState(voicePhase)!}
              label={voiceStatusCopy(voicePhase)}
              size={64}
              theme="light"
            />
          ) : null}
          <div ref={endRef} className="transcript-end" aria-hidden="true" />
        </div>
        <form
          ref={composerRef}
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
              maxLength={1000}
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
                // Enter never adds a newline; while busy it simply waits.
                event.preventDefault();
                if (talking || process) {
                  return;
                }
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
                disabled={!voiceReady && !talking}
                title={voiceReady || talking ? undefined : 'Voice is off in this demo'}
                onClick={() => void toggleTalk()}
              >
                <MicIcon />
                <span className="sr-only">{talkButtonLabel(voicePhase)}</span>
              </button>
              <button
                type="submit"
                className="composer-icon composer-send"
                aria-label="Send"
                disabled={talking || Boolean(process) || !draft.trim()}
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
              isTalkSessionActive(voicePhase) ||
              Boolean(process)
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
            {shop.length === 0 ? (
              <p>{catalogFailed ? 'Catalog unavailable right now.' : 'Catalog is loading…'}</p>
            ) : null}
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
                busy={payBusy}
                onPay={() => void payFrozenQuote()}
                onCheckStatus={() => void checkPaymentStatus()}
              />
              {pay ? (
                <div className="pay-status">
                  <span className="tag" data-tone={pay.status === 'SETTLED' ? 'ok' : 'hold'}>
                    {payStatusLabel(pay.status)}
                  </span>
                  <ChatMarkdown text={pay.copy} />
                </div>
              ) : null}
              {pay?.status === 'SETTLED' && pay.id ? (
                <p>
                  <Link to={`/orders/${pay.id}`}>View buyer receipt</Link>
                </p>
              ) : null}
              {recoveryReady && pay?.status === 'FAILED_PROVISIONAL' ? (
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
                                  buyerFacingError(
                                    error instanceof ApiError ? error.code : 'CONSENT_ERROR',
                                  ),
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
          emptyText={
            shelf === 'cart'
              ? 'Your cart is empty — browse the shop to add something.'
              : catalogFailed
                ? 'Catalog unavailable right now. Ask Concierge in the chat instead.'
                : 'No items match that search.'
          }
          quantityFor={(item) => displayQuantity(picks, cart, item, shop)}
          onQuantity={applyPickQuantity}
          busy={movesBusy || Boolean(quote)}
          onClose={() => setShelf(null)}
          onBuyNow={offerBuyNow ? submitBuyNow : undefined}
        />
      ) : null}
    </div>
  );
}
