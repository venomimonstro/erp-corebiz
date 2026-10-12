# Sprint 239 — ATOL Online: advance offset, delivery and full refund

Date: 2026-10-12. Direct commits to main, no CI/GitHub Actions.

**Status: source implemented, not production-certified.** Do NOT set
`COREBIZ_ATOL_PRODUCTION_RECEIPTS_ENABLED=true` before audited staging
fiscal E2E with a real seller contract, settlement and return documents.

## What changed

Migration `239_atol_advance_offset_refund.sql` extends the fiscal ledger
without destroying or replaying prepayment receipts:

| Operation | API endpoint | Source-of-truth | ATOL API |
| --- | --- | --- | --- |
| `sell` | `.../receipt` | Bank capture + Finance | `sell`, `full_prepayment`, payment type 1 |
| `sell_full_payment` | `.../settlement` | Original ATOL prepayment DONE + physically delivered order | `sell`, `full_payment`, payment type 2 (advance offset) |
| `sell_refund` | `.../refund-receipt` | Confirmed full bank refund + Finance refund | `sell_refund`, cashless refund type 1 |

- Per `tenant + payment + operation`, no more than one fiscal
  submission; per `tenant + bank refund`, no more than one refund receipt.
- Encrypted merchant credentials never reach the UI or logs. Each
  fiscal operation uses the KKT connection associated with the initial
  confirmed prepayment; rotation is blocked while open operations remain.
- Provider registration gives `WAIT`, NOT a fiscal receipt.
- Report GET compares the immutable ATOL UUID and `external_id`,
  verifies receipt total, FN, FD, fiscal sign (FP).
- Timeout or ambiguous HTTP response becomes `UNKNOWN` and is
  NEVER blindly retried. Operator reconciles UUID from ATOL cabinet.
- A verified refund from YooKassa does NOT mark `commerce_refund.fiscal_status`
  successful; only independently verified ATOL `sell_refund` can.
- Successful second receipt NEVER collects bank money again.
- Provider `WAIT` cannot overwrite a previously confirmed `DONE`.

## Confirming actual product delivery

CoreBiz previously had a stock shipment transition but no audited
handover event in `commerce_order_delivery`. New:

`POST /api/v1/provider-connectors/sites/:siteId/atol/payments/:paymentId/confirm-handover`

Body: `{"proofReference":"handover act #...", "confirmed":true}`.

The operator must have **both** `sites.manage` and `sales.write` with
company-wide scope, prove an order payment, Finance posting, original
fiscal receipt and an actual `sales_order.fulfillment_status='SHIPPED'`.
An order that is only reserved cannot be handed over. If CDEK booked
that order, CDEK must confirm `DELIVERED` first.

The successful action sets `commerce_order_delivery.delivery_status`
to `DELIVERED` and creates an `audit_event` with proof reference.
No stock or cash ledger is modified by confirmation alone.

For local delivery or pickup, the documentary evidence is manually
provided by an authorized manager. This is **not cryptographic proof
of receipt by buyer**; production policy must define acceptable signed
handover documents.

## Follow-up queue and operator UI

On `/app/settings/integrations/connect` under ATOL:
- sales with bank payment but no initial fiscal receipt;
- shipped orders awaiting documentary handover;
- actually handed-over orders awaiting advance offset;
- bank-confirmed full refunds requiring a fiscal refund receipt;
- immutable per-operation fiscal ledger and GET report with FN/FD/FP.

Endpoints:

```text
GET  /api/v1/provider-connectors/sites/:siteId/atol/pending-followups
POST /api/v1/provider-connectors/sites/:siteId/atol/payments/:paymentId/confirm-handover
POST /api/v1/provider-connectors/sites/:siteId/atol/payments/:paymentId/settlement
POST /api/v1/provider-connectors/sites/:siteId/atol/payments/:paymentId/refund-receipt
GET  /api/v1/provider-connectors/sites/:siteId/atol/receipts
POST /api/v1/provider-connectors/sites/:siteId/atol/receipts/:docId/verify
```

## Important commercial NO-GO conditions

1. Only **full prepaid, full delivery, full bank refund**, and eligible
   non-marked/non-excisable items in this pilot. Partial fulfilments,
   partial returns, split tenders, payment corrections, complex tax
   multi-rate SKUs or shipping over/undercharges are not solved.
2. Classification and legality of the first receipt's
   `payment_object=10` and itemized lines, and the precise matching
   accounting policy for `sell_refund`, **must be validated** with
   ATOL's test KKT and the seller's accountant under FFD 1.2 before
   live cash registers are enabled.
3. Serial/IMEI alone is NOT a marking integration. Marked goods still
   require true Data Matrix and ChZ exchange, permission checks and
   correct FFD tagging.
4. A documented manual reference for handover is not a carrier/buyer
   signed acknowledgement in itself.
5. Cashier scope by retail location, production E2E, monitoring old
   `UNKNOWN` receipts, and automatic poll/reconciliation queues remain
   required for massive commercial use.

## Deployment acceptance sequence (staging only)

1. Backup DB, apply **migration 239** after migrations 234–238.
2. Run build, typecheck and tests without touching real customers.
3. With feature flags for real receipts **disabled by default**, check
   historical YooKassa-origin payments still have exactly one original
   fiscal provider.
4. With a test YooKassa merchant, test ATOL `sell`, `report/DONE`,
   full physical fulfilment, handover audit, `sell/full_payment`,
   `report/DONE`.
5. Repeat with full bank refund BEFORE delivery: `sell_refund` with
   returned cashless amount. Test after delivery only following DONE
   settlement.
6. Run concurrent requests and provider timeout/500 scenarios;
   no duplicate fiscal document, bank posting or stock movement.
7. Validate consumer fiscal receipts with FN/FD/FP through OFD and
   ensure proper tax system/VAT classification.
8. Only then consider enabling production feature flags after
   sign-off and financial monitoring.

Environment flags:

```dotenv
COREBIZ_ATOL_RECEIPTS_ENABLED=false
COREBIZ_ATOL_PRODUCTION_RECEIPTS_ENABLED=false
```

Validation commands on disposable staging from repo root:

```bash
git checkout main && git pull --ff-only origin main
corepack enable && pnpm install --frozen-lockfile
pnpm db:migrate && pnpm typecheck && pnpm test
pnpm build && pnpm stability:check
```

**No PostgreSQL migrations, TypeScript compiler, actual bank, KKT or
browser E2E were executed in this chat session.** All source test
assertions and new unit tests need actual execution on staging.

Official ATOL references:
- https://help.atol.online/article/26774 (advance and closing receipt)
- https://atol.online/api_v5 (sell, sell_refund, report)
