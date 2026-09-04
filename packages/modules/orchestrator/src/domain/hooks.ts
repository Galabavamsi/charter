export type CheckoutLaunch = {
  checkoutId: string;
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  receipt: string;
  copy: string;
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
