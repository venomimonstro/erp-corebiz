# Текущий этап разработки

## Статус

**R0 — Foundation**  
**Активно:** Sprint 0 → Sprint 1.

## Sprint 0 — Engineering Foundation

### Уже создано
- pnpm monorepo;
- `apps/api` NestJS;
- `apps/web` Next.js;
- `apps/worker`;
- shared contracts;
- public landing shell;
- Owner Workspace shell;
- API `/api/v1/health`;
- AsyncLocalStorage TenantContext foundation;
- PostgreSQL + Redis local compose;
- initial tenant/user/membership/session/audit SQL;
- RLS policies foundation;
- architecture/security/product/roadmap docs;
- ADR-001..004.

### Осталось до Sprint 0 Gate
- package installation lockfile;
- validate full build/typecheck;
- environment loader/validation;
- database adapter/migration runner;
- structured logging + trace id;
- common API error envelope;
- test harness;
- one-command local bootstrap;
- architecture boundary test foundation.

## Sprint 0 Gate

Sprint 0 считается завершённым, когда:
1. `pnpm install` воспроизводим;
2. `pnpm build` проходит;
3. `pnpm typecheck` проходит;
4. Postgres/Redis стартуют одной командой;
5. API health работает;
6. web public/app shells открываются;
7. migration runner применяет DB schema;
8. environment validation fail-fast;
9. README описывает запуск.

## Sprint 1 — Identity / Tenant / Membership

### Scope
- User repository/service;
- Tenant repository/service;
- TenantMembership;
- create tenant;
- invite membership foundation;
- signup/login/logout;
- email verification model;
- password reset model;
- secure session;
- tenant switching;
- request authentication guard;
- request TenantContext binding.

### Security requirements
- Argon2id password hashes;
- session secret never stored plaintext in DB;
- HttpOnly/Secure cookie in production;
- CSRF strategy;
- session revocation;
- login rate limit;
- generic auth error messages;
- audit events.

## Sprint 1 Gate

1. User can register.
2. User can create first Tenant.
3. Owner membership created atomically.
4. One User can belong to multiple Tenants.
5. Switching Tenant changes server-side TenantContext.
6. Request cannot forge `tenant_id`.
7. Logout revokes session.
8. Suspended membership cannot enter tenant.
9. auth/tenant tests pass.

## Следующий этап

Только после Sprint 1/2 security gates начинается Organization/Party и CRM.
