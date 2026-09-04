export type RecoveryMailCopy = {
  subject: string;
  text: string;
};

const FORBIDDEN = ['rzp_test_', 'rzp_live_', 'key_secret', 'webhook_secret', 'card'];

export function buildFailedPayRecoveryCopy(input: {
  merchant: string;
  totalDisplay: string;
  quoteId: string;
  orderId: string;
}): RecoveryMailCopy {
  const subject = `${input.merchant} quote ${input.totalDisplay} — payment not confirmed`;
  const text = [
    `Payment is not confirmed for ${input.merchant}.`,
    'Do not assume nothing was charged.',
    `Frozen quote ${input.totalDisplay} is unchanged.`,
    'Charter checked this Razorpay Order and found no authorized or captured payment.',
    'Open Concierge to retry payment on the same Razorpay Order.',
    `Quote: ${input.quoteId}`,
    `Order: ${input.orderId}`,
  ].join('\n');
  const haystack = `${subject}\n${text}`.toLowerCase();
  for (const token of FORBIDDEN) {
    if (haystack.includes(token)) {
      throw new Error('RECOVERY_COPY_LEAK');
    }
  }
  return { subject, text };
}
