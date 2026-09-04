import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useApi } from './account';
import { useAuth } from './auth';
import { rememberLastShop } from './buyer-session';
import { CatalogThumb } from './CatalogThumb';
import { SendIcon } from './ComposerIcons';
import { NorthstarDemo, shouldSubmitComposerKey } from './NorthstarDemo';
import { Onboard } from './Onboard';
import {
  CONCIERGE_STARTERS,
  conciergeDiscoverReply,
  directoryShopSearchPath,
  isLexicalSmallTalk,
  type PublicDirectoryResponse,
  type PublicShop,
} from './shops';
import {
  bindUnboundChatToShop,
  clearUnboundThreads,
  deleteUserThread,
  isUnboundThread,
  listAllUserThreads,
  listThreads,
  titleFrom,
  UNBOUND_SHOP_ID,
  upsertThread,
  type ChatMessage,
  type ListedThread,
} from './threads';

type DirectoryShop = PublicShop;

export type BoundShop = {
  shop: {
    tenantId: string;
    slug: string;
    name: string;
    blurb: string;
  };
  merchant: {
    tenantId: string;
    slug: string;
    name: string;
    blurb: string;
  };
  items?: Array<{ sku: string; title: string }>;
};

export type ConciergeBindState = {
  boundShop: BoundShop;
  messages: ChatMessage[];
};

export function isConciergeBindState(value: unknown): value is ConciergeBindState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<ConciergeBindState>;
  return Boolean(record.boundShop?.merchant?.slug) && Array.isArray(record.messages);
}

function boundShopFromDirectory(shop: DirectoryShop): BoundShop {
  const record = {
    tenantId: shop.tenantId,
    slug: shop.slug,
    name: shop.name,
    blurb: shop.blurb,
  };
  return { shop: record, merchant: record };
}

type UnboundRow = {
  role: 'you' | 'concierge';
  text: string;
  shops?: DirectoryShop[];
};

function shopPickMeta(shop: DirectoryShop): string {
  const rating = Number.isFinite(shop.rating) ? shop.rating.toFixed(1) : '0.0';
  const reviewCount = shop.reviewCount ?? 0;
  const category = shop.categories?.[0]?.title;
  return category
    ? `${rating} · ${reviewCount} reviews · ${category}`
    : `${rating} · ${reviewCount} reviews`;
}

function ShopPicks({
  shops,
  onPick,
}: {
  shops: DirectoryShop[];
  onPick: (shop: DirectoryShop) => void;
}) {
  return (
    <div className="shop-picks">
      {shops.map((shop) => (
        <button
          key={shop.tenantId}
          type="button"
          className="shop-pick"
          onClick={() => onPick(shop)}
        >
          <CatalogThumb label={shop.name} seed={shop.slug} />
          <span className="shop-pick-copy">
            <strong>{shop.name}</strong>
            <span>{shopPickMeta(shop)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function UnboundWorkspace({
  failed,
  userId,
  onHistory,
}: {
  failed: boolean;
  userId: string;
  onHistory: () => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const existing = listThreads({ userId, shopId: UNBOUND_SHOP_ID })[0];
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<UnboundRow[]>(() =>
    (existing?.messages ?? []).map((row) => ({ role: row.role, text: row.text })),
  );
  const localIdRef = useRef(existing?.id ?? null);

  function persist(nextLog: UnboundRow[], id: string) {
    const first = nextLog.find((row) => row.role === 'you')?.text ?? 'New chat';
    upsertThread(
      { userId, shopId: UNBOUND_SHOP_ID },
      {
        id,
        conversationId: null,
        title: titleFrom(first),
        updatedAt: new Date().toISOString(),
        messages: nextLog.map((row) => ({ role: row.role, text: row.text })),
        quote: null,
        shopSlug: UNBOUND_SHOP_ID,
        shopName: 'Concierge',
      },
    );
    onHistory();
  }

  function remember(nextLog: UnboundRow[]) {
    const id = localIdRef.current ?? crypto.randomUUID();
    localIdRef.current = id;
    persist(nextLog, id);
    return id;
  }

  function pickShop(shop: DirectoryShop) {
    const messages = log.map((row) => ({ role: row.role, text: row.text }));
    const boundShop = boundShopFromDirectory(shop);
    const id = bindUnboundChatToShop({
      userId,
      unboundId: localIdRef.current,
      shop: { tenantId: shop.tenantId, slug: shop.slug, name: shop.name },
      messages,
    });
    onHistory();
    void navigate(`/buyer/${shop.slug}/chat/${id}`, {
      replace: true,
      state: { boundShop, messages } satisfies ConciergeBindState,
    });
  }

  async function searchDirectory(text: string) {
    const query = text.trim();
    if (!query || busy) {
      return;
    }
    setBusy(true);
    setDraft('');
    const nextLog: UnboundRow[] = [...log, { role: 'you', text: query }];
    setLog(nextLog);
    remember(nextLog);
    if (isLexicalSmallTalk(query)) {
      const withReply = [
        ...nextLog,
        {
          role: 'concierge' as const,
          text: conciergeDiscoverReply(query, []),
        },
      ];
      setLog(withReply);
      remember(withReply);
      setBusy(false);
      return;
    }
    try {
      const body = await api<PublicDirectoryResponse>(directoryShopSearchPath(query));
      const matches = body.items ?? [];
      const withReply: UnboundRow[] = [
        ...nextLog,
        {
          role: 'concierge',
          text: conciergeDiscoverReply(query, matches),
          shops: matches,
        },
      ];
      setLog(withReply);
      remember(withReply);
    } catch {
      const withReply: UnboundRow[] = [
        ...nextLog,
        {
          role: 'concierge',
          text: 'I couldn’t search shops just then. Try again in a moment.',
        },
      ];
      setLog(withReply);
      remember(withReply);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace unbound-workspace">
      <div className="chat-col">
        <div className="transcript">
          {log.length === 0 ? (
            <div className="blank concierge-blank">
              <h2>What are you looking for?</h2>
              <p>
                Describe a product or who you’re buying for. I’ll match a shop, then we stay in this
                chat to add, quote, and pay.
              </p>
              <div className="starter-chips">
                {CONCIERGE_STARTERS.map((starter) => (
                  <button
                    key={starter.label}
                    type="button"
                    disabled={busy}
                    onClick={() => void searchDirectory(starter.text)}
                  >
                    {starter.label}
                  </button>
                ))}
              </div>
              {failed ? (
                <p role="alert">Shops could not be loaded. Try again in a moment.</p>
              ) : null}
            </div>
          ) : null}
          {log.map((row, index) => (
            <article key={`${row.role}-${index}`} className="bubble" data-role={row.role}>
              <strong className="bubble-role">{row.role === 'you' ? 'You' : 'Concierge'}</strong>
              <div className="bubble-plain">{row.text}</div>
              {row.shops && row.shops.length > 0 ? (
                <ShopPicks shops={row.shops} onPick={pickShop} />
              ) : null}
            </article>
          ))}
        </div>
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void searchDirectory(draft);
          }}
        >
          <div className="composer-box">
            <textarea
              id="buyer-composer"
              aria-label="Message to Concierge"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (!shouldSubmitComposerKey(event) || busy) {
                  return;
                }
                event.preventDefault();
                void searchDirectory(draft);
              }}
              placeholder="Message Concierge…"
              rows={1}
            />
            <div className="composer-actions">
              <button
                type="submit"
                className="composer-icon composer-send"
                disabled={busy || !draft.trim()}
                aria-label="Send"
              >
                <SendIcon />
                <span className="sr-only">Send</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ConciergeShell({
  boundShop = null,
  threadId = null,
  initialDraft = '',
  autoSend = false,
  seededMessages = [],
}: {
  boundShop?: BoundShop | null;
  threadId?: string | null;
  initialDraft?: string;
  autoSend?: boolean;
  seededMessages?: ChatMessage[];
}) {
  const api = useApi();
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = auth.session?.user.id ?? '';
  const [shops, setShops] = useState<DirectoryShop[]>([]);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [unboundEpoch, setUnboundEpoch] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const threads = useMemo(() => listAllUserThreads(userId, shops), [revision, shops, userId]);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void api<PublicDirectoryResponse>('/v1/shops', { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) {
          setShops(body.items ?? []);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setShops([]);
        }
      });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (!userId || !boundShop) {
      return;
    }
    rememberLastShop(userId, {
      slug: boundShop.merchant.slug,
      tenantId: boundShop.merchant.tenantId,
      threadId: threadId ?? null,
    });
  }, [boundShop, threadId, userId]);

  if (!auth.session) {
    return null;
  }

  function threadHref(thread: ListedThread): string {
    if (isUnboundThread(thread)) {
      return '/chats';
    }
    return `/buyer/${thread.shopSlug}/chat/${thread.id}`;
  }

  function startNewChat(event: MouseEvent<HTMLAnchorElement>) {
    if (boundShop) {
      return;
    }
    if (location.pathname === '/chats' || location.pathname === '/') {
      event.preventDefault();
      clearUnboundThreads(userId);
      setRevision((value) => value + 1);
      setUnboundEpoch((value) => value + 1);
    }
  }

  return (
    <section className="product-shell buyer-shell">
      <a className="skip-link skip-to-chat" href="#buyer-composer">
        Skip to chat
      </a>
      {guideOpen ? (
        <Onboard
          role="buyer"
          userId={auth.session.user.id}
          shopId={boundShop?.merchant.tenantId ?? 'unbound'}
          onClose={() => setGuideOpen(false)}
        />
      ) : null}
      <aside className="product-sidebar" aria-label="Your chats">
        <Link className="new-chat-link" to="/chats" onClick={startNewChat}>
          New chat
        </Link>
        <p className="sidebar-label">Your chats</p>
        <div className="thread-list">
          {threads.length === 0 ? <p className="empty-threads">No chats yet.</p> : null}
          {threads.map((thread) => (
            <div className="thread-row" key={`${thread.shopId}:${thread.id}`}>
              <Link
                aria-current={
                  threadId === thread.id ||
                  (!boundShop && isUnboundThread(thread) && location.pathname === '/chats')
                    ? 'page'
                    : undefined
                }
                to={threadHref(thread)}
              >
                <span className="thread-title">{thread.title}</span>
                <span className="thread-shop">{thread.shopName}</span>
              </Link>
              <button
                type="button"
                aria-label={`Remove ${thread.title}`}
                onClick={() => {
                  deleteUserThread(userId, thread);
                  setRevision((value) => value + 1);
                  if (thread.id === threadId) {
                    navigate('/chats', { replace: true });
                  }
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="sidebar-guide" onClick={() => setGuideOpen(true)}>
          How Charter works
        </button>
      </aside>
      <div className="product-workspace">
        <header className="workspace-head">
          <div>
            <h1 data-route-heading tabIndex={-1}>
              Concierge
            </h1>
            {boundShop ? <p className="shop-binding">{boundShop.merchant.name}</p> : null}
          </div>
        </header>
        {boundShop ? (
          <NorthstarDemo
            userId={auth.session.user.id}
            email={auth.session.user.email ?? ''}
            tenantId={boundShop.merchant.tenantId}
            shopSlug={boundShop.merchant.slug}
            merchantName={boundShop.merchant.name}
            threadId={threadId}
            seededMessages={seededMessages}
            initialDraft={initialDraft}
            autoSend={autoSend}
            onBound={(id) =>
              navigate(`/buyer/${boundShop.merchant.slug}/chat/${id}`, { replace: true })
            }
            onHistory={() => setRevision((value) => value + 1)}
          />
        ) : (
          <UnboundWorkspace
            key={unboundEpoch}
            failed={failed}
            userId={userId}
            onHistory={() => setRevision((value) => value + 1)}
          />
        )}
      </div>
    </section>
  );
}
