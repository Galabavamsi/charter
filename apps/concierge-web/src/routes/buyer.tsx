import { useEffect, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { useApi } from '../account';
import { buyerAskDraft, buyerBuyDraft } from '../buyer-session';
import { ConciergeShell, isConciergeBindState, type BoundShop } from '../ConciergeShell';
import { RouteStatus } from '../route-guards';

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function BuyerHomePage() {
  return <ConciergeShell />;
}

export function BuyerPage() {
  const api = useApi();
  const location = useLocation();
  const { slug = '', id: threadId } = useParams();
  const [searchParams] = useSearchParams();
  const bindState = isConciergeBindState(location.state) ? location.state : null;
  const [shop, setShop] = useState<BoundShop | null>(() =>
    bindState?.boundShop.merchant.slug === slug ? bindState.boundShop : null,
  );
  const [failed, setFailed] = useState(false);
  const requestedIntent = searchParams.get('intent');
  const rawRequestedSku = searchParams.get('product');
  const requestedSku =
    (requestedIntent === 'ask' || requestedIntent === 'buy') &&
    rawRequestedSku &&
    rawRequestedSku.length <= 160 &&
    !hasControlCharacters(rawRequestedSku)
      ? rawRequestedSku
      : null;

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setShop((current) => (current?.merchant.slug === slug ? current : null));
    const query = requestedSku ? `?${new URLSearchParams({ sku: requestedSku }).toString()}` : '';
    void api<BoundShop>(`/v1/shops/${encodeURIComponent(slug)}${query}`, {
      signal: controller.signal,
    })
      .then((body) => {
        if (!controller.signal.aborted) {
          setShop(body);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      });
    return () => {
      controller.abort();
    };
  }, [api, requestedSku, slug]);

  if (failed) {
    return (
      <RouteStatus
        code="404"
        title="Shop not found"
        body="This buyer workspace cannot open because the canonical shop is unavailable."
      />
    );
  }
  if (!shop) {
    return <RouteStatus title="Opening Concierge" body="Loading the selected shop…" />;
  }
  const intendedProduct = requestedSku
    ? shop.items?.find((item) => item.sku === requestedSku)
    : undefined;
  const initialDraft = intendedProduct
    ? requestedIntent === 'buy'
      ? buyerBuyDraft(intendedProduct.title)
      : buyerAskDraft(intendedProduct.title)
    : '';
  const autoSend = requestedIntent === 'buy' && Boolean(intendedProduct) && !threadId;
  const seededMessages = bindState?.boundShop.merchant.slug === slug ? bindState.messages : [];

  return (
    <ConciergeShell
      boundShop={shop}
      threadId={threadId ?? null}
      initialDraft={initialDraft}
      autoSend={autoSend}
      seededMessages={seededMessages}
    />
  );
}
