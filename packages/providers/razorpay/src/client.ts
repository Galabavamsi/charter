export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
};

export type RazorpayPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'failed' | string;
  method?: string;
};

export type RazorpayCredentials = {
  keyId: string;
  keySecret: string;
};

export type HttpFetch = typeof fetch;

function basicAuth(credentials: RazorpayCredentials): string {
  return Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64');
}

const RAZORPAY_HTTP_TIMEOUT_MS = 10_000;

export class RazorpayClient {
  constructor(
    private readonly credentials: RazorpayCredentials,
    private readonly httpFetch: HttpFetch = fetch,
    private readonly baseUrl = 'https://api.razorpay.com/v1',
  ) {}

  private request(input: string | URL, init: RequestInit = {}): Promise<Response> {
    return this.httpFetch(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(RAZORPAY_HTTP_TIMEOUT_MS),
    });
  }

  async createOrder(input: {
    amountMinor: number;
    currency: 'INR';
    receipt: string;
  }): Promise<RazorpayOrder> {
    if (input.receipt.length > 40) {
      throw new Error('RAZORPAY_RECEIPT_TOO_LONG');
    }
    const response = await this.request(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicAuth(this.credentials)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt,
        payment_capture: 1,
      }),
    });
    if (!response.ok) {
      throw new Error(`RAZORPAY_ORDER_CREATE_FAILED:${response.status}`);
    }
    return (await response.json()) as RazorpayOrder;
  }

  async findOrdersByReceipt(receipt: string): Promise<RazorpayOrder[]> {
    const url = new URL(`${this.baseUrl}/orders`);
    url.searchParams.set('receipt', receipt);
    const response = await this.request(url, {
      headers: { authorization: `Basic ${basicAuth(this.credentials)}` },
    });
    if (!response.ok) {
      throw new Error(`RAZORPAY_ORDER_LOOKUP_FAILED:${response.status}`);
    }
    const body = (await response.json()) as { items?: RazorpayOrder[] };
    return body.items ?? [];
  }

  async getOrder(orderId: string): Promise<RazorpayOrder> {
    const response = await this.request(`${this.baseUrl}/orders/${encodeURIComponent(orderId)}`, {
      headers: { authorization: `Basic ${basicAuth(this.credentials)}` },
    });
    if (!response.ok) {
      throw new Error(`RAZORPAY_ORDER_LOOKUP_FAILED:${response.status}`);
    }
    return (await response.json()) as RazorpayOrder;
  }

  async listOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    const response = await this.request(
      `${this.baseUrl}/orders/${encodeURIComponent(orderId)}/payments`,
      {
        headers: { authorization: `Basic ${basicAuth(this.credentials)}` },
      },
    );
    if (!response.ok) {
      throw new Error(`RAZORPAY_ORDER_PAYMENTS_LOOKUP_FAILED:${response.status}`);
    }
    const body = (await response.json()) as { items?: RazorpayPayment[] };
    return body.items ?? [];
  }

  async getPayment(paymentId: string): Promise<RazorpayPayment> {
    const response = await this.request(`${this.baseUrl}/payments/${paymentId}`, {
      headers: { authorization: `Basic ${basicAuth(this.credentials)}` },
    });
    if (!response.ok) {
      throw new Error(`RAZORPAY_PAYMENT_LOOKUP_FAILED:${response.status}`);
    }
    return (await response.json()) as RazorpayPayment;
  }
}
