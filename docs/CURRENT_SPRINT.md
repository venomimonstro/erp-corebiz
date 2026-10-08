# Текущий этап разработки

## Статус

**Функциональная линия:** R2 — ERP Pilot реализована до Sprint 12 включительно.  
**Активная разработка:** R3 / Sprint 13 — Onboarding & Migration.  
**Ветка разработки:** `main`, без GitHub Actions/CI по решению владельца.

## Реализовано в main

### Sprint 0 — Engineering Foundation
- pnpm monorepo;
- NestJS API / Next.js Web / worker;
- PostgreSQL + Redis local compose;
- env fail-fast validation;
- migration runner;
- request trace id;
- common API error envelope;
- local bootstrap scripts;
- Jest harness foundation.

### Sprint 1 — Identity / Tenant / Membership
- signup/login/logout;
- Argon2id;
- hashed session token;
- HttpOnly cookie;
- server-side active tenant membership;
- tenant switching;
- tenant invitation model/API;
- CSRF origin guard;
- Redis login/registration rate limit;
- email verification/password reset DB models.

### Sprint 2 — Security / RLS / RBAC / Audit
- PostgreSQL RLS foundation;
- OWNER/ADMIN/SALES/PROCUREMENT/WAREHOUSE/FINANCE/VIEWER roles;
- own/team/branch/all scopes;
- permission guard;
- audit events;
- tenant-safe business validation.

### Sprint 3–6 — CRM Alpha
- Organization: legal entities, branches, teams;
- Party Customer/Supplier;
- CRM Pipeline/Stage/Deal;
- Kanban drag&drop;
- optimistic deal version;
- won/lost transitions;
- Deal→Order;
- Tasks with today/overdue/mine;
- CRM and task scope enforcement.

### Sprint 7 — Catalog
- Product → Variant → SKU;
- stockable/non-stock;
- sale price / cost;
- catalog workspace.

### Sprint 8 — Sales
- SalesOrder + lines;
- independent order/payment/fulfillment statuses;
- tenant-safe order numbering;
- idempotent Deal→Order;
- cost snapshot in sales line;
- confirm → reserve → ship workflow.

### Sprint 9 — Procurement
- Supplier;
- PurchaseOrder;
- partial receipts;
- receipt lines;
- confirmation creates payable;
- receipt atomically posts Inventory Ledger.

### Sprint 10 — Inventory
- Warehouse;
- immutable InventoryTransaction;
- physical/reserved/available balance projection;
- reservations with row locks;
- shipment;
- adjustments;
- inter-warehouse transfers;
- stock count;
- stock-count reconciliation against current physical balance.

### Sprint 11 — Finance Lite
- CashAccount;
- cash flow categories;
- receivable/payable obligations;
- customer payments;
- supplier payments;
- refunds;
- idempotent payment posting;
- immutable financial payment fields;
- finance workspace.

### Sprint 12 — Owner Dashboard & Action Queue
- cash;
- sales 30d;
- cost-snapshot gross profit;
- open orders;
- AR/AP;
- stock value;
- overdue tasks;
- deal-without-next-action risk;
- overdue obligation risk;
- stock risk.

## Verification debt / Gate не закрыт автоматически

Функциональная реализация опережает подтверждённые engineering gates. До production launch обязательно локально подтвердить:

1. `pnpm install` и lockfile reproducibility.
2. `pnpm build`.
3. `pnpm typecheck`.
4. `pnpm test`.
5. Полный migration run на чистой PostgreSQL.
6. Cross-tenant integration tests.
7. Auth/session integration tests.
8. Sales→Finance→Inventory end-to-end tests.
9. Procurement→Receipt→Inventory→AP end-to-end tests.
10. Load baseline.
11. Backup/restore drill.

Отсутствие GitHub Actions не означает отсутствие проверок: проверки должны запускаться локально/на сервере перед production release.

## Активно — Sprint 13: Onboarding / Migration

Scope:
- migration batch;
- CSV/XLSX ingestion;
- entity mapping;
- dry-run;
- row validation;
- duplicate detection;
- product/customer import first;
- idempotent import;
- reconciliation report;
- first-company onboarding state.

## Следом

Sprint 14 — Billing.  
Sprint 15 — Ticket System / Knowledge Base.  
Sprint 16 — Customization.  
Sprint 17 — Workflow V1.  
Sprint 18 — Production Hardening.
