# BUSINESS OS / CoreBiz

Единая SaaS-платформа для микро-, малого и среднего бизнеса: CRM, задачи, продажи, закупки, склад, финансы, бухгалтерия РФ, сквозная аналитика, сервисные сценарии, OMS/WMS и дальнейшие модули без изменения Core.

## Статус

- Репозиторий инициализирован.
- Source of Truth: `docs/MASTER_SPEC.md`.
- Текущий этап: **аудит и стабилизация основного контура после спринтов 54–62**. Основа этих спринтов есть в коде, но production-приёмка не пройдена.
- Актуальный аудит: [Стабильность, безопасность, UX и сравнение с МойСклад](docs/AUDIT_PRODUCT_SECURITY_UX_MOYSKLAD_2026_10_08.md).
- Перечень открытых release-блокеров: [Sprints 54–60](docs/SPRINTS_54_TO_60_IMPLEMENTATION_STATUS.md).
- Первый коммерческий контур: **ERP Core + CRM + Tasks + Catalog + Sales + Procurement + Inventory + Finance Lite + Billing + Support**.

## Главный принцип

> Пользователь видит свой бизнес, а не устройство ERP.

Business OS должна:
- запускаться без программиста;
- адаптировать интерфейс под отрасль и роль;
- сохранять единый обновляемый SaaS Core;
- показывать владельцу, где деньги и где проблема;
- показывать сотруднику следующее действие;
- не требовать миграции на другой продукт при росте компании.

## Документация

- [MASTER SPEC](docs/MASTER_SPEC.md)
- [Архитектура](docs/ARCHITECTURE.md)
- [Продукт и UX](docs/PRODUCT_UX.md)
- [Roadmap и спринты](docs/ROADMAP.md)
- [Бухгалтерия РФ](docs/domains/ACCOUNTING_RU.md)
- [Сквозная аналитика / Growth](docs/domains/GROWTH_ANALYTICS.md)
- [Безопасность](docs/SECURITY.md)
- [Правила для AI-разработчика](docs/AI_DEVELOPMENT_RULES.md)

## План первой разработки

1. Sprint 0 — monorepo, стандарты, окружения, Design System, архитектурные границы.
2. Sprint 1 — Tenant, User, TenantMembership, auth/session.
3. Sprint 2 — RLS, RBAC/ABAC, Audit.
4. Sprint 3 — Organization + Party.
5. Sprint 4–6 — CRM + Kanban + Tasks.
6. Sprint 7–12 — Catalog, Sales, Procurement, Inventory, Finance Lite, Dashboard.
7. Sprint 13–18 — onboarding, migration, billing, tickets, customization, automation, production hardening.

## Технологический baseline

- Frontend: TypeScript, React, Next.js
- Backend: TypeScript, NestJS
- DB: PostgreSQL
- Cache/locks: Redis
- Files: S3-compatible storage
- Queue: adapter-based worker queue
- Analytics later: ClickHouse
- Search later: OpenSearch
- AI/ML later: Python services only where justified

## Правило разработки

Если бизнес-логика не описана в спецификации — это **SPEC_GAP**. Разработчик или AI не имеет права самостоятельно придумывать новую сущность, статус, permission, переход или финансовую логику.

