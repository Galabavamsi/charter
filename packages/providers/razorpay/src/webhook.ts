import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyRazorpayWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  if (!input.signatureHeader || !input.secret) {
    return false;
  }
  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest('hex');
  const actual = input.signatureHeader.trim();
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function buildRazorpayReceipt(ulid: string): string {
  const receipt = `cht_${ulid}`;
  if (receipt.length > 40) {
    throw new Error('RAZORPAY_RECEIPT_TOO_LONG');
  }
  return receipt;
}
