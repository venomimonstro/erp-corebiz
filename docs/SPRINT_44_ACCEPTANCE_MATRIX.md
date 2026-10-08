# Sprint 44 — acceptance checks

Source changes 063–067 enforce tenant and inventory-owner consistency.

## Release checks

- Replay migrations on empty PostgreSQL and populated sanitized copy.
- Verify reservations match sales order, line, SKU and owner.
- Verify WMS pick allocations match reservation, warehouse and locations.
- Verify cross-tenant assignments are rejected.
- Exercise concurrent reservations and repeated idempotency keys.
- Verify journal UPDATE/DELETE are rejected.
- Run `scripts/wms_3pl_reconcile.sql` after receipt, picking, shipping and returns.
- Verify backup and restore.

The production gate is still open until these tests are executed. Next: owner-aware stock count, returns, service billing.
