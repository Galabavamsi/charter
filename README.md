# Charter

**Conversation in. Razorpay payment out. Every amount is bounded, explained, and recoverable.**

Live evaluator (Razorpay **test** mode): [https://core-api-production-087b.up.railway.app](https://core-api-production-087b.up.railway.app)

Charter is a merchant-owned trust layer for agentic commerce. A buyer talks to one Concierge — chat, voice, or an external agent over MCP — and pays a **frozen** INR total through hosted Razorpay Checkout. The model may rank and explain. Only versioned shop policy and catalog facts may change money.

**Track:** Razorpay AI Buildathon — [Track 01: AI Growth & Agentic Commerce](https://razorpay.com)  
**Mode:** Razorpay Test APIs only. This repository never ships live keys. Not live settlement. Not a UCP / ACP / AP2 / Gemini / Alexa certification.

---

## Track 01 — what we submitted

The track asks for an agent that grows merchant revenue **or** makes a merchant **transactable by an AI buyer**, on Razorpay test-mode APIs. The bar is: every money action explainable, bounded, and gated; show the audit trail; handle one failure gracefully.

Charter does both sides of that sentence with **one commerce core** and **three doors**:

| Door | What it is | Track 01 mapping |
| --- | --- | --- |
| **Chat Concierge** | In-app conversation → freeze quote → Razorpay Checkout | Conversational in-app checkout |
| **Voice (Talk)** | Same Concierge, spoken. Vapi Talk hits `/api/v1/voice/:id/chat/completions`, which runs the **same** `runConversationTurn` tools as text. Transcripts land in the thread. Pay stays on hosted Razorpay (we never take PAN/UPI). | Conversational checkout for a voice buyer |
| **MCP / HTTP agent** | Agent-readable catalog + checkout. Discovery at `/.well-known/charter-commerce.json`. Tools at `GET /mcp/tools`, `POST /mcp/call`. | Makes the merchant sellable to an AI buyer end to end |

MCP is not a second store. `POST /mcp/call` forwards the buyer JWT and only invokes first-party `/api` paths (`catalog.search`, `cart.update`, `quote.create`, `checkout.complete`, `order.status`, …). Caller-supplied `path` is ignored. The adapter holds **no** database or Razorpay credentials. HTTP, Concierge, and MCP return the same SKU, amount, and currency on the same quote.

Voice is not Alexa/Gemini listing and not a separate product. Talk is idle → connecting → listening → speaking → Stop. If Vapi is down, typed chat still works.

**The bar, in this build:**

- **Bounded / gated / explainable** — policy is code; frozen quote is the only payable amount; Pay hidden when settled; synthetic/test labeled.
- **Audit trail** — paper bill + order timeline (quote frozen → Razorpay Order → not confirmed → captured). Live: `order_TY19JdjkpJNdEB` / `pay_TY1HJcPJYeADhV`.
- **One failure handled** — test-mode Failure → reconcile → **Retry same order** (same Razorpay Order). Dismiss with no Payment stays fail-closed.

We publish `notCertified: [UCP, ACP, AP2, Gemini, Alexa]` on purpose. The protocol race is real; this evaluator is an honest HTTP + MCP contract, not a fake certification.

---

## Project objectives — what does it solve?

AI shopping is easy to demo and hard to trust. A model can invent a price, add a SKU that is not in stock, or say “nothing was charged” after a checkout modal closes. Payment truth is asynchronous. Merchants cannot see why money moved. External agents want the same catalog and checkout as the human UI, but they must not get a side door around policy.

Charter solves that loop:

> discover → bind a shop → add grounded lines → freeze a quote → pay through Razorpay → reconcile failure → capture once → issue an inspectable receipt

- **Buyers** stay in one Concierge. They describe a gift or a SKU, pick a shop, lock a total, and pay. Voice (Talk) uses the same tools. Failed pays stay “Payment not confirmed” until the server reads the Razorpay Order.
- **Merchants** get a desk with catalog, orders, recovery, hard caps, and truthful quote→capture metrics. Synthetic seed shops stay labeled synthetic.
- **Agents** call the same first-party `/api` through a thin MCP adapter. Discovery is honest: `protocolStatus` is an evaluator HTTP contract, `liveSettlement` is false, and UCP / ACP / AP2 / Gemini / Alexa are listed as **not certified**.

The proof is a public Razorpay **test-mode** evaluator on Railway, not a claim that each shop has a live Razorpay account.

---

## Features

### 1. One conversation to pay

Signed-out home states the contract: tell Concierge what you want, pay a frozen amount. Fulfillment waits for captured money.

![Charter landing](docs/readme/00-home.png)

Sign-in is Supabase email/password. The form never picks a role. Memberships come from the API after the JWT is verified.

![Sign in](docs/readme/00-sign-in.png)

### 2. Concierge — one chat, shop is a binding

After login, home is `/chats`. Starters (gift, coffee gear, notebook, tee) search the public directory, then stay in the same thread to add, quote, and pay. Sidebar is **Your chats** across shops.

![Unbound Concierge](docs/readme/01-concierge.png)

Onboarding is explicit about grounded facts: prices, stock, materials, and policy come from shop tools. Concierge does **not** invent refund copy, reviews, scam scores, resale, or customization.

![How Charter works](docs/readme/07-how-it-works.png)

### 3. Public directory and storefront

`/shops` lists published catalogs with search, category, in-stock, INR range, and deterministic sort. Seed shops include Northstar Travel Coffee, Sable Atelier, Indigo Desk, Lotus Gifting, Marigold Home, and Harbor Spice.

![Shop directory](docs/readme/02-shops.png)

A storefront is optional browse. **Open Concierge** / **Buy** opens chat already in context (`intent=buy&product=` auto-starts that SKU). No required “Ask in shop” hop.

![Northstar storefront](docs/readme/03-storefront.png)

### 4. Frozen quote, Razorpay pay, same-Order retry

A bound thread shows catalog cards, a **Locked total**, and **Pay ₹…**. Talk sits next to Send — same brain, spoken.

Live evidence (2026-09-04 IST): quote frozen → Razorpay Order `order_TY19JdjkpJNdEB` → payment not confirmed → reconcile `same_order_retry_safe` → retry **the same Order** → capture `pay_TY1HJcPJYeADhV` for ₹999.00 (Northstar `grinder.pocket-lite`).

![Bound Concierge with locked total](docs/readme/04-bound-chat.png)

Dismissing Checkout with **no** Payment stays `unknown_attempts` (fail-closed). A Razorpay test-mode **Failure** is what makes retry safe. Authorized never fulfills. Only verified **capture** is eligible to fulfill.

### 5. Paper bills and a buyer order list

`/orders` is every checkout this account owns. Each card is a paper bill: shop (with synthetic label), bill no., Razorpay Order, capture/reconcile state, Charter tracking (`CHR-TRK-…`), and a PAID stamp only after capture.

![Buyer orders](docs/readme/05-orders.png)

The receipt page adds the audit timeline: quote frozen, Order created, payment not confirmed, captured, fulfillment confirmed (sandbox address + tracking — not a carrier ship event).

![Buyer receipt](docs/readme/06-receipt.png)

### 6. One account, many desks

The account menu is Concierge, Shops, Buyer orders, My shops, Profile, Sign out. A buyer-only account can open **My shops** and create a durable shop. It cannot open seeded Northstar memberships (those owners are `*.owner@example.invalid`).

![Account menu](docs/readme/08-account-menu.png)

![Create first shop](docs/readme/09-merchant.png)

### 7. Merchant desk

When the account is a shop member: Overview, Catalog, Orders, Recovery, Rules, Settings. Metrics name the cohort (quotes created in the window). Synthetic / test stays visible. Dates, signed cursors, and INR grouping are one contract.

The following Northstar desk shots are the merchant UI with an injected local session (the live evaluator login is buyer-only). Live merchant onboarding is the create-shop screen above.

![Merchant overview](docs/readme/10-merchant-overview.png)

![Merchant catalog](docs/readme/11-merchant-catalog.png)

![Merchant orders](docs/readme/12-merchant-orders.png)

![Merchant recovery](docs/readme/13-merchant-recovery.png)

Rules hold hard cap, autonomous cap, and forbidden materials (Northstar: no glass). Settings keep test-mode disclosure.

![Merchant rules](docs/readme/14-merchant-rules.png)

![Merchant settings](docs/readme/15-merchant-settings.png)

### 8. Voice and the agent door (MCP)

**Voice** is not a second product. Talk uses Vapi; the custom LLM URL is this app (`/api/v1/voice/...`). Utterances become the same cart/quote/pay tools as chat. Transcripts are tagged `source: voice` in the thread.

**MCP** is the AI-buyer door for Track 01 — agent-readable catalog + gated checkout, same amounts as Concierge. Live (no login for discovery/tools):

| Surface | URL |
| --- | --- |
| Discovery | `GET https://core-api-production-087b.up.railway.app/.well-known/charter-commerce.json` |
| Alias | `GET https://core-api-production-087b.up.railway.app/api/.well-known/agent-commerce` |
| MCP tools | `GET https://core-api-production-087b.up.railway.app/mcp/tools` |
| MCP call | `POST https://core-api-production-087b.up.railway.app/mcp/call` (buyer JWT; first-party `/api` only) |

Tools: `agent.capabilities`, `catalog.search`, `catalog.detail`, `cart.create`, `cart.get`, `cart.update`, `quote.create`, `checkout.complete`, `checkout.resume`, `order.status`. Optional out-of-process proxy: `apps/mcp-gateway`. This is an evaluator HTTP/MCP adapter, not a protocol certification.

### 9. Control (platform)

`/control` is platform-role only: webhook inbox, flags, kill switches. Ordinary buyer/merchant accounts do not see it.

---

## Build challenges — what we faced, and how we solved them

**1. The model must not be the cashier.**  
Early chat could sound helpful and still be wrong on price, stock, or policy. Fix: tools own catalog facts; a material change creates a new disclosed quote; payment amount must equal the pinned minor-unit total. UI copy states what Concierge does *not* know.

**2. Razorpay is asynchronous, browsers lie.**  
Closing Checkout is not proof of “nothing charged.” Fix: browser callbacks are advisory. Server fetches the Order and every Payment before retry copy. `unknown_attempts` (dismiss, no Payment) stays fail-closed. `same_order_retry_safe` only when every attempt is terminal `failed`. Unchanged quote reuses the **same** Razorpay Order.

**3. One shared test account, many shops.**  
We do not pretend each merchant has Route / linked accounts. Fix: every quote, Order, and capture is `tenant_id` scoped. RLS plus a restricted `charter_app` runtime role. Unknown webhooks quarantine; they never default to Northstar.

**4. Checkout hangs, stale facts, extra SKUs.**  
Live gift chat hit `FACTS_STALE`, Pay timeouts, and catalog holes. Fix: Razorpay HTTP abort, one Order create per frozen quote, Buy now no longer treated as Pay intent, catalog expand for the seed shops, thinking orbs and real step copy so the buyer sees reconcile vs pay.

**5. Same-origin public evaluator without a git remote.**  
Render needed a Git deploy we were not allowed to push. Fix: one Railway web service — Fastify binds `0.0.0.0:$PORT`, serves `/api`, webhooks, discovery/MCP, and the built SPA. `render.yaml` exists and is **not** applied. After SPA deploys, hard-refresh (Ctrl+Shift+R).

**6. Truthful merchant metrics and INR.**  
A second capture must not double GMV. Fix: unique capture key, cohort copy that names the denominator, bigint-safe Indian grouping (`₹1,00,000.00`), signed-cursor pagination that rejects tamper and cross-scope reuse.

**7. Identity vs seed merchants.**  
The live evaluator account can buy and open “My shops,” but Northstar owner emails are non-deliverable seed addresses. Fix: do not invent passwords. Buyer receipt + merchant UI are proven separately; merchant timeline for `order_TY19JdjkpJNdEB` still needs a Northstar owner login.

---

## Honest limits

- Razorpay **test** only. Health reports `razorpayMode: test`. Discovery `liveSettlement: false`.
- Inventory is **not** decremented on capture. `fulfillmentReady` means captured and eligible, not shipped. Sandbox tracking is not a courier.
- No UCP / ACP / AP2 / Gemini / Alexa listing or certification.
- Tavus video is later. Voice is Vapi Talk inside Concierge.
- Playwright coverage is focused (skip-link, heading contrast ≥ 4.5, reduced-motion) — not a WCAG audit.
- Full production Product Spec is larger than this evaluator.

Details: [`docs/evaluator/UNSUPPORTED.md`](docs/evaluator/UNSUPPORTED.md). Live retry steps: [`docs/evaluator/README.md`](docs/evaluator/README.md).

---

## Stack and local setup

TypeScript, pnpm, Fastify, Postgres, Vite + React. Visual design is intentionally unset.

Requires Node 20+, pnpm 9, Docker.

```bash
cp .env.example .env
# put Razorpay Test keys in .env — never commit it
pnpm install
pnpm db:up
pnpm migrate
pnpm seed
pnpm db:provision-role
pnpm test
```

`supabase/migrations` is the canonical SQL history. Production connections use `charter_app`, not the migration owner. After migrations:

```bash
pnpm migrate
pnpm db:provision-role
```

Run the API and SPA:

```bash
pnpm --filter @charter/core-api dev
pnpm --filter @charter/concierge-web dev
```

Health: `http://127.0.0.1:3000/health`  
Discovery: `http://127.0.0.1:3000/.well-known/charter-commerce.json`  
Webhook: `POST /webhooks/razorpay` on core-api. Live target: `https://core-api-production-087b.up.railway.app/webhooks/razorpay`.

Root gates: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm smoke:built`.

---

## Money rules

- Amounts are integer minor units (paise) + INR
- Policy is code, not a prompt
- Fulfillment waits for `payment.captured`
- `payment.failed` is provisional — never “nothing was charged”
- Same unchanged quote retries the same Razorpay Order

Northstar Travel Coffee and the other directory shops are **synthetic seed data**, not live merchants.
