# Security Baseline

## 1. Критический инвариант

Tenant A не получает данные Tenant B через:
- API;
- UI;
- search;
- export;
- jobs;
- websocket;
- analytics;
- AI;
- support.

## 2. Tenant isolation

Два слоя обязательны:
1. application TenantContext;
2. PostgreSQL RLS.

DB application role:
- не owner;
- без BYPASSRLS.

## 3. Authentication

- password hash: Argon2id;
- Secure HttpOnly session cookie;
- CSRF protection;
- session rotation;
- revocation;
- device/session list.

MFA mandatory for:
- platform admin;
- tenant owner/admin с чувствительными правами;
- accountant/payment-sensitive role.

## 4. Authorization

RBAC + ABAC.

Permission:
`resource.action.scope`.

Scopes:
- own;
- team;
- branch;
- all.

Sensitive capabilities separately:
- cost.read;
- margin.read;
- finance.read;
- export;
- billing;
- roles.manage;
- period.reopen.

## 5. Step-up auth

Требовать re-auth/MFA для:
- банковских реквизитов;
- admin grants;
- mass export;
- accounting period reopen;
- tenant deletion;
- platform break-glass.

## 6. Audit

Минимум:
- login/fail;
- user/role changes;
- deal stage;
- order confirm/cancel;
- payment/refund;
- inventory movements;
- accounting posting/reversal;
- export;
- support access;
- billing change;
- security settings.

## 7. Support access

Никакого постоянного скрытого доступа к tenant business data.

Tenant grants temporary support access:
- 1h / 24h / 3d;
- read-only default.

Break-glass:
- специальная role;
- MFA;
- reason;
- immutable audit;
- notification security admins.

## 8. Mass assignment

DTO whitelist only.  
Запрещено сохранять request body напрямую.

## 9. Rate limits

Раздельно:
- login;
- reset;
- API;
- search;
- export;
- import;
- webhook;
- AI.

## 10. Files

- random storage key;
- server-side MIME validation;
- private bucket;
- malware scanning pipeline;
- short-lived signed download;
- permission check before URL generation.

## 11. Secrets

Никогда:
- git;
- frontend;
- plaintext logs.

Secrets manager / envelope encryption for connector credentials.

## 12. Backups

- encrypted;
- PITR;
- credentials separate;
- scheduled restore drills.

## 13. CI security gate

Любой tenant-owned endpoint тестируется:
- Tenant A creates;
- Tenant B GET/UPDATE/DELETE/SEARCH/EXPORT;
- zero cross-tenant data.

Failure = release blocker.

