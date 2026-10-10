# CoreBiz — актуальный статус реализации и обязательные доработки

Дата: 2026-10-10  
Ветка: `main`  
CI/GitHub Actions: не используются по решению владельца.

## Решение

По исходному коду основные продуктовые контуры уже реализованы значительно глубже коммерческого MVP. Новые широкие модули до pilot release не являются приоритетом.

Текущий приоритет:

1. production release candidate;
2. доказательство миграций/RLS/сквозных сценариев;
3. restore/reconciliation;
4. нагрузочные/noisy-neighbor gates;
5. ограниченный pilot + hypercare.

До прохождения runtime gates статус production остаётся **NO-GO**.

## Реализовано

### Core ERP / CRM
- tenant / membership / auth;
- RBAC/ABAC, RLS, audit;
- Organization / Party;
- CRM pipeline + Kanban drag&drop;
- tasks;
- Catalog Product → Variant → SKU;
- Sales;
- Procurement;
- immutable Inventory Ledger;
- reservations / shipment / transfer / stock count;
- Finance Lite;
- owner dashboard/action queue.

### Commercial SaaS
- onboarding/migration;
- billing/subscriptions/read-only;
- support/tickets/knowledge base;
- customization;
- workflow/outbox;
- production diagnostics.

### Service businesses
- services/resources/schedules;
- appointments/bookings;
- capacity/availability;
- service materials;
- service profitability.

### Growth / marketing
- first-party tracker;
- sessions/touchpoints;
- Yandex Direct sync;
- attribution;
- campaign profitability/ROMI;
- calltracking bridge;
- offline conversions;
- marketing alerts.

### Commerce / OMS
- channel inbox;
- Ozon/Wildberries;
- SKU mapping;
- OMS;
- ATP/safety stock;
- split allocation;
- backorders;
- returns/reverse logistics.

### Sites / storefront
- versioned block builder;
- DRAFT/PUBLISHED;
- SSR public pages;
- custom domains;
- SEO/OG/canonical;
- ERP storefront/cart/checkout;
- CRM lead forms;
- online booking;
- first-party analytics binding.

### WMS / 3PL
- address storage;
- receiving/put-away;
- picking/packing/shipping;
- cycle counts;
- replenishment;
- waves/cluster;
- TSD/PWA scanner;
- dispatcher/labor metrics;
- slotting;
- inventory owner dimension;
- 3PL operations/billing/client portal/SLA;
- ASN/dock appointments;
- Finance handoff.

### Finance / Accounting RU
- bank statement staging/reconciliation;
- accounting double-entry foundation;
- posting rules/effective dates;
- period locks;
- VAT lifecycle/register/periods;
- month close gates;
- payroll staging/approval/export;
- budget plan/fact;
- cash forecast.

### Operations / product simplicity
- vertical profiles;
- first-value activation;
- role workspaces;
- global search / command palette;
- universal create;
- Go-Live Center;
- unified action queue;
- export/offboarding;
- audit/session center;
- support telemetry;
- release control/evidence;
- golden business journeys;
- runtime pressure dashboard.

## Доработано 2026-10-10

### Noisy-neighbor protection
- `@ApiCost` теперь реально используется global guard как основной источник cost class;
- Redis semaphore leases ограничивают одновременные HEAVY/EXPENSIVE операции;
- EXPENSIVE: 1 concurrent operation per user / 2 per tenant per route;
- HEAVY: 2 per user / 4 per tenant per route;
- lease освобождается на response finish/close; TTL остаётся аварийной страховкой;
- pressure denial записывается в tenant runtime telemetry;
- conversion/calltracking endpoints классифицированы;
- marketplace/marketing/offline-conversion queue budgets уже применяются;
- regression test добавлен.

### Release Candidate hardening
- RC использует единую матрицу из 16 обязательных evidence;
- добавлены `RUNTIME_RLS`, `BUSINESS_JOURNEYS`, `NOISY_NEIGHBOR`, `PERFORMANCE`;
- RC оценивает evidence **только целевой версии**;
- stale/failing/missing evidence блокируют readiness;
- approval дополнительно защищён PostgreSQL trigger и не может обойти release gates;
- verdict старше 4 часов не допускается к approval;
- новое evidence после evaluate требует повторного evaluate;
- Release UI показывает точную remediation для каждого blocker;
- `production-gate.sh` теперь включает реальный backup→restore drill на отдельной disposable DB;
- runtime noisy-neighbor gate проверяет атомарный Redis semaphore, release и TTL recovery;
- gate сохраняет machine-readable manifest.

Важно: наличие этих механизмов не означает PASS. Production остаётся **NO-GO**, пока gate не выполнен на disposable/staging окружении и immutable evidence не записано для конкретного release candidate.

## Что ещё НЕ доказано / НЕ завершено

Это release blockers, а не список новых продуктовых модулей.

### P0
- полный replay всех миграций на чистой disposable PostgreSQL;
- проверка production runtime DB role: NOSUPERUSER, NOBYPASSRLS, non-owner;
- cross-tenant read/write/search/export E2E под реальной runtime SQL-role;
- фактический `pnpm typecheck`, `pnpm test`, `pnpm build`;
- golden business journey matrix на disposable environment;
- checkout concurrency runtime test;
- WMS aggregate/location/owner reconciliation;
- Finance/Accounting reconciliation;
- backup restore drill;
- performance/noisy-neighbor runtime evidence.

### P1
- browser E2E на реальном HTTPS/custom domain;
- реальный Ozon/WB/Yandex/Calltracking staging test;
- бухгалтерская сверка с эталоном 1С за закрытый период;
- payroll/accounting statutory certification;
- pilot telemetry и hypercare;
- password recovery/email verification UX необходимо подтвердить runtime-тестом.

## Не делать до закрытия P0

- не добавлять ещё один универсальный бизнес-модуль;
- не объявлять production-ready только по наличию кода;
- не переименовывать старые миграции с повторяющимися numeric prefix;
- не использовать owner/superuser PostgreSQL роль для API;
- не отключать RLS ради исправления auth;
- не автоматизировать необратимые Accounting/Inventory операции через AI.

## Следующий порядок

### Sprint 73 — RC hardening
Контроли реализации закрыты. Runtime acceptance остаётся обязательным внешним gate перед pilot/production.

### Sprint 74 — Pilot rollout / hypercare
5–10 реальных компаний, разные профили:
- TRADE;
- ECOMMERCE;
- SERVICE;
- WAREHOUSE_3PL.

Только после успешного pilot gate переходить к новым отраслевым глубинам:
POS/ККТ, маркировка, партии/серии/FEFO, производство/BOM, расширенное ЭДО.
