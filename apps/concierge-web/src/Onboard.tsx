import { useState } from 'react';

export type OnboardRole = 'buyer' | 'merchant' | 'operator';

const beats: Record<OnboardRole, Array<{ title: string; body: string }>> = {
  buyer: [
    {
      title: 'Say what you want.',
      body: 'Stay in Concierge. Ask for the cheapest option, a gift, or a swap. Catalog facts come from shop tools — prices, stock, materials, and policy. Concierge does not have refund-policy text, reviews, scam scores, resale, or customization data, and will not invent them.',
    },
    {
      title: 'You only pay the locked amount.',
      body: 'The assistant can talk. It cannot raise the price or sell a forbidden item. Pay opens when the total is locked.',
    },
    {
      title: 'If a pay fails, retry the same quote.',
      body: 'Nothing is confirmed until capture. Email after a failed pay is optional — only if you ask for it.',
    },
  ],
  merchant: [
    {
      title: 'Create the shop. Share the link.',
      body: 'Add items and stock here. Copy the public shop link or send it on WhatsApp when the catalog is ready.',
    },
    {
      title: 'Approvals land on this desk.',
      body: 'If a swap is over the autonomous cap, it waits. Approve or deny. The cart does not change until you do.',
    },
    {
      title: 'Captured money is the record.',
      body: 'Quotes, checkouts, and captures stay inspectable. Fulfill only after capture.',
    },
  ],
  operator: [
    {
      title: 'You keep the rails up.',
      body: 'Payments, webhooks, and voice are connections. This desk shows whether they are live.',
    },
    {
      title: 'Stop checkout if you must.',
      body: 'A kill switch holds new pays for this shop or everywhere. It does not invent a refund.',
    },
    {
      title: 'The inbox is the truth from Razorpay.',
      body: 'Signed webhook events land here. Use them to see what actually happened to a pay.',
    },
  ],
};

export function Onboard({
  role,
  userId,
  shopId,
  onClose,
}: {
  role: OnboardRole;
  userId: string;
  shopId?: string;
  onClose: () => void;
}) {
  const key = `charter.onboard.v2.${encodeURIComponent(userId)}.${encodeURIComponent(shopId ?? 'account')}.${role}`;
  const [step, setStep] = useState(0);
  const slides = beats[role];

  function finish() {
    localStorage.setItem(key, '1');
    onClose();
  }

  return (
    <div className="onboard" role="dialog" aria-modal="true" aria-labelledby="onboard-title">
      <div className="onboard-card" key={step}>
        <p className="eyebrow">Charter</p>
        <h2 id="onboard-title">{slides[step].title}</h2>
        <p>{slides[step].body}</p>
        <div className="onboard-dots">
          {slides.map((_, index) => (
            <span key={index} data-on={index === step} />
          ))}
        </div>
        <div className="row-actions">
          {step < slides.length - 1 ? (
            <button type="button" onClick={() => setStep((value) => value + 1)}>
              Next
            </button>
          ) : (
            <button type="button" onClick={finish}>
              Enter
            </button>
          )}
          <button type="button" className="ghost" onClick={finish}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
