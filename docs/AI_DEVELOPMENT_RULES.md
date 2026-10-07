# Правила AI-разработки

Этот файл обязателен как контекст для coding agents.

## Перед кодом

AI обязан определить:
1. requirement;
2. domain owner;
3. entity;
4. permission;
5. tenant ownership;
6. state transition;
7. event;
8. audit;
9. failure modes;
10. tests.

## Запрещено

- создавать новую domain entity без spec/ADR;
- добавлять status по своему усмотрению;
- менять core state machine напрямую;
- доверять tenant_id из request;
- обращаться к private repository другого domain;
- изменять ledger row;
- делать raw SQL из user input;
- добавлять hidden fallback, меняющий бизнес-результат;
- создавать tenant-specific fork;
- давать AI runtime direct DB credentials.

## Если спецификации недостаточно

Создать/зафиксировать:

`SPEC_GAP: <описание>`

Не импровизировать.

## Требования к изменениям

Каждая feature должна включать:
- validation;
- permission;
- audit;
- tests;
- errors;
- docs;
- metrics, если операция критична.

## Финансы/бухгалтерия

LLM не определяет:
- бухгалтерские проводки;
- налоговые формулы;
- ledger corrections.

Только deterministic versioned rules.

## Inventory

Любое изменение stock только через Inventory domain command/ledger.

## State machines

Frontend никогда не считается source of truth.

UI transition может быть optimistic, но backend command решает результат.

