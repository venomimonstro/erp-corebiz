# CoreBiz production auth readiness controls — 2026-10-09

The API readiness check now also rejects runtime DB credentials that cannot execute
the five tightly scoped authentication functions introduced by migration 119.
Without these permissions, a database may be reachable and RLS enabled yet users
cannot sign in, restore a session, switch companies, or accept invitations.

**Production only**: `/api/v1/health/ready` must be 200 with `data.isolation.ok=true`.
503 is a blocker; do not bypass by using owner/superuser/BYPASSRLS.

Deployment sequence: ensure privileges in a disposable staging DB; reconcile
historical migrations; run API integration test with a least-privilege role;
inspect EXPLAIN/DB policies; then manually authorize a production migration.

This is a necessary readiness check, not proof of cross-tenant isolation.
