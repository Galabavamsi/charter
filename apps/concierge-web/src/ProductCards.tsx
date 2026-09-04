import { useEffect, useState } from 'react';
import { CatalogThumb } from './CatalogThumb';
import { matchingShopItems } from './chat-actions';
import { productsFromMessage, type CatalogVisualItem } from './catalog-visuals';

function cardMode(active: boolean, locked: boolean, quantity: number): 'qty' | 'locked' | 'none' {
  if (!active) {
    return 'none';
  }
  if (locked) {
    return quantity > 0 ? 'locked' : 'none';
  }
  return 'qty';
}

function QuantityStepper({
  title,
  quantity,
  busy,
  stock,
  onQuantity,
}: {
  title: string;
  quantity: number;
  busy: boolean;
  stock?: number;
  onQuantity: (next: number) => void;
}) {
  const atStock = typeof stock === 'number' && stock >= 0 && quantity >= stock;
  return (
    <div className="product-qty" role="group" aria-label={`${title} quantity`}>
      <button
        type="button"
        className="product-qty-btn"
        disabled={busy || quantity <= 0}
        aria-label={quantity <= 1 ? `Remove ${title}` : `Fewer ${title}`}
        onClick={() => onQuantity(quantity - 1)}
      >
        −
      </button>
      <span className="product-qty-value" aria-live="polite">
        {quantity}
      </span>
      <button
        type="button"
        className="product-qty-btn"
        disabled={busy || atStock}
        aria-label={`More ${title}`}
        onClick={() => onQuantity(quantity + 1)}
      >
        +
      </button>
    </div>
  );
}

export function MentionedProducts({
  text,
  items,
  busy = false,
  active = false,
  locked = false,
  quantityFor,
  onAsk,
  onQuantity,
}: {
  text: string;
  items: CatalogVisualItem[];
  busy?: boolean;
  active?: boolean;
  locked?: boolean;
  quantityFor: (item: CatalogVisualItem) => number;
  onAsk: (item: CatalogVisualItem) => void;
  onQuantity: (item: CatalogVisualItem, quantity: number) => void;
}) {
  const mentioned = productsFromMessage(text, items);
  const [open, setOpen] = useState<CatalogVisualItem | null>(null);
  const openQty = open ? quantityFor(open) : 0;
  const openMode = open ? cardMode(active, locked, openQty) : 'none';

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (mentioned.length === 0) {
    return null;
  }

  return (
    <>
      <div className="product-cards">
        {mentioned.map((item) => {
          const quantity = quantityFor(item);
          const mode = cardMode(active, locked, quantity);
          return (
            <article key={item.sku} className="product-card">
              <button type="button" className="product-card-open" onClick={() => setOpen(item)}>
                <CatalogThumb label={item.title} seed={item.sku} />
                <span>
                  <strong>{item.title}</strong>
                  <em>
                    {item.priceDisplay ?? 'View details'}
                    {quantity > 0 ? ` · ${quantity} in cart` : ''}
                  </em>
                </span>
              </button>
              {mode === 'qty' ? (
                <QuantityStepper
                  title={item.title}
                  quantity={quantity}
                  busy={busy}
                  stock={item.stock}
                  onQuantity={(next) => onQuantity(item, next)}
                />
              ) : null}
              {mode === 'locked' ? (
                <span className="product-qty-locked">{quantity} locked</span>
              ) : null}
            </article>
          );
        })}
      </div>
      {open ? (
        <div
          className="product-peek"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`product-peek-${open.sku}`}
        >
          <button
            type="button"
            className="product-peek-backdrop"
            aria-label="Close product"
            onClick={() => setOpen(null)}
          />
          <div className="product-peek-card">
            <CatalogThumb className="product-peek-thumb" label={open.title} seed={open.sku} />
            <h2 id={`product-peek-${open.sku}`}>{open.title}</h2>
            <p>{open.priceDisplay ?? open.sku}</p>
            {typeof open.stock === 'number' ? (
              <p>{open.stock > 0 ? `${open.stock} in stock` : 'Out of stock'}</p>
            ) : null}
            {open.material ? <p>Material: {open.material}</p> : null}
            <p className="product-peek-hint">
              {openMode === 'qty'
                ? 'Use + and − here. Open your cart to review, or Buy now when the mix looks right.'
                : openMode === 'locked'
                  ? 'This quantity is locked in the total. Pay that amount to checkout.'
                  : 'Open details here, or ask Concierge in this chat.'}
            </p>
            <div className="product-peek-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  onAsk(open);
                  setOpen(null);
                }}
              >
                Ask Concierge
              </button>
              {openMode === 'qty' ? (
                <QuantityStepper
                  title={open.title}
                  quantity={openQty}
                  busy={busy}
                  stock={open.stock}
                  onQuantity={(next) => onQuantity(open, next)}
                />
              ) : null}
              {openMode === 'locked' ? (
                <span className="product-qty-locked">{openQty} locked</span>
              ) : null}
            </div>
            <button type="button" className="ghost" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ShopShelf({
  open,
  title,
  hint,
  items,
  query,
  onQuery,
  showSearch,
  quantityFor,
  onQuantity,
  busy = false,
  onClose,
  onBuyNow,
}: {
  open: boolean;
  title: string;
  hint: string;
  items: CatalogVisualItem[];
  query: string;
  onQuery: (value: string) => void;
  showSearch: boolean;
  quantityFor: (item: CatalogVisualItem) => number;
  onQuantity: (item: CatalogVisualItem, quantity: number) => void;
  busy?: boolean;
  onClose: () => void;
  onBuyNow?: () => void;
}) {
  const visible = matchingShopItems(items, showSearch ? query : '');

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="product-peek product-shelf"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shop-shelf-title"
    >
      <button
        type="button"
        className="product-peek-backdrop"
        aria-label="Close shop"
        onClick={onClose}
      />
      <div className="product-peek-card product-shelf-card">
        <h2 id="shop-shelf-title">{title}</h2>
        {showSearch ? (
          <label className="product-shelf-search">
            Search this shop
            <input
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Search items"
              autoFocus
            />
          </label>
        ) : null}
        <p className="product-peek-hint">{hint}</p>
        {visible.length === 0 ? (
          <p className="product-peek-hint">No items match that search.</p>
        ) : (
          <div className="product-cards product-shelf-list">
            {visible.map((item) => {
              const quantity = quantityFor(item);
              return (
                <article key={item.sku} className="product-card">
                  <div className="product-card-open">
                    <CatalogThumb label={item.title} seed={item.sku} />
                    <span>
                      <strong>{item.title}</strong>
                      <em>
                        {item.priceDisplay ?? 'View details'}
                        {quantity > 0 ? ` · ${quantity} in cart` : ''}
                      </em>
                    </span>
                  </div>
                  <QuantityStepper
                    title={item.title}
                    quantity={quantity}
                    busy={busy}
                    stock={item.stock}
                    onQuantity={(next) => onQuantity(item, next)}
                  />
                </article>
              );
            })}
          </div>
        )}
        <div className="product-peek-actions product-shelf-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
          {onBuyNow ? (
            <button type="button" className="product-card-add" disabled={busy} onClick={onBuyNow}>
              Buy now
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
