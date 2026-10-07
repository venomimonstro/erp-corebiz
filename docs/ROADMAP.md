# Roadmap и спринты

Спринт — логическая поставка, а не обещание календарной длительности.

## R0 — Foundation

### Sprint 0 — Repository & Engineering Foundation
- monorepo;
- apps/web, apps/api, apps/worker;
- packages/contracts, config, security, ui;
- env conventions;
- lint/typecheck/test scripts;
- health endpoint;
- architecture docs;
- SPEC_GAP/ADR process.

**Gate:** проект собирается локально; архитектурные правила зафиксированы.

### Sprint 1 — Identity / Tenant / Membership
- User;
- Tenant;
- TenantMembership;
- login/signup;
- email verification;
- password reset;
- secure session;
- tenant switch.

### Sprint 2 — Security / RLS / RBAC / Audit
- PostgreSQL RLS foundation;
- roles/permissions;
- own/team/branch/all scopes;
- AuditEvent;
- SecurityEvent;
- cross-tenant tests.

**R0 Gate:** cross-tenant isolation proven.

## R1 — CRM Alpha

### Sprint 3 — Organization & Party
- LegalEntity;
- Branch;
- Team;
- Person/Organization Party;
- Customer/Supplier roles.

### Sprint 4 — CRM Pipeline
- Pipeline;
- Stage;
- Deal;
- Kanban;
- MoveDealCommand;
- optimistic drag/drop.

### Sprint 5 — Deal Card
- fields;
- timeline;
- activities;
- next action;
- won/lost reasons;
- Deal→Order foundation.

### Sprint 6 — Tasks
- Task states;
- list/kanban;
- today/overdue filters;
- linking;
- reminders;
- team workload.

**R1 Gate:** реальная sales-команда может вести pipeline без Excel.

## R2 — ERP Pilot

### Sprint 7 — Catalog
- Product/Variant/SKU;
- Service;
- price/cost;
- categories;
- Excel import.

### Sprint 8 — Sales
- SalesOrder;
- independent order/payment/fulfillment statuses;
- order lines;
- documents basic;
- Deal→Order idempotency.

### Sprint 9 — Procurement
- suppliers;
- PurchaseOrder;
- partial receipts;
- supplier pricing basic.

### Sprint 10 — Inventory
- Warehouse;
- InventoryTransaction;
- Balance projection;
- Reservation;
- transfers;
- adjustments;
- stock count basic.

### Sprint 11 — Finance Lite
- CashAccount;
- Payment;
- AR/AP;
- income/expense categories;
- refund.

### Sprint 12 — Owner Dashboard & Action Queue
- money/sales/profit/AR/stock;
- stale deal;
- overdue task;
- stock risk;
- payment risk.

**R2 Gate:** Customer→Deal→Order→Payment→Purchase→Receipt→Shipment works end-to-end.

## R3 — Commercial MVP

### Sprint 13 — Onboarding / Migration
- capability preset;
- role workspace preset;
- CSV/XLSX import;
- mapping;
- dry-run;
- validation;
- reconciliation;
- idempotent batches.

### Sprint 14 — Billing
- plans;
- entitlements;
- subscription;
- payment status;
- grace/read-only;
- downgrade without data deletion.

### Sprint 15 — Ticket System / Knowledge Base
- ticket states;
- attachments;
- support queues;
- context help;
- knowledge articles;
- temporary support grant.

### Sprint 16 — Customization
- custom fields;
- form layout;
- saved views;
- role editor;
- capability toggles.

### Sprint 17 — Workflow V1
- WHEN/IF/THEN;
- create task;
- assign responsible;
- add tag;
- notify;
- draft/validate/test/publish;
- execution log;
- recursion/limit protection.

### Sprint 18 — Production Hardening
- rate limits;
- metrics/tracing;
- backup/restore drill;
- error tracking;
- load baseline;
- security review;
- release gates.

**R3 Gate:** публичные платные клиенты разрешены.

## R4 — Service/Scheduling

### Sprint 19 — Resource Model
- Resource;
- skills/capacity;
- schedules;
- availability.

### Sprint 20 — Booking
- Service;
- duration/pricing rules;
- booking;
- resource reservation;
- reschedule/cancel/no-show.

### Sprint 21 — Service Workspace
- calendar day/week;
- customer history;
- consumption of inventory;
- employee/service analytics.

**R4 Gate:** beauty/autoservice/studio scenario works without separate codebase.

## R5 — Growth Analytics

### Sprint 22 — Tracker / Visitor / Session
### Sprint 23 — Marketing Data / Yandex Direct
### Sprint 24 — Lead identity / Touchpoints / Attribution
### Sprint 25 — Profitability Dashboard / Alerts
### Sprint 26 — Calltracking integrations / offline conversions

**R5 Gate:** spend→lead→paid order→profit chain auditable.

## R6 — Commerce / OMS

### Sprint 27 — Channel connectors foundation
### Sprint 28 — OMS / ATP / Allocation
### Sprint 29 — Returns / Backorder / Sourcing
### Sprint 30 — Marketplaces Ozon/WB

## R7 — Sites / Storefront

### Sprint 31 — Site builder block core
### Sprint 32 — Forms/CRM/Booking binding
### Sprint 33 — Storefront/catalog/cart/checkout
### Sprint 34 — Domains/publishing/SEO

## R8 — WMS

### Sprint 35 — topology/bins/tasks
### Sprint 36 — receiving/put-away/pick/pack/ship
### Sprint 37 — TSD/PWA/offline/idempotency
### Sprint 38 — replenishment/waves/dispatcher

## R9 — Accounting RU

### Sprint 39 — accounting core/ledger/posting rules
### Sprint 40 — bank/AR/AP/reconciliation
### Sprint 41 — VAT/tax/period close
### Sprint 42 — parallel run / reports / cutover tools

**R9 Gate:** reference periods reconciled; accounting expert sign-off.

## R10 — Payroll / Advanced Finance
Отдельная программа спринтов после Accounting Gate.

## R11 — Intelligence / Enterprise
- forecasting;
- controlled AI assistants;
- anomaly detection;
- dedicated tenant routing;
- advanced IAM;
- 3PL/enterprise features.

## Правило перехода

Следующий maturity layer не открывается только потому, что предыдущий “почти готов”.

Gate должен подтверждаться:
- business acceptance;
- security;
- data integrity;
- performance;
- support readiness;
- documentation.
