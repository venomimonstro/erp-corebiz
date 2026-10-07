# BUSINESS OS — MASTER SPEC

**Статус:** FROZEN BASELINE  
**Назначение:** единый Source of Truth для владельца, инвесторов, продукта, UX и разработки.

## 1. Продукт

Business OS — multi-tenant SaaS для микро-, малого и среднего бизнеса, который объединяет полный денежный и операционный цикл:

```
Маркетинг → Лид → Сделка → Заказ/Запись → Оплата
→ Закупка/Исполнение → Склад → Себестоимость
→ Финансы → Бухгалтерия → Прибыль → Аналитика
```

Ключевое обещание:

> Начните с простой системы. Включайте новые возможности по мере роста. Не меняйте платформу и не переписывайте Core.

## 2. Почему клиент переходит

### С МоегоСклада
- более сильная CRM и задачи;
- роль-ориентированные workspaces;
- сквозная экономика до прибыли;
- service/scheduling сценарии;
- безопасное расширение до OMS/WMS/Accounting;
- единый продукт вместо набора допсервисов.

### С amoCRM
- после `Deal Won` работа не заканчивается;
- сделка превращается в SalesOrder;
- Order связан с оплатой, резервом, закупкой, отгрузкой и прибылью.

### С YCLIENTS
- сохраняем сильную модель календаря/записи;
- Resource/Scheduling Engine универсален и не зашит в beauty;
- поддерживает салон, автосервис, клинику, аренду, студию, фитнес.

### С 1С
- не обещаем мгновенно заменить всё;
- сначала operational contour + интеграция с 1С;
- затем параллельная бухгалтерия и reconciliation;
- только после подтверждения периодов возможен cutover;
- кастомизация не меняет Core и не блокирует обновления.

### С Roistat/Calltouch
- реклама связывается не только с лидом/сделкой, а с фактической оплатой, возвратами, COGS и contribution profit;
- Business OS уже владеет CRM/Sales/Inventory/Finance, поэтому меньше интеграционных разрывов.

## 3. ЦА

### Первый ICP
- 1–30 сотрудников;
- торговля/e-commerce/опт/маркетплейсы;
- Excel/CRM/склад/1С разрознены;
- нет крупной IT-команды;
- владелец хочет видеть прибыль и контроль.

### Второй ICP
- beauty;
- автосервисы;
- фитнес;
- школы/студии;
- сервисные компании;
- агентства/IT.

### Не основной стартовый сегмент
- корпорации с глубокими уникальными процессами;
- крупное производство;
- предприятия, где >20% критической логики требует собственного кода.

## 4. Product Constitution

1. Core работает до кастомизации.
2. Пользователь видит только нужные capabilities.
3. Интерфейс адаптирован под роль.
4. Core нельзя модифицировать tenant-кодом.
5. Tenant isolation имеет минимум два независимых слоя.
6. Default permission = DENY.
7. Inventory source of truth = immutable ledger.
8. Accounting source of truth = immutable double-entry ledger.
9. Статусы меняются только Domain Commands.
10. Внешняя интеграция не блокирует Core.
11. Analytics не выполняет тяжёлые операции на OLTP.
12. AI не получает прямого доступа к БД.
13. Критичная configuration: Draft → Validate → Test → Publish → Rollback.
14. Любое критичное действие имеет Audit.
15. Неописанная логика = SPEC_GAP.
16. Типовой массовый процесс нельзя превращать в платную кастомную доработку.
17. Один крупный клиент не меняет Core.
18. Производительность — acceptance criterion.
19. Пользователь должен понимать следующий шаг без обучения ERP.
20. Каждая новая функция должна экономить время, показывать деньги или снижать риск.

## 5. Пять фундаментальных движков

### Capability Engine
Определяет, какие возможности включены tenant.

Пример:
`crm`, `inventory.basic`, `scheduling`, `growth.attribution`, `accounting.ru`.

### Workspace Engine
Определяет рабочее пространство конкретной роли.

- Owner → деньги/риски/отклонения;
- Sales Manager → сделки/задачи;
- Salon Administrator → календарь;
- Warehouse → задания;
- Procurement → потребность;
- Finance → cash/debts;
- Accountant → первичка/закрытие.

### Resource & Scheduling Engine
Универсальные сущности:
- Resource;
- Service;
- Schedule;
- Availability;
- Booking;
- ResourceReservation.

Resource может быть сотрудником, кабинетом, подъёмником, залом, автомобилем или оборудованием.

### Profitability Spine
Связывает:
`Source/Campaign → Lead → Party → Deal → Order/Booking → Payment → COGS → Costs → Profit`.

### Action & Exception Engine
Преобразует данные в управленческие действия:
- просроченная дебиторка;
- сделка без next action;
- stockout risk;
- заказ без резерва;
- реклама без продаж;
- ошибка интеграции;
- период бухгалтерии не закрывается.

## 6. Три интерфейсных контура

### Public
`/`, `/features`, `/solutions/*`, `/pricing`, `/migration`, `/security`, `/docs`, `/status`, `/login`, `/signup`.

### Client App
`/app`.

### Platform Admin
`/admin`, полностью отделён от tenant workspace.

## 7. Первый коммерческий контур

- Tenant/Users/Roles
- Organization/Party
- CRM + Deals + Tasks + Kanban
- Catalog
- Sales Orders
- Procurement
- Inventory Ledger/Reservations
- Finance Lite
- Documents/PDF
- Returns/Refunds
- Dashboard/Action Queue
- Onboarding/Migration
- Billing
- Ticket System/Knowledge Base
- Custom Fields/Saved Views
- Automation V1
- Audit/Security/Monitoring

## 8. CRM

### Deal Pipeline
Системные финалы: `WON`, `LOST`.  
Рабочие stages tenant настраивает.

Drag-and-drop вызывает `MoveDealCommand`, который:
1. проверяет permission;
2. проверяет optimistic version;
3. валидирует required fields;
4. меняет stage;
5. пишет audit/event;
6. запускает automation;
7. возвращает новое состояние.

### Deal Card
- name;
- amount;
- party;
- responsible;
- stage;
- source;
- expected close;
- custom fields;
- activity timeline;
- next action.

Открытая сделка без незавершённой задачи получает warning `NO_NEXT_ACTION`.

### Deal → Order
Одна сделка может создать `0..N SalesOrder`.
Conversion idempotent. Повторное действие не создаёт дубль.

## 9. Tasks

Core states:
- OPEN
- IN_PROGRESS
- WAITING
- DONE
- CANCELLED

`Сегодня` и `Просрочено` — фильтры, а не состояния.

Task может быть связан с:
- Deal;
- Party;
- SalesOrder;
- PurchaseOrder;
- Ticket;
- позже Booking.

## 10. Sales

Не смешивать три состояния.

### OrderStatus
- DRAFT
- CONFIRMED
- COMPLETED
- CANCELLED

### PaymentStatus
- UNPAID
- PARTIALLY_PAID
- PAID
- PARTIALLY_REFUNDED
- REFUNDED

### FulfillmentStatus
- UNALLOCATED
- PARTIALLY_RESERVED
- RESERVED
- READY
- PARTIALLY_SHIPPED
- SHIPPED
- CANCELLED

Они развиваются независимо.

## 11. Returns

Минимальная модель:
`REQUESTED → RECEIVED → INSPECTED → APPROVED/REJECTED → COMPLETED`.

Disposition:
- RESTOCK;
- WRITE_OFF;
- REPAIR;
- RETURN_TO_SUPPLIER.

Refund — отдельная финансовая операция и меняет PaymentStatus.

## 12. Procurement

PurchaseOrder:
- DRAFT
- CONFIRMED
- PARTIALLY_RECEIVED
- RECEIVED
- CANCELLED

Receipt фиксирует фактическое количество. Расхождение не переписывает заказ поставщику молча.

## 13. Inventory

Source of Truth = `InventoryTransaction`.

Типы:
- RECEIPT
- SHIPMENT
- TRANSFER
- RETURN
- ADJUSTMENT
- DAMAGE
- WRITE_OFF

Проекция `InventoryBalance`:
- physical;
- reserved;
- available.

MVP:
`available = physical - reserved`.

Reservation должна быть атомарной и защищённой от race condition.

## 14. Finance Lite

Не бухгалтерия.

- CashAccount;
- Payment;
- Receivable;
- Payable;
- Income/Expense Category.

Дебиторка формируется на основании подтверждённого обязательства, определённого Sales policy (Order/Invoice). Это правило должно быть единообразно для tenant.

## 15. Бухгалтерия РФ

Отдельный bounded context. Подробно: `docs/domains/ACCOUNTING_RU.md`.

AI не определяет проводки.  
BusinessEvent → PostingRule(versioned) → AccountingEntry.

## 16. Growth / сквозная аналитика

Подробно: `docs/domains/GROWTH_ANALYTICS.md`.

Главный цикл:
`Ad Spend → Visit → Lead → Deal → Order → Payment → Revenue → COGS → Profit`.

## 17. Кастомизация

### Разрешено tenant
- custom fields;
- forms;
- saved views;
- pipelines/stages;
- task types;
- notifications;
- roles/scopes;
- workflows;
- pricing rules;
- dashboards.

### Запрещено
- raw SQL;
- tenant code inside Core;
- изменение accounting/inventory ledgers;
- изменение security semantics;
- собственные системные permissions;
- произвольные Order/Payment/Fulfillment core states.

## 18. Поддержка

Self-service funnel:
`UI explanation → Context Help → Knowledge Base → AI Support → Ticket → Human`.

Ticket states:
- NEW
- IN_PROGRESS
- WAITING_CUSTOMER
- WAITING_ENGINEERING
- SOLVED
- CLOSED

## 19. Безопасность

Подробно: `docs/SECURITY.md`.

Минимум:
- application tenant context;
- PostgreSQL RLS;
- RBAC + ABAC;
- audit;
- MFA для чувствительных ролей;
- step-up auth;
- idempotency;
- rate limits;
- secrets management;
- restore-tested backups.

## 20. Definition of Done

Любая функция:
```
Business Rule
+ Domain Owner
+ Permission
+ Tenant Isolation
+ Validation
+ State transitions
+ API
+ UI states
+ Audit
+ Errors
+ Tests
+ Metrics
+ Documentation
```

## 21. SPEC_GAP

Если specification не отвечает на бизнес-вопрос, реализация останавливается в этой точке и создаётся `SPEC_GAP`. Нельзя “сделать разумно на своё усмотрение”.

