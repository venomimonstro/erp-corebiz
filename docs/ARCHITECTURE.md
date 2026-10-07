# Архитектура Business OS

## 1. Стартовая модель

**Modular Monolith** с жёсткими bounded contexts.

Причины:
- одна транзакционная граница;
- меньше DevOps;
- проще локальная разработка;
- меньше сетевых failure modes;
- дешевле эксплуатация;
- проще соло-разработка;
- возможность выделения сервисов позже.

## 2. Контуры

```
apps/
  web/          # public + client app
  api/          # NestJS modular monolith
  worker/       # background jobs

packages/
  ui/
  contracts/
  config/
  security/
  observability/
  testing/
```

## 3. Backend modules

```
platform/
  identity
  tenant
  subscription
  entitlements
  audit
  notifications
  tickets
  files

business/
  organization
  party
  crm
  tasks
  catalog
  pricing
  sales
  procurement
  inventory
  scheduling
  finance
  accounting
  growth

services/
  import
  search
  integrations
  workflow
  reporting
```

## 4. Правило владения данными

Каждый bounded context:
- владеет своими таблицами;
- экспортирует application services/contracts;
- не даёт другим модулям прямой write-доступ;
- не импортирует private repository другого домена.

Cross-domain mutation — только через public command/service.

## 5. Multi-tenancy

Tenant-owned таблицы содержат `tenant_id`.

Запрос получает server-side `TenantContext` из authenticated session.

Frontend `tenant_id` не является security input.

Защита:
1. application authorization;
2. PostgreSQL RLS;
3. automated cross-tenant tests.

Пользователь отделён от membership:

```
User
  1
  |
  N
TenantMembership
  N
  |
  1
Tenant
```

Один User может состоять в нескольких Tenant.

## 6. Events

Transactional Outbox обязателен для domain events.

Пример:
- `crm.deal_stage_changed.v1`
- `sales.order_confirmed.v1`
- `inventory.reservation_created.v1`
- `finance.payment_received.v1`

State + OutboxEvent сохраняются одной DB transaction.

## 7. Idempotency

Обязательно для:
- создания заказов из интеграций;
- оплаты;
- webhook;
- import;
- WMS scan;
- Deal→Order conversion.

## 8. Согласованность

Strong consistency:
- tenant/security;
- reserve stock;
- ledger transaction;
- accounting posting.

Eventual consistency:
- search;
- analytics;
- dashboards;
- notifications;
- external integrations.

## 9. Данные

- PostgreSQL — transactional source of truth.
- Redis — cache/locks/ephemeral state.
- S3-compatible — files.
- Queue adapter — jobs/events.
- OpenSearch — только после performance threshold.
- ClickHouse — analytical plane после Growth/scale.

## 10. OLTP vs Analytics

Тяжёлые маркетинговые/финансовые отчёты не выполняются на operational DB.

```
OLTP → Outbox/CDC → Analytics ingestion → ClickHouse → Semantic Metrics
```

## 11. Масштабирование tenant

Путь без изменения product code:
1. Shared DB + shared workers.
2. Shared DB + isolated worker pool.
3. Dedicated DB.
4. Dedicated DB + cluster.

Tenant Router вводится до фактического dedicated режима, но реальная сегрегация включается по потребности.

## 12. Кандидаты на последующее выделение

Только по метрикам:
- search;
- integrations;
- analytics;
- notifications;
- AI;
- OMS orchestration;
- WMS task engine.

## 13. API

Версия: `/api/v1`.

REST для команд/CRUD.  
Events/webhooks для реактивной интеграции.

API никогда не возвращает объект только потому, что существует его ID — authorization выполняется по tenant + user + scope.

## 14. Деньги

Не использовать float.

Money:
- amount_minor integer или NUMERIC фиксированной precision;
- currency обязательна.

## 15. Время

DB timestamps = UTC.  
Tenant/User timezone применяется на presentation/application layer.  
Accounting BusinessDate хранится отдельно, где необходимо.

## 16. NFR baseline

- обычный API p95 < 500 ms;
- autocomplete/search p95 < 300 ms;
- CRM Kanban transition perceived < 300–500 ms с optimistic UI;
- WMS scan later < 200–300 ms server-side target;
- heavy operations background;
- без full page reload для обычных app transitions.

