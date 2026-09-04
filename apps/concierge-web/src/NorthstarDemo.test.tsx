// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';
import {
  checkoutFromBlockedCode,
  FrozenQuotePayButtons,
  NorthstarDemo,
  shouldHideDirectPay,
  shouldRenderDirectPayButton,
  shouldShowSameOrderRetry,
  shouldShowSameOrderRetryControl,
  shouldSubmitComposerKey,
  withPaymentThreadMessage,
} from './NorthstarDemo';
import { setAccessTokenProvider } from './api';
import { getThread, upsertThread } from './threads';

const vapiListeners = new Map<string, Array<(payload?: unknown) => void>>();
const vapiStart = vi.fn(async () => undefined);
const vapiStop = vi.fn();

vi.mock('@vapi-ai/web', () => ({
  default: class {
    on(event: string, listener: (payload?: unknown) => void) {
      const existing = vapiListeners.get(event) ?? [];
      existing.push(listener);
      vapiListeners.set(event, existing);
    }
    start = vapiStart;
    stop = vapiStop;
  },
}));

function emitVapi(event: string, payload?: unknown) {
  for (const listener of vapiListeners.get(event) ?? []) {
    listener(payload);
  }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vapiListeners.clear();
  vapiStart.mockClear();
  vapiStop.mockClear();
  setAccessTokenProvider(async () => null);
});

function keyEvent(partial: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}) {
  return {
    key: partial.key,
    shiftKey: partial.shiftKey ?? false,
    nativeEvent: {
      isComposing: partial.isComposing ?? false,
      keyCode: partial.keyCode,
    },
  };
}

describe('buyer pay surface', () => {
  it('hides direct Pay after provisional failure, reconciling, authorized, or captured', () => {
    expect(shouldHideDirectPay(undefined)).toBe(false);
    expect(shouldHideDirectPay('CREATED')).toBe(false);
    expect(shouldHideDirectPay('FAILED_PROVISIONAL')).toBe(true);
    expect(shouldHideDirectPay('RECONCILING')).toBe(true);
    expect(shouldHideDirectPay('CAPTURE_PENDING')).toBe(true);
    expect(shouldHideDirectPay('SETTLED')).toBe(true);
  });

  it('shows same-Order retry only after authoritative reconcile says retry-safe', () => {
    expect(shouldShowSameOrderRetry(undefined)).toBe(false);
    expect(shouldShowSameOrderRetry('FAILED_PROVISIONAL')).toBe(false);
    expect(shouldShowSameOrderRetry('created')).toBe(false);
    expect(shouldShowSameOrderRetry('unknown_attempts')).toBe(false);
    expect(shouldShowSameOrderRetry('authorized')).toBe(false);
    expect(shouldShowSameOrderRetry('captured')).toBe(false);
    expect(shouldShowSameOrderRetry('provider_unavailable')).toBe(false);
    expect(shouldShowSameOrderRetry('same_order_retry_safe')).toBe(true);
    expect(shouldShowSameOrderRetryControl('FAILED_PROVISIONAL', 'same_order_retry_safe')).toBe(
      true,
    );
    expect(shouldShowSameOrderRetryControl('CREATED', 'same_order_retry_safe')).toBe(true);
    expect(shouldShowSameOrderRetryControl('SETTLED', 'same_order_retry_safe')).toBe(false);
    expect(shouldShowSameOrderRetryControl('CAPTURE_PENDING', 'same_order_retry_safe')).toBe(false);
    expect(shouldShowSameOrderRetryControl('RECONCILING', 'same_order_retry_safe')).toBe(false);
    expect(shouldRenderDirectPayButton('SETTLED', 'same_order_retry_safe')).toBe(false);
    expect(shouldRenderDirectPayButton('CAPTURE_PENDING', 'same_order_retry_safe')).toBe(false);
    expect(shouldRenderDirectPayButton('RECONCILING', 'same_order_retry_safe')).toBe(false);
    expect(shouldRenderDirectPayButton('FAILED_PROVISIONAL', null)).toBe(false);
    expect(shouldRenderDirectPayButton('CREATED', 'same_order_retry_safe')).toBe(true);
  });

  it('maps blocked checkout codes to truthful pay state', () => {
    expect(checkoutFromBlockedCode('PAYMENT_REFUNDED')).toMatchObject({
      status: 'RECONCILING',
      providerStatus: 'refunded',
      retryAllowed: false,
      reconciliationOutcome: 'refunded',
    });
    expect(checkoutFromBlockedCode('PAYMENT_AUTHORIZED')).toMatchObject({
      status: 'CAPTURE_PENDING',
      providerStatus: 'authorized',
      retryAllowed: false,
    });
    expect(checkoutFromBlockedCode('QUOTE_ALREADY_PAID')).toMatchObject({
      status: 'SETTLED',
      providerStatus: 'captured',
      retryAllowed: false,
    });
    expect(checkoutFromBlockedCode('RECONCILIATION_REQUIRED')).toBeNull();
  });

  it('wires hide, retry, and check-status buttons from checkout state', () => {
    const onPay = vi.fn();
    const onCheckStatus = vi.fn();

    const { rerender } = render(
      <FrozenQuotePayButtons
        quoteDisplay="₹2,347.00"
        pay={{
          status: 'FAILED_PROVISIONAL',
          copy: 'Payment not confirmed.',
          paymentId: null,
          providerStatus: 'failed',
        }}
        onPay={onPay}
        onCheckStatus={onCheckStatus}
      />,
    );

    expect(screen.queryByRole('button', { name: /pay /i })).toBeNull();
    expect(screen.getByRole('button', { name: /check payment status/i })).toBeVisible();

    rerender(
      <FrozenQuotePayButtons
        quoteDisplay="₹2,347.00"
        pay={{
          status: 'FAILED_PROVISIONAL',
          copy: 'Retry on the same Razorpay Order.',
          paymentId: null,
          providerStatus: 'failed',
          retryAllowed: true,
          reconciliationOutcome: 'same_order_retry_safe',
        }}
        onPay={onPay}
        onCheckStatus={onCheckStatus}
      />,
    );

    expect(screen.getByRole('button', { name: /retry same order/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /check payment status/i })).toBeNull();

    rerender(
      <FrozenQuotePayButtons
        quoteDisplay="₹1,998.00"
        pay={{
          status: 'SETTLED',
          copy: 'Payment captured. One Charter order; inventory will commit once.',
          paymentId: 'pay_captured',
          providerStatus: 'captured',
          retryAllowed: true,
          reconciliationOutcome: 'same_order_retry_safe',
        }}
        onPay={onPay}
        onCheckStatus={onCheckStatus}
      />,
    );

    expect(screen.queryByRole('button', { name: /pay /i })).toBeNull();
    expect(screen.queryByRole('button', { name: /retry same order/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /check payment status/i })).toBeNull();
  });
});

describe('composer Enter key', () => {
  it('sends on Enter, newlines on Shift+Enter, and ignores IME composition', () => {
    expect(shouldSubmitComposerKey(keyEvent({ key: 'Enter' }))).toBe(true);
    expect(shouldSubmitComposerKey(keyEvent({ key: 'Enter', shiftKey: true }))).toBe(false);
    expect(shouldSubmitComposerKey(keyEvent({ key: 'a' }))).toBe(false);
    expect(shouldSubmitComposerKey(keyEvent({ key: 'Enter', isComposing: true }))).toBe(false);
    expect(shouldSubmitComposerKey(keyEvent({ key: 'Enter', keyCode: 229 }))).toBe(false);
  });
});

describe('concierge markdown', () => {
  it('renders bold, lists, and GFM tables without raw HTML', () => {
    render(
      <ChatMarkdown
        text={[
          'Try the **Steel travel press**.',
          '',
          '- Compact',
          '- Packs flat',
          '',
          '| Product | Price |',
          '| --- | --- |',
          '| Steel travel press | ₹2,347 |',
          '',
          '<script>window.__xss = 1</script>',
          '<img src=x onerror="window.__xss=1">',
        ].join('\n')}
      />,
    );

    expect(screen.getByText('Steel travel press', { selector: 'strong' }).tagName).toBe('STRONG');
    expect(screen.getByText('Compact').closest('li')).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Product' })).toBeVisible();
    expect(screen.getByRole('cell', { name: '₹2,347' })).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).not.toMatch(/<script>/i);
  });

  it('does not render a bare amount line as an ordered list outside the bubble', () => {
    const numbered = render(<ChatMarkdown text={'Delivery by 20.\n260906.'} />);
    expect(numbered.container.querySelector('ol')).toBeNull();
    expect(numbered.container.textContent).toMatch(/260906/);
    numbered.unmount();
  });

  it('renders assistant markdown in the chat bubble, not buyer text', () => {
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-md',
        conversationId: null,
        title: 'press',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'plain **asterisks** stay raw' },
          {
            role: 'concierge',
            text: 'Try the **Steel travel press**.\n\n| Product | Price |\n| --- | --- |\n| Press | ₹2,347 |',
          },
        ],
        quote: null,
      },
    );

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId="thread-md"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    const you = screen.getByText('plain **asterisks** stay raw');
    expect(you.closest('.bubble')).toHaveAttribute('data-role', 'you');
    expect(you.querySelector('strong')).toBeNull();
    expect(screen.getByText('Steel travel press').tagName).toBe('STRONG');
    expect(screen.getByRole('columnheader', { name: 'Product' })).toBeVisible();
    expect(document.querySelector('.composer-box')?.textContent).not.toMatch(/Steel travel press/);
    expect(document.querySelector('.composer-box')?.textContent).not.toMatch(/\*\*/);
  });

  it('shows assistant markdown once in the transcript, not under Send/Talk', () => {
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-cart-md',
        conversationId: null,
        title: 'cart',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'show cart' },
          {
            role: 'concierge',
            text: '**Current cart:**\n\nHand grinder × 2\n\n**Total: ₹1,998.00**',
          },
        ],
        quote: null,
      },
    );

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId="thread-cart-md"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('Current cart:')).toHaveLength(1);
    expect(screen.getByText('Current cart:').tagName).toBe('STRONG');
    expect(screen.getByText('Total: ₹1,998.00').tagName).toBe('STRONG');
    expect(document.body.textContent).not.toMatch(/\*\*Current cart:\*\*/);
    expect(document.querySelector('.composer-box')?.textContent).not.toMatch(/Current cart/);
    expect(screen.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  it('sends on Enter from the composer and keeps Shift+Enter as a newline', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/conversations') && !url.includes('/turns')) {
        return new Response(JSON.stringify({ id: 'conv-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/turns')) {
        return new Response(JSON.stringify({ reply: 'Noted the **Steel travel press**.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId={null}
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    const box = screen.getByLabelText('Message to Concierge');
    await user.click(box);
    await user.keyboard('Need a press{Shift>}{Enter}{/Shift}second line');
    expect(box).toHaveValue('Need a press\nsecond line');

    await user.clear(box);
    await user.type(box, 'Need a press');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Need a press')).toBeVisible();
    expect(await screen.findByText('Steel travel press')).toHaveProperty('tagName', 'STRONG');
    expect(document.querySelector('.composer-box')?.textContent).not.toMatch(/Steel travel press/);
    expect(document.body.textContent).not.toMatch(/\*\*Steel travel press\*\*/);
  });

  it('auto-sends a buy intent without an extra Send click', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/conversations') && !url.includes('/turns')) {
        return new Response(JSON.stringify({ id: 'conv-auto' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/turns')) {
        return new Response(JSON.stringify({ reply: 'Added **Hand grinder**.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ items: [], voiceEnabled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId={null}
          initialDraft="I'd like to buy Hand grinder."
          autoSend
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("I'd like to buy Hand grinder.")).toBeVisible();
    expect(await screen.findByText('Hand grinder')).toHaveProperty('tagName', 'STRONG');
    await waitFor(() => expect(screen.getByLabelText('Message to Concierge')).toHaveValue(''));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/conversations\/conv-auto\/turns$/),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('payment outcome in the chat thread', () => {
  const capturedCopy = 'Payment captured. One Charter order; inventory will commit once.';
  const failedCopy =
    'Payment not confirmed. Reconciling before any retry. Do not assume nothing was charged.';

  it('appends captured and failed-provisional copy once, then persists for history reload', () => {
    const prior = [
      { role: 'you' as const, text: 'buy the press' },
      { role: 'concierge' as const, text: 'Pay ₹2,347.00 when you are ready.' },
    ];
    const captured = withPaymentThreadMessage(prior, {
      status: 'SETTLED',
      copy: capturedCopy,
    });
    expect(captured.at(-1)).toEqual({ role: 'concierge', text: capturedCopy });
    expect(
      withPaymentThreadMessage(captured, { status: 'SETTLED', copy: capturedCopy }),
    ).toHaveLength(captured.length);
    expect(
      withPaymentThreadMessage(prior, { status: 'CREATED', copy: 'Awaiting payment.' }),
    ).toEqual(prior);

    const failed = withPaymentThreadMessage(prior, {
      status: 'FAILED_PROVISIONAL',
      copy: failedCopy,
    });
    expect(failed.at(-1)).toEqual({ role: 'concierge', text: failedCopy });

    const refundedCopy = 'Payment not confirmed. Reconciling provider state.';
    const refunded = withPaymentThreadMessage(prior, {
      status: 'RECONCILING',
      copy: refundedCopy,
    });
    expect(refunded.at(-1)).toEqual({ role: 'concierge', text: refundedCopy });

    const scope = { userId: 'user-buyer', shopId: 'northstar-demo-in' };
    upsertThread(scope, {
      id: 'thread-pay',
      conversationId: 'conv-pay',
      title: 'buy the press',
      updatedAt: new Date().toISOString(),
      messages: captured,
      quote: null,
    });
    expect(getThread(scope, 'thread-pay')?.messages.at(-1)?.text).toBe(capturedCopy);
  });

  it('dedupes SETTLED copy across poll and voice regardless of source', () => {
    const voiced = [
      { role: 'you' as const, text: 'checkout' },
      { role: 'concierge' as const, text: capturedCopy, source: 'voice' as const },
    ];
    expect(withPaymentThreadMessage(voiced, { status: 'SETTLED', copy: capturedCopy })).toEqual(
      voiced,
    );
    expect(
      withPaymentThreadMessage(voiced, { status: 'SETTLED', copy: 'Payment captured.' }),
    ).toEqual(voiced);

    const shortVoice = [
      { role: 'concierge' as const, text: 'Payment captured.', source: 'voice' as const },
    ];
    expect(
      withPaymentThreadMessage(shortVoice, { status: 'SETTLED', copy: capturedCopy }).at(-1),
    ).toEqual({ role: 'concierge', text: capturedCopy });

    const polled = [{ role: 'concierge' as const, text: capturedCopy }];
    expect(
      withPaymentThreadMessage(polled, { status: 'SETTLED', copy: capturedCopy }),
    ).toHaveLength(1);
  });

  it('shows a persisted capture acknowledgement in the Concierge bubble after reload', () => {
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-pay-reload',
        conversationId: 'conv-pay',
        title: 'buy the press',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'buy the press' },
          { role: 'concierge', text: capturedCopy },
        ],
        quote: null,
      },
    );

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId="thread-pay-reload"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    const bubble = screen.getByText(capturedCopy).closest('.bubble');
    expect(bubble).toHaveAttribute('data-role', 'concierge');
    expect(screen.getByText('buy the press').closest('.bubble')).toHaveAttribute(
      'data-role',
      'you',
    );
  });

  it('shows clickable product thumbnails from Concierge copy and can ask in the same chat', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/catalog')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v1/conversations') && !url.includes('/turns')) {
        return new Response(JSON.stringify({ id: 'conv-peek' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/turns')) {
        return new Response(JSON.stringify({ reply: 'The Cotton crew tee is 180 GSM.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-products',
        conversationId: null,
        title: 'gift',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'a gift for my gf' },
          {
            role: 'concierge',
            text: '- **Cotton crew tee** — ₹1,299\n- **Sand silk scarf** — ₹2,499',
          },
        ],
        quote: null,
      },
    );

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId="thread-products"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    const card = await screen.findByRole('button', { name: /^Cotton crew tee/ });
    expect(card.querySelector('img.catalog-thumb-photo')?.getAttribute('src')).toBe(
      '/thumbs/tee.jpg',
    );
    expect(screen.getByRole('button', { name: 'More Cotton crew tee' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Talk' }).closest('.composer-box')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).closest('.composer-box')).toBeTruthy();
    await user.click(card);
    expect(screen.getByRole('dialog', { name: 'Cotton crew tee' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Ask Concierge' }));
    expect(await screen.findByText('Tell me more about Cotton crew tee')).toBeVisible();
  });

  it('offers Buy now after an add so the shopper does not have to type freeze', async () => {
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-cart',
        conversationId: null,
        title: 'flowers',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'Add Dried flower bunch' },
          {
            role: 'concierge',
            text: 'The **Dried flower bunch** has been added to your cart. Cart total: ₹649.00',
          },
        ],
        quote: null,
      },
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/catalog')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/turns')) {
        return new Response(JSON.stringify({ reply: 'Locked total ₹649.00' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId="thread-cart"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    const lock = await screen.findByRole('button', { name: 'Buy now' });
    expect(lock).toBeVisible();
    expect(screen.getByText(/pins today’s prices/i)).toBeVisible();
  });

  it('puts plus and minus on an in-cart product instead of another Add', async () => {
    const user = userEvent.setup();
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-qty',
        conversationId: null,
        title: 'mill',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'Add Cast iron mill' },
          {
            role: 'concierge',
            text: 'Cast iron mill is in your cart — 1, totaling ₹899.00. Change quantity on the card, then Buy now.',
          },
        ],
        quote: null,
        cart: { lines: [{ sku: 'mill.cast-iron', quantity: 1 }], totalDisplay: '₹899.00' },
      },
    );

    const razorpayOpen = vi.fn();
    vi.stubGlobal(
      'Razorpay',
      class {
        open = razorpayOpen;
      },
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/catalog')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                sku: 'mill.cast-iron',
                title: 'Cast iron mill',
                priceDisplay: '₹899.00',
                stock: 8,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/v1/conversations') && !url.includes('/turns')) {
        return new Response(JSON.stringify({ id: 'conv-qty' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/turns')) {
        const text = String(init?.body ?? '');
        if (text.includes('Buy now')) {
          return new Response(
            JSON.stringify({
              reply: 'Locked total ₹1,798.00. Review the amount, then pay.',
              quote: {
                id: 'q-mill',
                totalDisplay: '₹1,798.00',
                deliveryBy: 'today',
                merchant: 'Harbor Spice',
                discountMinor: '0',
                lines: [{ sku: 'mill.cast-iron', title: 'Cast iron mill', quantity: 2 }],
              },
              cart: { lines: [{ sku: 'mill.cast-iron', quantity: 2 }], totalDisplay: '₹1,798.00' },
              checkout: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            reply: 'Cart is now 2 × Cast iron mill, totaling ₹1,798.00.',
            cart: { lines: [{ sku: 'mill.cast-iron', quantity: 2 }], totalDisplay: '₹1,798.00' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId="thread-qty"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'More Cast iron mill' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove Cast iron mill' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add Cast iron mill' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Buy now' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'More Cast iron mill' }));
    expect(screen.getByText(/2 in cart/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'View cart' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Buy now' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Buy now' }));
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('Put these in my cart');
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('Then lock this total');
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('Buy now');
    expect(await screen.findByText(/Locked total ₹1,798.00/i)).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Pay ₹1,798.00' }).length).toBeGreaterThan(0);
    expect(razorpayOpen).not.toHaveBeenCalled();
  });

  it('opens Browse shop as a searchable shelf without sending a chat prompt', async () => {
    const user = userEvent.setup();
    upsertThread(
      { userId: 'user-buyer', shopId: 'sable-atelier-in' },
      {
        id: 'thread-browse',
        conversationId: null,
        title: 'gift',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'a gift for my gf' },
          {
            role: 'concierge',
            text: '- **Cotton crew tee** — ₹1,299\n- **Sand silk scarf** — ₹2,499',
          },
        ],
        quote: null,
      },
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/catalog')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                sku: 'tee.crew-cotton',
                title: 'Cotton crew tee',
                priceDisplay: '₹1,299.00',
                stock: 24,
              },
              {
                sku: 'scarf.silk-sand',
                title: 'Sand silk scarf',
                priceDisplay: '₹2,499.00',
                stock: 9,
              },
              {
                sku: 'tote.canvas-day',
                title: 'Canvas day tote',
                priceDisplay: '₹1,899.00',
                stock: 14,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="sable-atelier-in"
          shopSlug="sable-atelier"
          merchantName="Sable Atelier"
          threadId="thread-browse"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Browse shop' }));
    const shelf = screen.getByRole('dialog', { name: 'Sable Atelier' });
    expect(shelf).toBeVisible();
    expect(within(shelf).getByLabelText('Search this shop')).toBeVisible();
    expect(within(shelf).getByText('Canvas day tote')).toBeVisible();
    await user.type(within(shelf).getByLabelText('Search this shop'), 'tote');
    expect(within(shelf).queryByText('Cotton crew tee')).toBeNull();
    expect(within(shelf).getByText('Canvas day tote')).toBeVisible();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('/turns');
    expect(screen.queryByText('Show more products from this shop')).toBeNull();
  });

  it('restores in-cart quantity controls from the live conversation cart', async () => {
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-restore-qty',
        conversationId: '82000000-0000-4000-8000-000000000099',
        title: 'mill',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'you', text: 'Add Cast iron mill' },
          {
            role: 'concierge',
            text: 'Cast iron mill is in your cart — 1, totaling ₹899.00.',
          },
        ],
        quote: null,
      },
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/catalog')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  sku: 'mill.cast-iron',
                  title: 'Cast iron mill',
                  priceDisplay: '₹899.00',
                  stock: 8,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/v1/conversations/82000000-0000-4000-8000-000000000099')) {
          return new Response(
            JSON.stringify({
              cart: { lines: [{ sku: 'mill.cast-iron', quantity: 2 }], totalDisplay: '₹1,798.00' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId="thread-restore-qty"
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'More Cast iron mill' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Fewer Cast iron mill' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add Cast iron mill' })).toBeNull();
    expect(screen.getByText(/2 in cart/)).toBeVisible();
  });
});

describe('talk voice surface', () => {
  it('shows connecting then listening, Stop as the obvious control, and upserts finals into the thread', async () => {
    const user = userEvent.setup();
    setAccessTokenProvider(async () => 'buyer-access-token');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/concierge/config')) {
        return new Response(
          JSON.stringify({
            voiceEnabled: true,
            vapiPublicKey: 'vapi_public_test',
            voiceModelBase: 'https://charter.example/api/v1/voice',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/v1/conversations') && !url.includes('/turns')) {
        return new Response(JSON.stringify({ id: '82000000-0000-4000-8000-000000000001' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId={null}
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    const talk = await screen.findByRole('button', { name: 'Talk' });
    expect(talk.closest('.composer-box')).toBeTruthy();
    await user.click(talk);
    await waitFor(() =>
      expect(document.querySelector('.transcript .process-orb-voice')).toBeTruthy(),
    );
    await waitFor(() => expect(vapiStart).toHaveBeenCalledTimes(1));
    expect(vapiStart).toHaveBeenCalledWith(
      expect.objectContaining({
        firstMessageInterruptionsEnabled: true,
        credentials: [{ provider: 'custom-llm', apiKey: 'buyer-access-token' }],
        model: expect.objectContaining({
          headers: { 'X-Charter-Shop-Slug': 'northstar' },
        }),
      }),
    );

    emitVapi('call-start');
    expect(await screen.findByRole('button', { name: 'Stop' })).toHaveClass('talk-stop');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await waitFor(() =>
      expect(document.querySelector('.composer')).toHaveAttribute('data-voice-phase', 'listening'),
    );

    emitVapi('message', {
      type: 'transcript',
      role: 'user',
      transcriptType: 'final',
      transcript: 'Add the steel travel press',
    });
    emitVapi('message', {
      type: 'transcript',
      role: 'assistant',
      transcriptType: 'final',
      transcript: 'Try the **Steel travel press**.',
    });

    expect(await screen.findByText('Add the steel travel press')).toBeVisible();
    expect(screen.getByText('Steel travel press').tagName).toBe('STRONG');
    expect(document.querySelector('.composer-box')?.textContent).not.toMatch(/Steel travel press/);

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(vapiStop).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Talk' })).toBeVisible();
  });

  it('shows VAPI_NOT_READY when voice config is incomplete', async () => {
    const user = userEvent.setup();
    setAccessTokenProvider(async () => 'buyer-access-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v1/concierge/config')) {
          return new Response(
            JSON.stringify({
              voiceEnabled: true,
              vapiPublicKey: 'vapi_public_test',
              voiceModelBase: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ voiceEnabled: true, vapiPublicKey: 'vapi_public_test' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    );

    render(
      <MemoryRouter>
        <NorthstarDemo
          userId="user-buyer"
          email="buyer@example.com"
          tenantId="northstar-demo-in"
          shopSlug="northstar"
          merchantName="Northstar Travel Coffee"
          threadId={null}
          onBound={() => undefined}
          onHistory={() => undefined}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Talk' }));
    expect(await screen.findByRole('status')).toHaveTextContent('VOICE_PUBLIC_URL_MISSING');
    expect(vapiStart).not.toHaveBeenCalled();
  });
});
