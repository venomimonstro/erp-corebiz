# ADR-002 — Tenant Isolation

**Status:** Accepted

## Decision

Каждый tenant-owned объект защищён минимум двумя слоями:

1. application authorization через server-side TenantContext;
2. PostgreSQL Row Level Security.

`tenant_id` из request body/query не является источником авторизации.

## Database

Приложение должно устанавливать `SET LOCAL app.tenant_id = '<uuid>'` внутри транзакции до tenant queries.

Production DB role:
- не owner таблиц;
- не имеет BYPASSRLS.

## Testing

Для каждого tenant-owned endpoint:
- Tenant A создаёт объект;
- Tenant B пробует read/update/delete/search/export;
- никакие данные A не раскрываются.

Cross-tenant failure = P0/release blocker.
