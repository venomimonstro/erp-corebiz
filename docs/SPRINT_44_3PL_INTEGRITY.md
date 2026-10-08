# Sprint 44 — 3PL data-integrity hardening

## Delivered: 44a — owner-reference tenant isolation

Migration: `063_wms_3pl_owner_tenant_integrity.sql`.

This migration attaches a database-level owner/tenant validation trigger to the 3PL contract, owner balances, owner movement ledgers, sales and purchase orders, receipts, reservations, inventory transactions, pick allocations and warehouse tasks.

Before creating triggers, the migration audits every affected table and aborts atomically if any referenced owner belongs to a different tenant or does not exist. No silent repair or reassignment is attempted.

## Mandatory local acceptance gate

Run in an isolated PostgreSQL database with a full migration replay:

1. Create tenants A and B, with their own default owners.
2. Under tenant A, attempt to create a sales order, warehouse contract or owner-balance row referring to tenant B's owner. The database must reject the write with SQLSTATE 23514.
3. Confirm valid tenant A owner references remain accepted by the existing business workflows.
4. Confirm `warehouse_task.owner_id IS NULL` remains allowed for legacy tasks.
5. Confirm failed migration/data-integrity audits roll back all trigger additions.
6. Run the local `pnpm typecheck`, `pnpm build`, `pnpm test`, and full database migration/reconciliation suite.
7. Verify receipt → owner balance → location owner balance; reserve → pick → ship → reconciliation and parallel reservations.

## Remaining Sprint 44 gates

- Validate tenant ownership for warehouse, SKU, location and Party references, not just owner ID.
- Complete concurrency regression for owner-aware reserve/release and shipment.
- Validate contract lifecycle and explicit error responses for SUSPENDED/CLOSED 3PL contracts.
- Verify no ledger operation can bypass aggregate↔owner↔location reconciliation.
- Test backup/restore and a complete end-to-end tenant-isolation matrix.

**Release status:** engineering change committed to `main`; acceptance and production gates remain open. Do not assume successful compilation, migration replay or running-system validation without executing them.
