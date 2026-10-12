# Sprint — recover payments, CDEK booking and electronics tracking (12.10.2026)

Status: **implemented in source on main, not staging-certified.**
Without a clean DB migration, production provider sandbox and bank/KKT
journey verification this is **not a commercial GO**. No GitHub Actions.

## Incremental migrations

Run in this order on a disposable clone after a backup:

1. `234_payment_reconciliation_queue.sql` — durable leased payment/refund
   recovery tasks with tenant RLS, unique task per intent/refund and
   backfill of pending provider payments.
2. `235_provider_connections_quotes.sql` — encrypted seller/site
   credentials for CDEK and ATOL, provider verification state, timed
   and bounded CDEK quotes.
3. `236_serial_imei_marking_register.sql` — serials, Luhn-validated
   IMEI, SHA256 Data Matrix identity + encrypted original, tenant RLS.
   **VERIFIED for marking is prohibited** pending signed ГИС МТ API.
4. `237_cdek_shipment_lifecycle.sql` — one shipment per sales order,
   durable `UNKNOWN` for ambiguous provider POST and tenant RLS.
   Review FK grants and RLS for actual app DB role.

Do not turn on any new payment worker before applying migration 234.

### Runtime settings

```dotenv
# Explicitly opt-in after migrating, testing and monitoring
COREBIZ_PAYMENT_RECONCILE_ENABLED=false
COREBIZ_PAYMENT_RECONCILE_INTERVAL_MS=60000
# Already required to encrypt seller PSP/CDEK/ATOL secrets:
COREBIZ_PAYMENT_ENCRYPTION_KEY=<64 HEX CHARS, generated securely>
COREBIZ_SAAS_YOOKASSA_SHOP_ID=<YOUR PLATFORM SHOP>
COREBIZ_SAAS_YOOKASSA_SECRET=<YOUR PLATFORM SECRET>
COREBIZ_PAYMENT_RETURN_ORIGIN=https://<YOUR_PUBLIC_ORIGIN>
```

Do not commit credentials to GitHub, paste them into incidents, or store
them in user-visible logs. The shared encryption key must be backed up
securely; losing it makes configured seller provider connections unreadable.

## Payment recovery behavior

- `CommercePaymentsService` runs at app startup only with
  `COREBIZ_PAYMENT_RECONCILE_ENABLED=true`; timer interval 30–300 s.
- Cross-tenant claims use narrow `corebiz_claim_commerce_reconciliation(5)`
  with `FOR UPDATE SKIP LOCKED`, 90-second lease.
- The job re-fetches the exact PSP intent/refund through authenticated
  YooKassa GET, validates identity/currency/amount and keeps idempotent
  Finance ledger posting.
- Fiscal status may remain `PENDING`; that is NOT receipt proof.
- Errors are sanitized; bounded exponential retries stop after 60 tries
  as `EXHAUSTED`. This state **must** trigger an operator investigation.
- Tenant billing user can inspect
  `GET /api/v1/payments/reconciliation/status`.
- Read-only recovery audit:
  `scripts/commerce_provider_recovery_audit.sql`.

### Acceptance matrix (must actually execute, not just read source)

1. Crash immediately after creating provider payment and before webhook.
2. Webhook never delivered; worker GET confirms bank success and posts
   exactly one Finance transaction.
3. Two API replicas claim separate leases; retries do not double post.
4. Refund succeeds while callback is lost; refund ledger posted once.
5. Bank succeeds but receipt fails; preserve payment success and make
   fiscal issue visible rather than silently mark customer checkout GO.
6. Provider unavailable, invalid secret, connection rotated and tenant
   suspended; operator sees due/exhausted status.

## CDEK v2: what is working at source level

Screens: `/app/settings/integrations/connect`.

- Seller stores its own CDEK `clientId/clientSecret` encrypted, separately
  for each site; sandbox/prod environments are distinct.
- Explicit verification authenticates to CDEK OAuth endpoint; token
  never leaves backend.
- Owner provides origin/destination city, physical package dimensions and
  weight. Live tariff quote expires after 15 minutes and is scoped to
  seller connection. Quotes issued before merchant credential rotation
  cannot create new consignments.
- `POST /provider-connectors/sites/:siteId/cdek/shipments` creates a
  claim **before** a single `POST /v2/orders` provider call.
- Only a **real checkout** with original immutable courier address,
  confirmed YooKassa success + Finance ledger + fiscal receipt success,
  and `RESERVED/READY` stock can be sent to CDEK.
- Package `items` are derived from `sales_order_line` and carry
  prepaid `payment.value=0`; line SKU/quantity/prices are never
  provided by the booking caller. Refuse fractional quantities and
  non-exact per-unit price allocation instead of inventing values.
- External client `number` is the CoreBiz order UUID. Carrier UUID
  is verified with authenticated GET `/v2/orders/{uuid}`.
- User can list shipments per site and poll statuses. If initial POST
  timed out or returned ambiguous acceptance, state becomes `UNKNOWN`.
  **Never replay POST automatically**. Look up the corresponding order
  in the CDEK merchant cabinet, then use its UUID for an authenticated
  GET and compare its `entity.number` to the exact CoreBiz order ID.
- Carrier `DELIVERED` is not a bank capture or inventory shipment.
  Actual OMS fulfilment, stock moves, return logistics and marketplace
  transport labels need separate verification.

Endpoints under `/api/v1/provider-connectors`:

- `GET /sites/:siteId`
- `POST /sites/:siteId/configure`
- `POST /sites/:siteId/:provider/verify`
- `POST /sites/:siteId/cdek/quotes`
- `GET /sites/:siteId/shipments`
- `POST /sites/:siteId/cdek/shipments`
- `POST /sites/:siteId/cdek/shipments/:shipmentId/verify`

CDEK official specification: https://apidoc.cdek.ru/
and https://developer.cdek.ru/

### CDEK acceptance tests remaining

- Integration with test credentials: create a real sandbox waybill,
  confirm package `items` are valid for merchant contract and
  correct tariff/method, check GET status + related carrier number.
- Deliberately fail after carrier receives POST but before CoreBiz receives
  its response; ensure no second POST and operator can reconcile.
- Test pickup-point mode separately: no fake PВЗ/locker labels.
- Produce carrier labels, booking cancellations, return shipments,
  weight/volume re-rating and tracking callbacks.
- Public buyer checkout must choose and confirm a true CDEK tariff and
  PВЗ *before payment*. Current booking only uses an already paid order
  and is merchant-initiated, with the **merchant** paying the shipping fee.
  It does not charge the shopper the newly quoted fee.
- Real sandbox and production API have NOT been contacted here.

## ATOL, Evotor, Honest Sign and Russian Post

- **ATOL:** client credential verification via v5/FDF 1.2 exists.
  There is no submitted tax receipt or confirmed fiscal number
  from this adapter yet. See official v5 protocol
  https://atol.online/api_v5 — `sell/sell_refund`, callback and report
  are separate operations. Do not send a second receipt for a transaction
  already fiscalized by YooKassa.
- **Evotor:** app authorization, device registration, receipts/shifts and
  reconciliation still need vendor sandbox/dev agreement.
- **Honest Sign (Честный ЗНАК):** serial/IMEI and Data Matrix storage
  exist as an unverified register only. A signed True API adapter,
  rules for specific GTIN/product groups, per-unit sale/return and FFD
  fiscal marking remain required.
- **Russian Post:** application token/user auth, tariff quote, creation
  of postal item/dispatch batch, ШПИ/tracking/label and returns remain
  separate integration work. No spurious `VERIFIED` readiness.

## Verification on a disposable staging server

```bash
git checkout main && git pull --ff-only origin main
corepack enable && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build && pnpm stability:check
```

Do NOT infer from successful TypeScript compilation that actual bank,
fiscal, marking or shipment end-to-end integrations have passed.
Do NOT run mutating smoke flows against real customers' production data.
No external account credentials were available in this implementation.
