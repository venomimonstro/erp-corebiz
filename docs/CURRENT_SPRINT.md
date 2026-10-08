# Текущий этап разработки

## Статус

**Функциональная линия:** R2 — ERP Pilot реализована до Sprint 12 включительно.  
**Активная разработка:** R8 / Sprint 46 — 3PL Client Portal.  
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

### Sprint 30 — Marketplaces Ozon/WB
- encrypted marketplace credentials;
- dedicated Ozon/WB connection flows;
- marketplace sync job queue with lease/retry/backoff;
- Ozon FBS v4 cursor sync;
- Wildberries FBS v3 next/date window sync;
- provider rate-limit handling;
- page-by-page checkpoints;
- normalized Channel Inbox import only;
- existing SKU mapping reuse;
- marketplace order deduplication;
- connection health/freshness;
- OMS allocation state synchronized with Inventory reservation/shipment state.

**R6 Gate:** external channel → Integration Inbox → mapped SalesOrder → OMS ATP/allocation → Inventory reservation/shipment → return/backorder is now represented end-to-end in one domain chain.

### Sprint 31 — Site Builder Core
- Site / Page / PageVersion;
- one DRAFT and one PUBLISHED version invariant;
- typed block allowlist;
- structured block editor without JSON;
- safe URL protocol allowlist;
- no arbitrary HTML/JS;
- default ready-to-edit homepage;
- global public slug;
- immutable publication audit;
- SSR public renderer;
- SEO title/meta from published version.

### Sprint 32 — Storefront / Catalog / Cart / Checkout
- storefront_config per site;
- enable/disable storefront from client workspace;
- ERP Product/Variant/SKU public catalog;
- ATP visibility with safety stock;
- server-side public cart with expiry;
- quantity updates and cart totals;
- checkout idempotency;
- public customer → Party;
- checkout → SalesService → confirmed SalesOrder;
- no direct SQL mutation of Sales/Inventory from public request;
- published PRODUCT_GRID/CATALOG blocks render live storefront;
- global public_slug storefront resolution.

### Sprint 33 — Forms / CRM / Booking binding
- form bindings per site;
- CRM_LEAD / BOOKING actions;
- responsible membership binding;
- service binding for booking;
- public submission idempotency;
- honeypot and Redis rate limit;
- tenant-isolated submissions;
- CRM form → Party + Deal through domain services;
- booking form → Party + ServiceBooking through domain services;
- structured binding selector in Site Builder;
- public FORM / BOOKING renderers.

### Sprint 34 — Domains / SEO / Analytics auto-wiring
- globally unique custom hostnames;
- DNS TXT verification;
- VERIFIED → ACTIVE lifecycle;
- one primary domain per site;
- custom-domain host routing in Next;
- SEO robots / canonical / Open Graph;
- SSR metadata;
- public sitemap.xml / robots.txt for slug and custom domain;
- site → first-party tracker binding;
- tracker allowlist updated on domain activation;
- analytics consent before script load;
- no cross-tenant hostname collisions.

**R7 Gate:** business can launch a public site/store, collect CRM leads/bookings/orders, use its own domain, and connect first-party marketing analytics without a separate CMS/landing/lead-form stack.

### Sprint 35 — WMS Address Storage Foundation
- optional WMS profile per warehouse;
- progressive ADDRESS / ADVANCED modes;
- zone types for receiving/storage/picking/packing/shipping/quarantine/returns/cross-dock;
- hierarchical address locations;
- capacity and mixed-SKU/lot restrictions;
- block/maintenance states;
- pick sequence;
- 2D topology coordinates;
- SKU put-away eligibility rules;
- WMS UI only for warehouses where it is enabled;
- Inventory Ledger remains the only quantity source of truth while topology is configured.

### Sprint 36 — Receiving / Put-away Tasks
- explicit location-ledger initialization;
- system UNASSIGNED bootstrap location;
- existing physical stock bootstrap with immutable movements;
- new goods receipts mirrored to UNASSIGNED idempotently;
- location balance subledger;
- put-away candidate selection from SKU rules / zone priority / pick sequence;
- PUTAWAY task create / claim / complete;
- mixed-SKU restriction enforced at completion;
- location ledger reconciliation to Inventory Balance after operations;
- bypass movements blocked once location ledger is active.

### Sprint 37 — Picking / Packing / Shipping Tasks
- OMS reservation → WMS location pick allocation;
- concurrent pick availability by location;
- PICK task generation;
- outbound PACKING/SHIPPING staging;
- last PICK automatically opens PACK;
- PACK automatically opens SHIP;
- WMS shipment consumes Inventory reservation transactionally;
- multi-warehouse PARTIALLY_SHIPPED → SHIPPED;
- location and aggregate ledger reconciliation.

### Sprint 38 — Cycle Count / Replenishment
- cycle count document/line snapshot;
- COUNT task generation;
- stale-snapshot protection;
- factual count posting;
- variance adjusts Inventory Ledger + location ledger atomically;
- count cannot reduce physical below active reservations;
- FIXED_PICK min/max configuration;
- replenishment planner from STORAGE;
- duplicate active replenishment prevention;
- REPLENISH task completion with reconciliation;
- client UI for count/replenishment/pick-face setup.

### Sprint 39 — Wave / Cluster Picking / Dispatcher
- existing PICK tasks grouped without changing reservation quantities;
- ORDER / BATCH / ZONE / CLUSTER strategies;
- DRAFT → RELEASED → IN_PROGRESS → COMPLETED lifecycle;
- cluster slot per sales order;
- wave priority and size;
- claim-next with SKIP LOCKED;
- dispatcher progress counters;
- automatic wave completion after final PICK;
- no inventory mutation in wave orchestration.

### Sprint 40 — TSD / PWA scanner-first execution
- mobile warehouse workspace;
- claim-next task command;
- keyboard-wedge scanner input;
- server-side FROM / SKU / TO validation;
- scanner-validated mobile completion;
- immutable scan audit;
- task problem/block flow;
- BLOCKED task state;
- offline client command queue with ordered replay;
- PWA manifest/service worker;
- service worker never caches business API responses;
- no hidden inventory mutation from scanner endpoints.

### Sprint 41 — Advanced WMS Dispatcher / Labor Metrics
- warehouse labor scorecard;
- tasks/hour and median cycle time;
- active operators;
- task-type throughput;
- aged backlog risk bands;
- blocked/failed exception queue;
- workload by zone/task type;
- dispatcher drill-down;
- operational metrics only, no payroll coupling.

### Sprint 42 — WMS Performance Hardening / Slotting
- hot-path task/labor/PICK indexes;
- PICK velocity by SKU;
- suggested pick-face location;
- suggested min/max replenishment thresholds;
- recommendation reasons;
- explicit FIXED_PICK apply only;
- no automatic inventory movement;
- recommendation engine does not mutate stock ledgers.

### Sprint 43 — WMS 3PL / Owner Inventory Foundation
- inventory owner master data;
- default INTERNAL owner;
- CLIENT owner linked to Party;
- warehouse/owner contract;
- owner aggregate and location subledgers;
- controlled TOTAL_ONLY → OWNER_LEDGER initialization;
- aggregate↔owner↔location reconciliation;
- cross-tenant owner/dimension integrity guards;
- immutable owner movement ledgers;
- owner workspace.

### Sprint 44 — 3PL Owner-aware Operations
- purchase order / goods receipt owner dimension;
- sales order / reservation owner dimension;
- owner-aware receipt into UNASSIGNED;
- owner-aware put-away and location movements;
- owner-aware reservation and ATP validation;
- owner-aware pick/pack/shipment;
- owner contract gate for CLIENT stock;
- owner document freeze after committed warehouse operations;
- database integrity for reservation/pick/receipt ownership;
- shipment consumes aggregate + owner ledgers atomically.

### Sprint 45 — 3PL Billing / Statements
- effective-dated contract rates;
- receipt unit billing;
- put-away / pick / pack task billing;
- shipment unit billing;
- storage unit-day billing from owner movement history;
- draft statement regeneration;
- finalized statement immutability;
- detailed calculation lines;
- finance-oriented 3PL billing workspace.

## Активно — Sprint 46: 3PL Client Portal

Scope:
- external owner access invitation/token lifecycle;
- access bound to exactly one inventory_owner;
- hashed one-time/rotatable credentials;
- read-only owner stock;
- owner location stock;
- owner movements;
- owner sales/order fulfillment visibility;
- finalized 3PL statements;
- no access to operator internal owners, costs or other tenants;
- revocation and audit.

## Следом

Sprint 47 — 3PL SLA / claims / client requests.  
Sprint 48 — WMS dock appointments / inbound ASN.
