# Honest unsupported-feature review

**Recorded:** 2026-09-04 (live public GETs against Railway).  
**Live origin:** `https://core-api-production-087b.up.railway.app`  
**Mode:** Razorpay **test** only.

This is not a certification and not live settlement. Milestone 9 is evaluator-complete on Railway as of 2026-09-05. Source list: handover [Explicitly unsupported](../handover/CHARTER_SECURE_EVALUATOR_EXECUTION_HANDOVER.md#explicitly-unsupported). Evaluator map: [README.md](./README.md). Product README: [../../README.md](../../README.md).

## Public smoke (no credentials)

Fetched 2026-09-04 ~18:08 UTC. Bodies contained no secrets. `Server: railway-hikari`.

| URL | Status | Facts |
| --- | --- | --- |
| `GET /health` | 200 | `ok: true`, `service: core-api`, `env: production`, **`razorpayMode: test`**, `paymentsConfigured: true`, `db: true` |
| `GET /.well-known/charter-commerce.json` | 200 | **`protocolStatus: evaluator-http-contract`**, `environment.mode: test`, **`liveSettlement: false`**, **`notCertified: [UCP, ACP, AP2, Gemini, Alexa]`**, `mcp.protocolStatus: evaluator-http-adapter` |
| `GET /api/.well-known/agent-commerce` | 200 | Alias: **`protocolStatus: evaluator-http-contract`**, same **`notCertified`**, points at canonical discovery |
| `GET /mcp/tools` | 200 | **`protocolStatus: evaluator-http-adapter`**, `certified: false`, ten first-party tools |
| `GET /robots.txt` | 200 | `User-agent: *`, `Allow: /`, sitemap URL on this origin |
| `GET /sitemap.xml` | 200 | Includes `/shops/northstar` and the other published shop locs |
| `GET /shops` | 200 | `text/html` SPA shell; title/canonical “Shop directory” |
| `GET /shops/northstar` | 200 | `text/html` SPA shell; title “Northstar Travel Coffee”; JSON-LD Store |

Automated repeat: `pnpm --filter @charter/concierge-web test:e2e:live` (`apps/concierge-web/e2e/evaluator.spec.ts`).

## Explicitly unsupported (handover)

From the handover list (~line 829):

- Live merchant settlement, Razorpay Route, linked/connected merchant accounts, live keys, or production payment topology.
- Real customer, merchant, payment, or contact data.
- Manual capture.
- Official Gemini or Alexa listing/marketplace registration.
- UCP or ACP certification/conformance/enrollment, AP2 certification/compliance, or official protocol endorsement.
- Completion of the entire 896-line production Product Spec.
- Any provider, protocol, worker, queue, storage, or deployment capability not implemented and verified by the evaluator gates.
- Final approved visual direction; `.planning/DESIGN_LOCK.md` remains proposed.

## Must-state limits (this evaluator)

- **No live settlement.** Health reports `razorpayMode: test`. Discovery reports `environment.liveSettlement: false`. One shared Razorpay test account only.
- **No Route / connected accounts.** No linked merchant payout topology. Not production payment isolation.
- **No UCP / ACP / AP2 / Gemini / Alexa certification.** Discovery `notCertified` lists all five. MCP `certified` is false. Protocol status is `evaluator-http-contract` / `evaluator-http-adapter` only.
- **Product Spec is not fully implemented.** The 896-line `.planning/PRODUCT_SPEC.md` remains the production inventory. This tree implements the evaluator plan and preserves money invariants; it does not complete the full spec.
- **Inventory is not committed on capture.** Capture marks the checkout paid / `fulfillmentReady`. The evaluator does not commit `on_hand` / reservation into a production inventory ledger on that capture.
- **`fulfillmentReady` ≠ shipped.** Paid capture can set `fulfillmentReady: true` and write a sandbox shipment as `confirmed`. That is not a carrier ship event and must not be described as shipped.
- **Railway is the live origin, not Render.** Evaluator instruction 2026-09-05 accepted Railway as the same-origin origin. Do not apply `render.yaml`.
- **Tavus is later.** HLD lists Tavus as not a default runtime dependency. This evaluator does not ship Tavus video.
- **Voice is Vapi Talk inside Milestone 7.** Talk uses the same Concierge tools, spoken. It is not a separate voice product and not an Alexa/Gemini listing.

## What this review does not claim

- Live settlement or production payment topology
- WCAG / full accessibility audit (focused Playwright only)
- UCP / ACP / AP2 / Gemini / Alexa certification
- Inventory committed on capture
- Carrier shipping (sandbox tracking only)
- Applied Render deployment (`render.yaml` reserved)
- Production-ready beyond this Razorpay test-mode evaluator
