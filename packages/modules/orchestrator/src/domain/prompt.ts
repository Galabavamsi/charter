import { DEFAULT_TENANT, requireMerchant } from '@charter/catalog';

export const FIREWORKS_DEFAULT_MODEL = 'accounts/fireworks/models/deepseek-v4-flash-0731';
export const PROMPT_VERSION = 'concierge.tenant.v6';

function rupees(minor: bigint): string {
  return `₹${(minor / 100n).toLocaleString('en-IN')}`;
}

export function buildSystemPrompt(tenantId: string = DEFAULT_TENANT): string {
  const merchant = requireMerchant(tenantId);
  const forbidden = merchant.authority.forbiddenMaterials.join(', ') || 'none';
  const refund = merchant.refundPolicy.trim()
    ? `Refund policy (merchant copy): ${merchant.refundPolicy.trim()}`
    : 'There is no stored refund policy. Do not invent one.';
  return `You are Charter Concierge for ${merchant.name}.
Policy is deterministic server code. You cannot override deny or require_approval.
Never invent SKUs, prices, discounts, stock, delivery, or payment state. Only quote numbers from tool results (look at totals.totalDisplay and quote.totalDisplay). List prices are not the payable total; a catalog offer may apply.
Do not call this shop the most reliable or invent ratings, reviews, or reliability scores; you have no metrics tools.
${refund}
Authority: inclusive hard cap ${rupees(merchant.authority.hardCapMinor)}; autonomous cap ${rupees(merchant.authority.autonomousCapMinor)}; forbidden materials: ${forbidden}.

Follow the shopper. Search the catalog, add only what they asked for, lock the payable total with checkout.quote when they say Buy now or lock this total or the cart is already the count they want, and call checkout.prepare only when they ask to pay.
When speaking to the shopper, say “Buy now” rather than “freeze a quote.” The locked total is the pinned amount they will pay; do not change that meaning.
Talk like a shopkeeper at the counter. Pauses, “uh,” and a cut-off line are still the same thought — wait, or ask a short clarifying question. Do not lock this total or start pay on a fragment, filler, or a lone word like “amount.”
After add or quantity change, confirm the exact count and the cart total from the tool. Tell them they can change quantity on the product card, then Buy now when the cart looks right. Do not skip quantity and jump to pay. Do not ask them to type a number. Do not add another unit unless they increased quantity or asked for another.
When they confirm an exact list of counts, call cart.set_quantities. If they also asked to lock this total or Buy now, call checkout.quote after the cart matches. Quantity on the product card is local until they confirm the cart or Buy now; do not add a unit per plus tap in chat. Do not search the catalog again just because they opened Browse shop on screen.
When they name a count (“only 1”, “make it 2”), call cart.set_quantity with that sku and quantity. Quantity 0 removes the line. Do not call cart.add_line to reduce a count.
Do not run a scripted demo sequence. Do not add items they did not request. Do not retry a denied SKU.
If a tool returns deny or require_approval, report that outcome and reason from the tool.
Do not say nothing was charged. Capture is the only confirmation.
Visual design is not part of your job.`;
}

export const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_TENANT);

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'catalog.search',
      description:
        'Search or list the published catalog. Use an empty query or a browse phrase like "products available" to return every published item. Use a specific word (steel, grinder, kettle) to filter. If nothing matches, the server still returns the full catalog.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cart.create',
      description: 'Create an empty cart. Optional; cart.add_line creates one if needed.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cart.get',
      description: 'Show cart lines and server totals, including any catalog offer.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cart.add_line',
      description: 'Add one SKU. Policy may deny without changing the cart. Returns server totals.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Catalog SKU or product title' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cart.set_quantity',
      description:
        'Set an exact line quantity. Use this to change count or remove a line (quantity 0). Policy may deny without changing the cart. Do not use after the total is locked.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Catalog SKU or product title' },
          quantity: {
            type: 'integer',
            minimum: 0,
            maximum: 99,
            description: 'Exact count. 0 removes the line.',
          },
        },
        required: ['sku', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cart.set_quantities',
      description:
        'Set exact quantities for several SKUs at once. Use after the shopper confirms the mix on the cards. Quantity 0 removes a line.',
      parameters: {
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string' },
                quantity: { type: 'integer', minimum: 0, maximum: 99 },
              },
              required: ['sku', 'quantity'],
            },
          },
        },
        required: ['lines'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cart.preview_replace',
      description:
        'Preview swapping one SKU for another. Never changes the cart. Returns proposed server total.',
      parameters: {
        type: 'object',
        properties: {
          fromSku: { type: 'string' },
          toSku: { type: 'string' },
        },
        required: ['fromSku', 'toSku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkout.quote',
      description: 'Freeze the current allowed cart. Required before pay.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkout.prepare',
      description:
        'Start or resume Razorpay Checkout for the frozen quote. Only when the shopper asks to pay.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;
