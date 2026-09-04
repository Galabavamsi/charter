import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
  secret: string;
}): boolean {
  const expected = createHmac('sha256', input.secret)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest('hex');
  const actual = input.signature.trim();
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
