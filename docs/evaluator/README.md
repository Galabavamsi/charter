# Charter evaluator — live origin, M7 retry, M8, M9 gates

This is the evaluator-facing map for what is live, what still needs a human login, and what Milestone 9 still does not claim.

**Live origin:** `https://core-api-production-087b.up.railway.app`  
**Mode:** Razorpay **test** only. Not live settlement. Not a certification.

Honest unsupported-feature review (public smoke facts + handover limits): [UNSUPPORTED.md](./UNSUPPORTED.md).

After any SPA deploy, hard-refresh with **Ctrl+Shift+R**.

## Milestone 8 — discovery and MCP (no login)

These are public. They must stay honest (`evaluator-http-contract` / `evaluator-http-adapter`) and must not claim UCP, ACP, AP2, Gemini, or Alexa certification.

| Check      | URL                                                                                     |
| ---------- | --------------------------------------------------------------------------------------- |
| Discovery  | `GET https://core-api-production-087b.up.railway.app/.well-known/charter-commerce.json` |
| Alias      | `GET https://core-api-production-087b.up.railway.app/api/.well-known/agent-commerce`    |
| MCP tools  | `GET https://core-api-production-087b.up.railway.app/mcp/tools`                         |
| MCP call   | `POST https://core-api-production-087b.up.railway.app/mcp/call`                         |
| Health     | `GET https://core-api-production-087b.up.railway.app/health`                            |
| Robots     | `GET https://core-api-production-087b.up.railway.app/robots.txt`                        |
| Sitemap    | `GET https://core-api-production-087b.up.railway.app/sitemap.xml`                       |
| Directory  | `GET https://core-api-production-087b.up.railway.app/shops` (HTML)                      |
| Northstar  | `GET https://core-api-production-087b.up.railway.app/shops/northstar` (HTML)            |

Live public GETs on 2026-09-04 returned **200** on every row above. Health `razorpayMode` was `test`. Discovery `protocolStatus` was `evaluator-http-contract`, `liveSettlement` was `false`, and `notCertified` included UCP, ACP, AP2, Gemini, and Alexa.

Local equivalents: `http://127.0.0.1:3000` (core-api). Vite (`http://127.0.0.1:5173`) proxies `/.well-known`, `/health`, `/api`, `/mcp`, `/robots.txt`, and `/sitemap.xml` to core-api.

`POST /mcp/call` forwards the caller JWT and only invokes first-party `/api` paths. Caller-supplied `path` is ignored. The adapter holds no database or Razorpay credentials. Optional out-of-process proxy: `apps/mcp-gateway`.

Expected MCP tool names: `agent.capabilities`, `catalog.search`, `catalog.detail`, `cart.create`, `cart.get`, `cart.update`, `quote.create`, `checkout.complete`, `checkout.resume`, `order.status`.

## Milestone 7 — live fail→same-Order retry (evaluator login)

**Recorded 2026-09-04 IST.** `order_TY19JdjkpJNdEB` reused after a test-mode Failure; `pay_TY1HJcPJYeADhV` captured; buyer receipt `/orders/fdb11812-9f9b-46d8-b603-fadf6ac75a3e`. Dismissing Checkout with no Payment stays `unknown_attempts`. Use Razorpay test-mode **Failure**, then Check payment status. Local Playwright money harness (`apps/concierge-web/e2e/buyer-pay.spec.ts`) is **not** this gate.

1. Open `https://core-api-production-087b.up.railway.app` and hard-refresh (Ctrl+Shift+R).
2. Sign in with the evaluator account.
3. Land on Concierge (`/chats`). Bind Northstar, or open `/buyer/northstar?intent=buy&product=grinder.pocket-lite` (auto-starts; no extra Send).
4. Freeze a quote so **Locked total** and **Pay ₹…** are visible. Note the amount.
5. Click **Pay ₹…**. Razorpay Checkout opens. **Fail** the attempt: close/dismiss the modal, or use Razorpay test-mode failure. Do not complete capture yet.
6. Confirm copy is **Payment not confirmed** (never “nothing was charged”). **Pay** stays hidden. Do **not** expect a direct retry yet.
7. Click **Check payment status**. Server reconciles the Razorpay Order and all Payment attempts.
8. When outcome is `same_order_retry_safe`, **Retry same order** appears. Note the Razorpay Order id (`order_…`).
9. Click **Retry same order**. The new checkout must reuse **that same Order id**. Then complete with a Razorpay **test** success method.
10. Confirm buyer receipt (`/orders/:id`) and merchant order timeline agree: one captured amount, one Order, authorized never fulfilled. Record the Order id and timestamp. Only then tick the live-retry checkbox in the handover.

## Deployment notes (Railway, not Render)

The public evaluator is **one** same-origin Railway web service: Fastify `core-api` serves `/api`, webhooks, discovery/MCP, and the built SPA.

- Bind: `0.0.0.0:$PORT` (Railway injects `PORT`).
- Start: `pnpm start` after `pnpm build`.
- Filesystem is ephemeral; durable state is Postgres/Supabase, not local disk.
- Canonical public origin: `CHARTER_PUBLIC_URL=https://core-api-production-087b.up.railway.app`.
- Razorpay Test webhook target: `https://core-api-production-087b.up.railway.app/webhooks/razorpay`.
- Runtime DB role is `charter_app` (no DDL). Owner/migration credentials stay off the app connection.
- Local Render-shaped config remains in `render.yaml` and is **not** the live origin. Do not apply it without a separate explicit approval.

User-visible/API deploys (when authorized):

```powershell
railway up --detach -y --service core-api --environment production --message "continue evaluator: M9 docs/gates"
```

## Playwright (focused, not a full a11y program)

Existing infra: `apps/concierge-web/e2e/`. Checks use Playwright primitives only (no axe). They cover skip-link activation, heading-vs-background contrast ≥ 4.5, and reduced-motion animation-duration short-circuit on named surfaces — not a WCAG audit.

| Command                                              | What it covers                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @charter/concierge-web test:e2e`      | Local Vite: public/auth labels; skip-link + reduced-motion + heading contrast on `/`, `/shops`, `/shops/northstar` (if storefront API is up), `/auth/sign-in`; public directory → Northstar storefront → Open Concierge → auth return (no login); injected buyer Concierge/receipts + those a11y checks; merchant leaf keyboard/focus + overview a11y; HTTP/MCP if core-api is up |
| `pnpm --filter @charter/concierge-web test:e2e:live` | Live Railway origin only (`evaluator.spec.ts`): health, discovery + agent-commerce alias, MCP, robots/sitemap, `/shops` + `/shops/northstar` HTML, auth return, public skip-link/contrast/reduced-motion, directory→storefront→auth return. **No login and no invented credentials.**                                                                              |
| `buyer-pay.spec.ts`                                  | Local money harness fail→reconcile→same-Order retry (not live M7). Money classification unchanged.                                                                                                                                                                                                                                                                  |
| `merchant-keyboard.spec.ts`                          | Injected merchant session: skip-to-records, Overview→catalog/orders/recovery/rules/settings heading focus, shop switch, loading/error/denial, plus overview skip-to-main / contrast / reduced-motion. Not live Auth.                                                                                                                                               |
| `evaluator-buyer.spec.ts`                            | Injected-session Concierge, account menu, buyer receipts, plus Concierge/receipts skip-link / contrast / reduced-motion (not live Auth).                                                                                                                                                                                                                            |

M9 is evaluator-complete on Railway as of 2026-09-05: Milestone 6 completion ticked, focused Playwright accepted as the critical-journeys gate, live Auth shop-switch recorded (buyer → `/merchant` create-first-shop), dedicated Supabase already in use, Railway accepted as the same-origin origin (`render.yaml` not applied), webhook target authorized. This is **not** a WCAG audit, live settlement, or protocol certification. Product README with screenshots: root `README.md`.

## Honest status

| Gate                          | Status                                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M6 completion                 | Ticked 2026-09-05 by evaluator instruction (Slices A–D already ticked).                                                                                                                                                            |
| M7 live fail→same-Order retry | Recorded 2026-09-04 IST: `order_TY19JdjkpJNdEB` / `pay_TY1HJcPJYeADhV` / checkout `fdb11812-9f9b-46d8-b603-fadf6ac75a3e`. Buyer receipt `/orders/fdb11812-9f9b-46d8-b603-fadf6ac75a3e`. Merchant UI 403 on this buyer-only account. |
| M8 discovery + MCP on Railway | Implemented, live, and evaluator-signed. Not a certification.                                                                                                                                                                      |
| M9 release                    | Evaluator-complete on Railway: root + Postgres 2026-09-04; live public smoke + [UNSUPPORTED.md](./UNSUPPORTED.md); focused Playwright; Supabase/Railway/webhook authorized 2026-09-05. Not WCAG, not live settlement.             |
