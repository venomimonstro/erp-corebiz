# Текущий этап разработки

## Статус

**Функциональная линия:** R2 — ERP Pilot реализована до Sprint 12 включительно.  
**Активная разработка:** R6 / Sprint 30 — Marketplaces Ozon/WB.  
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

## R3 — Commercial MVP реализовано

### Sprint 13 — Onboarding / Migration
- migration batch/rows;
- CSV/XLSX ingestion;
- delimiter detection;
- auto mapping;
- dry-run/validation;
- duplicate-safe product/customer import;
- reconciliation;
- onboarding state.

### Sprint 14 — Billing
- plans/entitlements;
- tenant subscription;
- trial/grace/read-only;
- backend read-only enforcement;
- billing workspace;
- downgrade without data deletion.

### Sprint 15 — Ticket System / Knowledge Base
- tickets/messages;
- attachment metadata;
- contextual URL;
- knowledge search;
- temporary support grant with hashed one-time token.

### Sprint 16 — Customization
- custom fields/typed values;
- versioned form layouts;
- saved views;
- capability toggles;
- custom roles without mutation of system roles.

### Sprint 17 — Workflow V1
- transactional domain event outbox;
- versioned workflow draft/test/publish;
- conditions;
- CREATE_TASK / ADD_TAG / NOTIFY allowlist;
- worker with SKIP LOCKED;
- retry/backoff;
- execution log and recursion depth limit.

### Sprint 18 — Production Hardening
- global API rate limit;
- auth-specific rate limits;
- API security headers;
- explicit request size limits;
- liveness/readiness;
- Postgres/Redis latency diagnostics;
- outbox diagnostics;
- API request p50/p95/p99 metrics;
- migration advisory lock;
- local release-check;
- guarded backup/restore scripts.

## R4 — Service/Scheduling реализовано

### Sprint 19 — Resource Model
- универсальный Resource;
- employee/room/equipment/vehicle/workplace/hall/machine;
- skills/levels;
- capacity;
- branch binding;
- weekly schedules;
- time-off/maintenance blocks.

### Sprint 20 — Booking
- service catalog;
- duration/price/buffer snapshots;
- skill requirements by resource type;
- availability;
- transactional capacity locks;
- booking;
- reschedule;
- arrived/in-service/completed/cancel/no-show;
- booking domain events.

### Sprint 21 — Service Workspace
- today workspace;
- service/resource analytics;
- customer service history;
- booking materials;
- idempotent material consumption through Inventory Ledger.

## R5 — Growth Analytics реализовано

### Sprint 22 — Tracker / Visitor / Session
- privacy-first first-party tracker;
- consent=GRANTED enforcement;
- visitor/session/event;
- UTM/referrer/yclid/gclid;
- exact-domain allowlist;
- no raw IP/User-Agent storage;
- Redis anti-abuse limit;
- tracker sites and source dashboard.

### Sprint 23 — Marketing Data / Yandex Direct
- encrypted OAuth credentials;
- marketing connections/campaigns/daily stats;
- async sync jobs;
- Yandex Direct Reports API 200/201/202 flow;
- retryIn/backoff;
- spend/impressions/clicks/CPC;
- campaign aliases.

### Sprint 24 — Identity / Touchpoints / Attribution
- auditable visitor→party identity link;
- immutable session-derived touchpoints;
- FIRST_TOUCH / LAST_TOUCH / LAST_PAID_TOUCH;
- 90-day lookback;
- customer journey;
- recalculable attribution without rewriting raw events.

### Sprint 25 — Profitability / Alerts
- campaign alias mapping;
- trade + service conversions;
- payment/refund-aware revenue;
- cost snapshots;
- Gross Profit / Contribution Profit;
- CPC/CPO/CAC/ROAS/ROMI;
- data quality and freshness;
- campaign alert rules.

### Sprint 26 — Calltracking / Offline conversions
- external calltracking connection/webhook;
- webhook secret stored as hash;
- caller phone stored only as HMAC;
- visitor/session/party binding;
- Yandex Metrica offline conversion connection;
- YCLID export queue;
- CSV upload to Metrica;
- asynchronous uploading status polling;
- linkage failure visibility.

### Sprint 27 — Channel connectors foundation
- unified channel connection;
- OWN_SITE/API secure webhook;
- normalized external order inbox;
- external event idempotency;
- external offer → internal SKU mapping;
- NEEDS_MAPPING / READY / IMPORTED / FAILED / IGNORED;
- controlled import through SalesService;
- order import idempotency;
- provider contract reserved for Ozon/WB/Yandex Market.

### Sprint 28 — OMS / ATP / Allocation
- OMS auto-attach for confirmed SalesOrder;
- global ATP = physical - reserved - safety stock;
- per-SKU/warehouse inventory policy;
- deterministic sourcing;
- split allocation across warehouses;
- row-lock reservation through InventoryService;
- allocation explanation and snapshots;
- OMS state machine;
- split shipment through reservation warehouse.

### Sprint 29 — Returns / Backorder / Sourcing
- partial allocation without rollback of successful reservations;
- persistent backorder lines;
- repeated sourcing to close remaining demand;
- backorder ETA/cancel management;
- Return Request lifecycle;
- authorization quantities;
- receive/inspect disposition;
- RESTOCK posts immutable Inventory RETURN;
- non-restock dispositions do not increase available inventory;
- over-return protection.

## Активно — Sprint 30: Marketplaces Ozon/WB

Scope:
- provider-specific encrypted credentials;
- Ozon order pull adapter;
- Wildberries order pull adapter;
- normalized import into Channel Inbox;
- cursor/watermark sync;
- retry/rate-limit/backoff;
- provider health;
- manual sync and worker queue;
- no direct writes into Sales/Inventory from marketplace API.

## Следом

R7 / Sprint 31 — Site builder block core.
