# ADR-003 — Immutable Ledgers

**Status:** Accepted

## Decision

Inventory и Accounting не хранят истину через произвольное изменение текущего значения.

### Inventory
Source of Truth = InventoryTransaction.
InventoryBalance = производная проекция.

### Accounting
Source of Truth = immutable double-entry AccountingEntry.

## Corrections

Inventory:
- Adjustment/Return/WriteOff/etc.

Accounting:
- Reversal + Correct Entry.

## Why

- auditability;
- reconciliation;
- recovery;
- concurrency safety;
- отсутствие “магических” изменений остатков/денег.
