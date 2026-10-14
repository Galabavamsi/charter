/**
 * What the browser needs to open Razorpay. A checkout that reconciled to a
 * capture carries status 'SETTLED' and no keyId: show the receipt, never reopen pay.
 */
export type CheckoutLaunch = {
  checkoutId: string;
  keyId?: string;
  orderId: string;
  amount: number;
  currency: string;
  name?: string;
  description?: string;
  receipt?: string;
  copy: string;
  status?: string | undefined;
  retryAllowed?: boolean | undefined;
  reconciliationOutcome?: string | undefined;
};

export type OrchestratorHooks = {
  persistCart?: ((cartId: string) => Promise<void>) | undefined;
  persistQuote?: ((quoteId: string) => Promise<void>) | undefined;
  persistCheckout?: ((checkoutId: string) => Promise<void>) | undefined;
  persistApproval?: ((approvalId: string) => Promise<void>) | undefined;
  startCheckout?: ((quoteId: string) => Promise<CheckoutLaunch>) | undefined;
  recordCatalogSearch?:
    ((input: { query: string; items: Array<{ sku: string }> }) => Promise<void>) | undefined;
};
