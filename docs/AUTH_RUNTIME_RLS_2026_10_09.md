# CoreBiz auth/RLS release gate — 2026-10-09

Status: code and migration committed, NOT deployed or independently DB-tested.

## Fixed in source
- Pre-login identity and session resolution use five tightly scoped SECURITY DEFINER functions in migration 119. No application request tenant ID is needed for these *specific* lookups.
- New-tenant registration and authenticated tenant creation set transaction-local app.tenant_id **before** inserting membership/audit data.
- Login sets the same context before writing audit_event.
- Tenant switch confirms session owner, unrevoked/unexpired session, active membership and tenant.
- Invitation acceptance locks and consumes the token in one transaction and checks the invitation email against the **actual** active app_user, not a user-submitted email.
- Functions are inaccessible to PUBLIC. Optional GRANT for role corebiz_app is issued only if that role exists when migration 119 runs.

## Mandatory staging acceptance before a production deploy
1. First resolve historical duplicate migration ordinals and confirm checksums/filenames for all databases. Never rename already-applied migration files arbitrarily.
2. Provision a dedicated non-owner, NOSUPERUSER, NOBYPASSRLS runtime DB role before migrations. Install privileges by explicit, reviewed grants. Check EXECUTE for the five auth functions. Do not grant BYPASSRLS to repair logins.
3. Replay migrations 001–119 on a disposable PostgreSQL database; confirm their owner and runtime grants; run login, register, session resume, tenant creation, tenant switch, invitation accept, logout, and invalid token scenarios against the **runtime** SQL role.
4. Assert tenant A cannot select/insert/update tenant B objects via the API under actual sessions. Confirm RLS still protects every tenant-owned table and that only the reviewed SECURITY DEFINER functions run with owner privileges.
5. Test repeated invitation acceptance, concurrent tenant creation, revoked session access and expired login, then restore test backup.
6. Reconcile role grants in any existing environment that created corebiz_app after migration 119. Default PUBLIC EXECUTE must remain revoked.

## Remaining limitations
- This is a source-level security fix, not a DB penetration test.
- Do not grant arbitrary roles EXECUTE on these functions. Protect the runtime DB account and parameterize all queries; the application-role database credentials are security-sensitive.
- User password reset and email verification workflows, permissions hardening of non-auth modules, schema replay, production DNS/HTTPS/browser E2E and accounting/payroll certification are **not completed** by this change.
