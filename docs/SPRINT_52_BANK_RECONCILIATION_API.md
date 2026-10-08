# Sprint 52 — Bank reconciliation API

## Delivered
- Migration 089: immutable-intent imported statement headers/lines, tenant-scoped RLS and matching dimensions.
- Migration 090: one bank line per posted payment; imported line snapshots immutable; finalized statement state immutable.
- Finance service: statement list, line inspection, linking to existing POSTED payments and finalizing a fully matched statement.
- Protected routes:
  - GET /finance/bank-statements (finance.read)
  - GET /finance/bank-statements/:statementId/lines (finance.read)
  - POST /finance/bank-statements/match (finance.write), {lineId,paymentId}
  - POST /finance/bank-statements/:statementId/reconcile (finance.write)

## Safety boundary
Bank reconciliation **does not create, reverse or alter payment journal records**. A bank line may match only an existing POSTED payment on the same tenant/cash account/currency/direction/amount. The PostgreSQL trigger rejects mismatched payments. Statements can be RECONCILED only when every imported line has a payment.

## Remaining acceptance work
1. Integrate secure bank file imports (CSV/1C formats), robust parsers and bank signature/origin validation where available.
2. Manual PostgreSQL migration replay through 090, full backend typecheck/build and integration tests.
3. Test parallel attempts to match one payment to two lines (unique index must reject).
4. Test finalized statement rejects new lines; currently an import writer can still add lines to a finalized statement. Harden before production.
5. Verify cross-tenant isolation, payment refunds and reversal behavior.
6. Add audited match correction workflow, historical import deduplication and outstanding bank balance reconciliation.
7. Validate statement-with-zero-lines behavior against product policy.

Engineering code committed directly to main; production readiness is **not** yet established.
