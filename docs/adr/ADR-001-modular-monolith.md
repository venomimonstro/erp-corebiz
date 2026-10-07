# ADR-001 — Modular Monolith

**Status:** Accepted

## Context

Business OS содержит много bounded contexts, но на старте разрабатывается небольшой командой/соло и должен сохранять простую эксплуатацию.

## Decision

Стартуем modular monolith:
- один API deployable;
- одна transactional PostgreSQL;
- отдельные modules/bounded contexts;
- private repositories не пересекаются;
- cross-domain writes только через public services/commands/events.

## Why

- меньше DevOps;
- одна транзакционная граница;
- меньше сетевых отказов;
- дешевле эксплуатация;
- проще тестирование;
- границы позволяют выделять сервисы позже.

## Consequences

Запрещено использовать “монолит” как оправдание общих таблиц и хаотических импортов между модулями.
