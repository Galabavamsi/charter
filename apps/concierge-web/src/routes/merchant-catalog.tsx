import { useEffect, useState } from 'react';
import { useApi } from '../account';
import { canManageCatalog } from '../capabilities';
import {
  FormNotice,
  MerchantEmpty,
  MerchantError,
  MerchantLoading,
  MerchantPageHeader,
  RecordStatus,
} from '../merchant-components';
import { useMerchantShop } from '../merchant-context';
import {
  merchantCommandKey,
  merchantErrorMessage,
  useMerchantPagedResource,
  type MerchantCatalogItem,
} from '../merchant-api';

type ProductDraft = {
  title: string;
  description: string;
  category: string;
  sku: string;
  material: MerchantCatalogItem['material'];
  price: string;
  stock: string;
  status: MerchantCatalogItem['status'];
};

const EMPTY_DRAFT: ProductDraft = {
  title: '',
  description: '',
  category: '',
  sku: '',
  material: 'other',
  price: '',
  stock: '0',
  status: 'draft',
};

const EXACT_INR = /^(0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;

function priceInput(item: MerchantCatalogItem): string {
  const minor = BigInt(item.priceMinor);
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function humanStatus(status: MerchantCatalogItem['status']) {
  return status[0]!.toUpperCase() + status.slice(1);
}

export function MerchantCatalogPage() {
  const api = useApi();
  const shop = useMerchantShop();
  const canWrite = canManageCatalog(shop.role);
  const resource = useMerchantPagedResource<MerchantCatalogItem>(
    `/v1/merchant/shops/${shop.tenantId}/catalog?limit=50`,
    (item) => item.productId,
  );
  const [items, setItems] = useState<MerchantCatalogItem[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MerchantCatalogItem | null>(null);
  const [draft, setDraft] = useState<ProductDraft>(EMPTY_DRAFT);
  const [stockEditor, setStockEditor] = useState<string | null>(null);
  const [stockDelta, setStockDelta] = useState('');
  const [stockReason, setStockReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setItems(resource.items);
  }, [resource.items]);

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setError(null);
    setSuccess(null);
    setEditorOpen(true);
  }

  function openEdit(item: MerchantCatalogItem) {
    setEditing(item);
    setDraft({
      title: item.title,
      description: item.description,
      category: item.category?.title ?? '',
      sku: item.sku,
      material: item.material,
      price: priceInput(item),
      stock: String(item.inventory.onHand),
      status: item.status,
    });
    setError(null);
    setSuccess(null);
    setEditorOpen(true);
  }

  function validateProduct(): string | null {
    if (!EXACT_INR.test(draft.price)) {
      return 'Use rupees with no more than 2 decimal places.';
    }
    if (!Number.isSafeInteger(Number(draft.stock)) || Number(draft.stock) < 0) {
      return 'Stock must be a whole number of units.';
    }
    if (
      draft.status === 'published' &&
      (!draft.title.trim() ||
        !draft.description.trim() ||
        !draft.category.trim() ||
        !draft.sku.trim() ||
        Number(draft.price) <= 0 ||
        Number(draft.stock) <= 0)
    ) {
      return 'Published products need title, description, category, SKU, positive price, and stock.';
    }
    return null;
  }

  async function saveProduct() {
    const validation = validateProduct();
    if (validation) {
      setError(validation);
      setSuccess(null);
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    const body = {
      ...(editing ? { expectedVersion: editing.productVersion } : {}),
      title: draft.title.trim(),
      description: draft.description.trim(),
      category: draft.category.trim(),
      sku: draft.sku.trim(),
      material: draft.material,
      price: draft.price,
      ...(editing ? {} : { stock: Number(draft.stock) }),
      status: draft.status,
      ...(editing ? { reason: 'Catalog record edited by a merchant member.' } : {}),
    };
    const path = editing
      ? `/v1/merchant/shops/${shop.tenantId}/catalog/products/${editing.productId}`
      : `/v1/merchant/shops/${shop.tenantId}/catalog/products`;
    try {
      const response = await api<{ item: MerchantCatalogItem }>(path, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'idempotency-key': merchantCommandKey('catalog-product') },
        body: JSON.stringify(body),
      });
      setItems((current) => {
        const without = current.filter((item) => item.productId !== response.item.productId);
        return [response.item, ...without];
      });
      setSuccess('Product saved');
      setEditorOpen(false);
      setEditing(null);
    } catch (cause) {
      setError(merchantErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function adjustStock(item: MerchantCatalogItem) {
    const delta = Number(stockDelta);
    if (!Number.isSafeInteger(delta) || delta === 0) {
      setError('Stock change must be a non-zero whole number.');
      return;
    }
    if (stockReason.trim().length < 3) {
      setError('Record a reason for every stock adjustment.');
      return;
    }
    const previous = item.inventory;
    const optimistic = {
      onHand: previous.onHand + delta,
      reserved: previous.reserved,
      available: previous.available + delta,
      version: previous.version + 1,
    };
    if (optimistic.onHand < previous.reserved) {
      setError('This change would reduce stock below reserved units.');
      return;
    }
    setItems((current) =>
      current.map((candidate) =>
        candidate.variantId === item.variantId
          ? { ...candidate, inventory: optimistic }
          : candidate,
      ),
    );
    setError(null);
    setSuccess(null);
    try {
      const response = await api<{ inventory: MerchantCatalogItem['inventory'] }>(
        `/v1/merchant/shops/${shop.tenantId}/catalog/variants/${item.variantId}/stock-adjustments`,
        {
          method: 'POST',
          headers: { 'idempotency-key': merchantCommandKey('stock-adjustment') },
          body: JSON.stringify({
            expectedVersion: previous.version,
            delta,
            reason: stockReason.trim(),
          }),
        },
      );
      setItems((current) =>
        current.map((candidate) =>
          candidate.variantId === item.variantId
            ? { ...candidate, inventory: response.inventory }
            : candidate,
        ),
      );
      setStockEditor(null);
      setStockDelta('');
      setStockReason('');
      setSuccess('Stock adjustment recorded');
    } catch (cause) {
      setItems((current) =>
        current.map((candidate) =>
          candidate.variantId === item.variantId
            ? { ...candidate, inventory: previous }
            : candidate,
        ),
      );
      setError(merchantErrorMessage(cause));
    }
  }

  const displayedItems = items.length === 0 && resource.items.length ? resource.items : items;

  return (
    <section className="merchant-page merchant-catalog-page">
      <MerchantPageHeader
        eyebrow="Canonical catalog"
        title="Catalog"
        description="Products, variants, exact INR prices, publication state, and audited inventory."
        actions={
          canWrite ? (
            <button type="button" onClick={openCreate}>
              Add product
            </button>
          ) : undefined
        }
      />
      {!canWrite ? (
        <p className="merchant-read-only">
          Read-only access. Catalog changes require an owner, admin, or catalog role.
        </p>
      ) : null}
      {error ? <FormNotice kind="error">{error}</FormNotice> : null}
      {success ? <FormNotice kind="success">{success}</FormNotice> : null}
      {editorOpen ? (
        <form
          className="merchant-record-form"
          aria-labelledby="catalog-editor-title"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProduct();
          }}
        >
          <div className="record-form-head">
            <h3 id="catalog-editor-title">{editing ? `Edit ${editing.title}` : 'New product'}</h3>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setEditorOpen(false);
                setError(null);
              }}
            >
              Close
            </button>
          </div>
          <div className="merchant-form-grid">
            <label>
              Title
              <input
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                maxLength={180}
                required
              />
            </label>
            <label className="field-wide">
              Description
              <textarea
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                maxLength={2000}
                rows={3}
              />
            </label>
            <label>
              Category
              <input
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                maxLength={120}
              />
            </label>
            <label>
              SKU
              <input
                value={draft.sku}
                onChange={(event) => setDraft({ ...draft, sku: event.target.value })}
                maxLength={160}
                required
              />
            </label>
            <label>
              Material
              <select
                value={draft.material}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    material: event.target.value as ProductDraft['material'],
                  })
                }
              >
                <option value="steel">Steel</option>
                <option value="glass">Glass</option>
                <option value="paper">Paper</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Price in INR
              <input
                value={draft.price}
                onChange={(event) => setDraft({ ...draft, price: event.target.value })}
                inputMode="decimal"
                placeholder="0.00"
                required
              />
            </label>
            <label>
              Stock
              <input
                value={draft.stock}
                onChange={(event) => setDraft({ ...draft, stock: event.target.value })}
                inputMode="numeric"
                disabled={Boolean(editing)}
                required
              />
            </label>
            <label>
              Status
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as ProductDraft['status'] })
                }
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </label>
          </div>
          <div className="record-form-actions">
            <button type="submit" disabled={busy}>
              {busy ? 'Saving product…' : 'Save product'}
            </button>
          </div>
        </form>
      ) : null}
      {resource.loading ? <MerchantLoading label="Loading catalog records" /> : null}
      {resource.error ? <MerchantError error={resource.error} retry={resource.reload} /> : null}
      {resource.loadMoreError ? (
        <MerchantError error={resource.loadMoreError} retry={resource.loadMore} />
      ) : null}
      {resource.items.length === 0 &&
      !resource.loading &&
      !resource.error &&
      displayedItems.length === 0 ? (
        <MerchantEmpty
          title="No catalog records"
          body="Create a draft product, then publish only after required facts and stock are complete."
          action={
            canWrite ? (
              <button type="button" onClick={openCreate}>
                Add product
              </button>
            ) : undefined
          }
        />
      ) : null}
      {displayedItems.length > 0 ? (
        <div className="record-table-wrap">
          <table className="record-table">
            <caption>Catalog products and inventory</caption>
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th>Price</th>
                <th>Inventory</th>
                <th>Material</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {displayedItems.map((item) => (
                <tr key={item.variantId}>
                  <td data-label="Product">
                    <strong>{item.title}</strong>
                    <small>{item.sku}</small>
                    <small>{item.category?.title ?? 'Uncategorised'}</small>
                  </td>
                  <td data-label="Status">
                    <RecordStatus
                      label={humanStatus(item.status)}
                      tone={
                        item.status === 'published'
                          ? 'ok'
                          : item.status === 'archived'
                            ? 'danger'
                            : 'warning'
                      }
                    />
                  </td>
                  <td data-label="Price">{item.priceDisplay}</td>
                  <td data-label="Inventory">
                    <strong>{item.inventory.available} available</strong>
                    <small>
                      {item.inventory.onHand} on hand · {item.inventory.reserved} reserved · v
                      {item.inventory.version}
                    </small>
                  </td>
                  <td data-label="Material">{item.material}</td>
                  <td data-label="Actions">
                    {canWrite ? (
                      <div className="record-actions">
                        <button type="button" className="ghost" onClick={() => openEdit(item)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => {
                            setStockEditor(item.variantId);
                            setStockDelta('');
                            setStockReason('');
                            setError(null);
                          }}
                        >
                          Adjust stock for {item.title}
                        </button>
                      </div>
                    ) : (
                      <span>View only</span>
                    )}
                    {stockEditor === item.variantId ? (
                      <form
                        className="stock-adjustment-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void adjustStock(item);
                        }}
                      >
                        <label>
                          Stock change for {item.title}
                          <input
                            value={stockDelta}
                            onChange={(event) => setStockDelta(event.target.value)}
                            inputMode="numeric"
                            placeholder="+3 or -2"
                            required
                          />
                        </label>
                        <label>
                          Reason for {item.title}
                          <input
                            value={stockReason}
                            onChange={(event) => setStockReason(event.target.value)}
                            maxLength={500}
                            required
                          />
                        </label>
                        <div className="record-actions">
                          <button type="submit">Record adjustment</button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => setStockEditor(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {resource.nextCursor ? (
        <button
          type="button"
          onClick={() => void resource.loadMore()}
          disabled={resource.loadingMore}
        >
          {resource.loadingMore ? 'Loading more catalog…' : 'Load more catalog'}
        </button>
      ) : null}
    </section>
  );
}
