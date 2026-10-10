# BUSINESS OS / CoreBiz — фактический статус реализации

Дата: 2026-10-10  
Ветка: `main`  
CI / GitHub Actions: не используются по решению владельца.

## Итог

Функционально проект уже вышел далеко за ERP MVP. В исходниках реализованы CRM, задачи, продажи, закупки, склад, финансы, сервис/запись, Growth Analytics, OMS, сайты/магазин, WMS/3PL, бухгалтерия РФ, НДС, payroll staging, Go-Live, Action Queue, экспорт данных, аудит, security center и release-control механизмы.

Это **не означает production PASS**. До подтверждённого disposable migration replay, typecheck/test/build, cross-tenant verification, browser golden journeys, concurrency/reconciliation и backup/restore проект остаётся release candidate, а не доказанно готовым production-продуктом.

## Реализовано

### SaaS / Platform
- Tenant / Membership / roles / permissions.
- PostgreSQL RLS foundation.
- Auth/session, invitation, password flows.
- Billing / entitlements / grace / read-only.
- Audit / session center / support / KB.
- Customization / capability toggles / workflows.
- Vertical presets and first-day activation.
- Go-Live Center / Hypercare state.
- Action Queue.
- Data export / offboarding readiness.
- Release evidence and runtime diagnostics.

### CRM / Tasks / Sales
- Party model.
- CRM pipeline and Kanban drag-and-drop.
- Tasks.
- Deal → SalesOrder.
- Sales state machine.
- Payments / financial obligations.
- Pricing and cost snapshots.

### Procurement / Inventory
- PurchaseOrder and partial receipt.
- Immutable Inventory Ledger.
- Reservations with row locks.
- Transfers / stock count / adjustments.
- Multi-warehouse shipment.
- ATP / safety stock.

### Service businesses
- Services.
- Employees/resources/equipment/rooms.
- Schedules and availability.
- Booking / reschedule / no-show / completion.
- Public booking forms.
- Service materials and profitability snapshots.

### Growth / сквозная аналитика
- First-party tracker.
- Consent-aware tracking.
- Yandex Direct spend sync.
- Attribution.
- Campaign profitability.
- CPO / CAC / ROAS / ROMI.
- Calltracking bridge.
- Offline conversions to Yandex Metrica.
- Marketing alerts.

### Commerce / OMS
- Channel Integration Inbox.
- OWN_SITE / API.
- Ozon / Wildberries sync adapters.
- SKU mappings.
- OMS global ATP.
- Split allocation.
- Backorder.
- Returns and disposition.
- Reverse logistics.

### Sites / Storefront
- Versioned block Site Builder.
- Safe typed blocks, no arbitrary JS.
- Public SSR pages.
- Storefront catalog from ERP.
- Server-side cart.
- Idempotent checkout.
- CRM forms.
- Public booking.
- Custom domains.
- SEO / canonical / Open Graph.
- sitemap / robots.
- first-party analytics binding.

### WMS / 3PL
- Address storage.
- Zones/locations.
- Put-away.
- Pick / pack / ship.
- Cycle count.
- Replenishment.
- Waves / cluster.
- Scanner/PWA.
- Labor metrics.
- Slotting recommendations.
- Inventory owner dimension.
- 3PL contracts.
- Owner-aware stock and movement.
- 3PL billing.
- Client portal.
- Claims/requests.
- ASN / dock appointments.
- Finance handoff.

### Finance / Accounting RU
- Finance Lite.
- Cash forecast.
- Budget plan/fact.
- Bank staging/reconciliation.
- Accounting chart and posting rules.
- Double-entry journal.
- Accounting periods and locks.
- VAT documents/register/periods.
- Month-close checklist/gates.
- Payroll accrual staging/export previews.
- Client-facing Accounting workspace added on 2026-10-10.

## Доработано 2026-10-10

### P0 — crash-safe customer creation
Проблема: при падении процесса между созданием Party и фиксацией результата checkout/form повтор мог создать второго клиента.

Исправлено:
- migration `136_party_create_idempotency.sql`;
- Party.create получил optional idempotency key;
- advisory transaction lock;
- immutable input fingerprint;
- storefront использует `storefront-party:<cart_id>`;
- public forms используют `site-submission-party:<submission_id>`;
- несовместимый повтор возвращает conflict вместо изменения смысла операции.

### Sprint 72 — noisy-neighbor protection
Добавлено:
- migration `137_runtime_pressure_leases.sql`;
- tenant/member concurrency leases;
- TTL cleanup;
- marketplace sync queue limits;
- marketing sync queue limits;
- export budget;
- global search concurrency budget;
- owner-assistant concurrency budget;
- retry guidance;
- active lease diagnostics;
- Runtime Pressure page added to navigation.

### Release source gate
`scripts/stability-source-preflight.mjs` теперь блокирует release-source gate, если исчезли:
- Party idempotency hardening;
- storefront/form idempotency wiring;
- runtime search/assistant/export guards;
- migrations 136–137.

## Что ещё НЕ считается завершённым

### Release blockers
1. Полный replay всех миграций на чистой одноразовой PostgreSQL.
2. Replay на базе, имитирующей upgrade существующего окружения.
3. `pnpm install --frozen-lockfile`.
4. `pnpm typecheck`.
5. `pnpm test`.
6. `pnpm build`.
7. Cross-tenant API verification через least-privilege runtime DB role.
8. Concurrent checkout/form/order/payment/inventory tests.
9. Golden browser journeys по TRADE / ECOMMERCE / SERVICE / WAREHOUSE_3PL.
10. Finance / Accounting / WMS reconciliation.
11. Backup + restore drill.
12. Load baseline.
13. Проверка бухгалтерской/налоговой логики квалифицированным специалистом по РФ.

### Функциональные направления после пилота
- полноценный кадровый контур и расчёт НДФЛ/взносов;
- регламентированная отчётность РФ;
- ЭДО/операторы ЭДО;
- 54-ФЗ / кассы / POS;
- маркировка / Честный Знак;
- производство / MRP;
- расширенные enterprise-интеграции;
- AI execution agents только после отдельного permission/sandbox gate.

## Текущий этап

**Sprint 73 — Production Release Candidate Hardening.**

Новые крупные модули до закрытия release gates не являются приоритетом. Приоритет — доказать, что уже реализованный продукт:
- не теряет и не дублирует деньги/заказы/остатки;
- не допускает cross-tenant доступ;
- восстанавливается из backup;
- выдерживает конкурентную работу;
- понятен пользователю без программиста;
- стабильно проходит основные бизнес-сценарии.
