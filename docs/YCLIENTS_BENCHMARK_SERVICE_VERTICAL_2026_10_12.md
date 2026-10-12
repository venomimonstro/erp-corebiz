# CoreBiz × YCLIENTS: product benchmark and implementation plan

Дата аудита: 2026-10-12. Ветка: main. Только source/API/documentation review; running production system and partner sandbox unavailable. This is a specification, **not implementation claim** and **not GO approval**.

## Официальные источники YCLIENTS (проверка актуальности октябрь 2026)

1. https://support.yclients.ru/170 — пути онлайн-записи, выбор специалиста/времени, отмена/перенос, дизайн виджета.
2. https://support.yclients.ru/5-8-241 — назначение услуг сотруднику, свои цены и длительность.
3. https://support.yclients.ru/783 — составные услуги, одновременное/последовательное выполнение (4 руки).
4. https://support.yclients.ru/5-8-602--grafik-raboty/ — шаблоны смен, перерывы, массовая настройка расписания.
5. https://support.yclients.ru/5-11-321--tehnologicheskie-karty/ — автоматическое списание расходников по техкартам.
6. https://support.yclients.ru/5-18-992--sozdanie-novogo-pravila-rascheta/ — оклад, комиссия за услуги/товары, вознаграждение администратору; расчёт только по бизнес-событиям.
7. https://support.yclients.ru/5-31-146--vnedrenie-abonementy-sertifikaty-i-scheta-klienta-depozity-vidzhet-onlajn-prodazhi/ — абонементы, сертификаты, депозиты.
8. https://support.yclients.ru/993 — event-driven webhooks для визитов, товаров, клиентов, финансов.
9. https://support.yclients.ru/386 — возвратность клиентов/специалистов.
10. https://support.yclients.ru/119 — сетевые и накопительные скидки/лояльность.
11. https://support.yclients.ru/45-808--konstruktor-otchetov/ — загрузка, возвращаемость, финансовые показатели.
12. https://support.yclients.ru/193 — личный кабинет клиента с собственными записями, остатками абонемента, оплатой.

## 1. Проверенные возможности CoreBiz: НЕ переписывать

- `BookingService`: `createBooking`, `availability`, `reschedule`, `setStatus`,
  resource locks, idempotency, cancellation, waitlist, `COMPLETED` settlement.
- `BookingService.createDeliveryRule`: уже есть employee-resource/branch,
  individual/group, priceMin/priceMax, duration, periods and tech card.
  **Не создавать дублирующую таблицу employee_service_price**.
- `ResourcesService`: staff/resources, skills, schedule windows,
  capacity, location/zones, blocked time.
- `BookingService`: технологические карты, автоматическое списание
  расходников, пакетные посещения.
- `ServiceEconomicsService`: фиксированное/почасовое/процентное
  вознаграждение, привязка к услугам, себестоимость, retention alerts.
- `PayrollService`: партии, строки начислений, approval, payment preview.
- `site-forms`: публичные формы `BOOKING`, `DANCE_BOOKING`, CRM_LEAD
  с availability и server-side антиабьюз/идемпотентностью.
- `dance-studio`: направления, группы, учащиеся, абонементы,
  тренеры, залы, зарплаты, вместимость, кассовая логика.
- `Finance/Accounting`, tenant RBAC, WMS/OMS, marketplaces and stores:
  конкурентное преимущество относительно сервисной CRM.

Эти пункты означают **наличие исходников**, не прохождение
живого business E2E. Не подменять проверку production-readiness статическим
поиском кода.

## 2. Существенные пробелы и UX-фрагментация

| Приоритет | Сфера | CoreBiz сейчас | Что должно появиться |
|---|---|---|---|
| P0 | Первичная настройка услуг | Разделы услуги/сотрудники/правила/склад разнесены | Один wizard «ниша → услуги → сотрудники → цена/длительность → смены → виджет → тестовая запись» |
| P0 | Журнал записей | Период, список/календарь и формы уже есть; отдельные `window.prompt` используются в сервисном UI | Day/week drag-drop grid сотрудники×время, side-panel визита, keyboard/mobile; сервер определяет доступность |
| P0 | Публичный booking UX | `site-forms` связывает форму с фиксированным serviceId и набором resources | Клиент выбирает из активных услуг, филиалов, специалиста/«любой», слота; временный hold с TTL и подтверждением, без двойной записи |
| P0 | Единый визит | Backend связывает бронирование, расход, финансы и ЗП, но навигация разбросана | One Visit Workspace: услуги, специалисты, ресурсы, клиент, абонемент, расходники, касса/чек, начисления, история действий |
| P0 | Платёж услуги | Finance/внешние провайдеры присутствуют, но непрерывный sandbox E2E не подтверждён | Депозит/частичная предоплата/доплата, фискальные признаки, refund, reconcile и `UNKNOWN`; никогда не маркировать визит оплаченным от UI |
| P1 | Комплексные услуги | Несколько ресурсов на одной записи поддерживаются | Composite visit line items: последовательно и одновременно, общий price snapshot, раздельная зарплата/расход, минимизация окон |
| P1 | ЛК клиента | Полноценная self-service панель повторного визита/оплаты/абонемента не подтверждена | Отдельный защищённый customer portal + OTP, consent, cancel/reschedule policy, balances/read-only receipt links |
| P1 | Уведомления | Internal notifications и outbox; внешние каскады SMS/email/мессенджер для посещений не обнаружены в просмотренных модулях | Opt-in reminders -24h/-2h, confirmation/no-show/feedback, rate limits, quiet hours, delivery status and failover |
| P1 | Лояльность | Пакеты/абонементы есть; полноценная ledger-based межфилиальная бонусная схема не обнаружена | Ledger начислений/списаний/сгорания/возврата, сертификаты и депозиты, антифрод, tenant/branch scope |
| P1 | Аналитика | Revenue/cost/margin/retentionAlerts есть | Возвратность cohort, RFM, occupancy on AVAILABLE capacity, no-show, utilization, source CAC/LTV, employee net contribution |
| P1 | Сеть филиалов | Филиалы/RBAC/ресурсы существуют в tenant | Shared customer within tenant, изолированные кассы и себестоимость филиалов, настройки лояльности на сеть/филиал, transfer booking between locations |
| P1 | Миграция из YCLIENTS | Generic CSV import есть; точный YCLIENTS mapping не проверен | Приём Excel/API export с dry-run, dedupe клиентов, service↔staff assignment, bookings, packages, balances, reversible import |
| P2 | Экосистема | Provider connector abstraction существует | Official integrations only where provider terms/API allow: Яндекс Карты/2ГИС/VK, calendar, telephony, POS; audit token scopes |
| P2 | AI помощник | В продукте есть пользовательские workflow-сценарии | Optional explainable recommendations: пустые окна, low margin services, риск оттока; без автономных финансовых действий |

Критерий «как YCLIENTS» — полная **сквозная операция владельца**, а не число
страниц меню. Не строить аналоги бонусов/касс/записи как несвязанные CRUD.

## 3. Domain boundaries

Use existing `service_booking` as Visit aggregate ID; introduce
versioned `service_visit_line` and `visit_payment_allocation` only
after reviewing current package/charge/finance tables. Do not duplicate
payroll accounts, `service_delivery_rule` or `inventory_transaction`.

Invariants:
- tenant+branch-resource membership and tenant RLS on every query;
- calendar holds expire; confirmed booking is atomic with capacity claim;
- multi-service visit prices/durations snapshotted; no mutable history;
- one visit completion: material posting, earned compensation, package
  settlement, attribution are one idempotent, recoverable business operation;
- payment success is only by authenticated provider fetch and ledger posting,
  never by frontend/webhook alone;
- reschedule/cancel under payment/package hold policy; refunds separate;
- external notifications are transactional outbox, retry+dedupe, opt-in
  and GDPR/152-FZ obligations;
- no cross-branch customer PII leakage outside granted scope;
- read-only reports distinguish bookings, visits, earned accrual, cash and
  net profit. A no-show is NOT a completed revenue-producing visit.

## 4. Design / UX target

**Для владельца:** в первый день <10 минут до первой тестовой записи,
чёткое GO/NO-GO по 7 шагам, автоматическое создание шаблонов графика
и примера услуги *только по подтверждению*, без демо-данных в реальных
финансовых отчётах.

**Для администратора:** журнал календаря открывается первым экраном,
поиск клиента/телефона в одной строке, новая запись максимум 3 действия,
отмена/перенос одной боковой карточкой без JS prompt; безотказные loading,
empty, error и conflict состояния.

**Для сотрудника:** только свой день, свой клиент, допустимые действия
по attendance/материалам/ЗП; мобильные 360–390px без скрытых кнопок.

**Для клиента:** выбор услуги/«любой мастер»/время без регистрации,
после подтверждения — личный кабинет для переноса, предоплаты,
баланса пакета и чеков. Данные посетителей не смешивать по телефону.

## 5. Предлагаемая последовательность разработки

### S1 — Owner onboarding & booking UX (P0)
- Довести один wizard до первого клиента, тарифов и календаря.
- На основании существующих `service_delivery_rule` и `service_resource`
  показывать реальные слоты. Предупреждать, если услуга не привязана
  ни к одному мастеру или у мастера нет смен.
- Реальный browser E2E: new tenant→2 services→2 staff→schedule→first booking.

**Exit:** 0 ручных SQL; 0 JS prompts; каждая строка setup — с проверяемым
состоянием.

### S2 — Public booking & appointment console (P0)
- One embed with categories, service+staff+slot, hold with TTL,
  confirm, consent and spam throttling, customer confirmation.
- Calendar drag/drop with optimistic UI but server-authoritative version
  and conflict rollback.

**Exit:** two clients race for last slot, one wins, other gets conflict
and new suggestions; lost HTTP response repeats idempotently.

### S3 — Visit operation & fiscal loop (P0)
- Visit aggregate side panel, multi-service price snapshot, POS intent,
  receipt and accounting lifecycle, material and payroll integration.
- Exactly-once effects per visit; separate refunds, returns and voids.

**Exit:** completed paid visit posts material/cost/payroll exactly once;
failed payment never posts paid status.

### S4 — Loyalty/customer portal/messaging (P1)
- Consistent loyalty ledger, gift certificate and deposit product;
  OTP customer portal; reminders with status/quiet hours and consent.
- Migrate YCLIENTS customers/services/resources/packages with staged
  import and preview; do not transfer secrets.

**Exit:** package used once; overlapping cancel/refund cannot double
credit, global unsubscribe enforced.

### S5 — Owner economics, network & reliability (P1)
- Cohort retention, staff utilization, cash-vs-accrual dashboards;
  branch economics & shared memberships; provenance and exports.
- 100-concurrent bookings and 1000 session read tests on staging,
  p95/p99, SLO 99.9%, disaster restore drill.

**Exit:** independent real 30-day SLI, explicit evidence manifest,
no `UNKNOWN` payment/carrier reconciliation and no cross-tenant leakage.

## 6. QA acceptance before commercial GO

- Unit: DST (Europe/Moscow/Amsterdam), split-shift, break/holiday,
  overlap boundaries, booking 4 hands, capacity, discounts.
- Integration: SQL FOR UPDATE cross-resource race; RLS; idempotency
  under network timeout; payroll recomputation, VAT receipt amendments.
- Browser: 390/768/1440 screens, owner/admin/employee/customer personas,
  keyboard, offline/reconnect and slow mobile.
- Sandbox: YooKassa/ATOL/terminal with direct verified status; SMS/email
  actual provider delivery or test adapter; opt-in and bounce handling.
- Accessibility: contrast, ARIA, keyboard drag alternatives.
- Ops: release gates, backup restore, rollback, business SLI alerts,
  no unverified promises of 99.9% availability.

**Recommendation:** Optimize service vertical around booking→visit→money,
not as a new disconnected monolith. This preserves ERP strength
and lets small service businesses fully operate without YCLIENTS.

## 7. Status

Current implementation: present/partial evidence above **only**.
New S1–S5 roadmap authored, not executed or production-tested.
