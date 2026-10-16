import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("SaaS operator console is protected by session proof in DB", () => {
  const sql = read("infrastructure/postgres/253_platform_operator_readonly.sql");
  const service = read("apps/api/src/modules/platform/platform-operations/platform-operations.service.ts");
  assert.match(sql,/s\.session_hash=p_session_hash/);
  assert.match(sql,/s\.revoked_at IS NULL/);
  assert.match(sql,/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
  assert.match(service,/hashToken\(rawSession\)/);
  assert.doesNotMatch(service,/SELECT \* FROM tenant/);
});

test("password recovery never stores plaintext tokens and revokes sessions", () => {
  const source = read("apps/api/src/modules/platform/auth/auth.service.ts");
  assert.match(source,/INSERT INTO password_reset_token\(user_id,token_hash,expires_at\)/);
  assert.match(source,/\[row\.id,hashToken\(token\)\]/);
  assert.match(source,/FOR UPDATE OF t/);
  assert.match(source,/UPDATE user_session SET revoked_at=now\(\)/);
  assert.match(source,/password_reset_token[\s\S]*consumed_at=now\(\)/);
});

test("support closure records reason for customer and audit", () => {
  const api = read("apps/api/src/modules/business/support/support.service.ts");
  assert.match(api,/Результат обращения:/);
  assert.match(api,/support\.ticket_closed/);
  assert.match(api,/resolutionInput\.trim\(\)\.length < 10/);
});

test("subscription and export quotas are enforced by transactional locks", () => {
  const quota = read("infrastructure/postgres/252_plan_quota_serialized.sql");
  const exportSql = read("infrastructure/postgres/254_tenant_export_single_flight.sql");
  assert.match(quota,/FROM tenant_subscription[\s\S]*FOR UPDATE/);
  assert.match(quota,/PLAN_SUBSCRIPTION_MISSING/);
  assert.match(exportSql,/CREATE UNIQUE INDEX tenant_export_one_active_idx/);
  assert.match(exportSql,/status IN \('PENDING','PROCESSING'\)/);
});

test("production release gate audits subscription integrity", () => {
  const script = read("scripts/production-gate.sh");
  assert.match(script,/security_subscription_integrity_gate\.sql/);
  assert.match(script,/BILLING:SUBSCRIPTION_INTEGRITY/);
});

test("email verification is one-time and checked before SaaS payment", () => {
  const verify = read("apps/api/src/modules/platform/auth/email-verification.service.ts");
  const auth = read("apps/api/src/modules/platform/auth/auth.controller.ts");
  const pay = read("apps/api/src/modules/platform/payments/commerce-payments.service.ts");
  const sql = read("infrastructure/postgres/002_auth_sessions.sql");
  assert.match(sql,/CREATE TABLE email_verification_token/);
  assert.match(verify,/INSERT INTO email_verification_token\(user_id,token_hash,expires_at\)/);
  assert.match(verify,/hashToken\(token\)/);
  assert.match(verify,/email_verified_at=COALESCE/);
  assert.match(verify,/FOR UPDATE OF t/);
  assert.match(auth,/email-verification\/complete/);
  assert.match(pay,/email_verified_at/);
  assert.match(pay,/Перед оплатой тарифа подтвердите email/);
});

test("email and password reset use the same deadlock-safe lock order", () => {
  const verify = read("apps/api/src/modules/platform/auth/email-verification.service.ts");
  const auth = read("apps/api/src/modules/platform/auth/auth.service.ts");
  const verifyComplete = verify.slice(verify.indexOf("async complete("));
  const resetComplete = auth.slice(auth.indexOf("async completePasswordReset("),
    auth.indexOf("  async login(input: LoginInput)"));
  assert.ok(verifyComplete.indexOf("SELECT id FROM app_user") <
    verifyComplete.indexOf("FOR UPDATE OF t"));
  assert.ok(resetComplete.indexOf("SELECT id FROM app_user") <
    resetComplete.indexOf("FOR UPDATE OF t"));
  assert.ok(resetComplete.indexOf("const preflight") <
    resetComplete.indexOf("const passwordHash = await hash"));
});

test("failed exports cannot race an active export claim across workers", () => {
  const sql = read("infrastructure/postgres/255_tenant_export_claim_serialization.sql");
  assert.match(sql,/active\.status IN \('PENDING','PROCESSING'\)/);
  assert.match(sql,/FROM tenant[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(sql,/FOR UPDATE OF j SKIP LOCKED/);
});

test("read-only subscriptions preserve secure account recovery, not business writes", () => {
  const guard = read("apps/api/src/modules/platform/billing/subscription.guard.ts");
  assert.match(guard,/cleanPath === "\/api\/v1\/auth\/email-verification\/request"/);
  assert.match(guard,/cleanPath === "\/api\/v1\/auth\/password-reset\/complete"/);
  assert.match(guard,/HttpStatus\.PAYMENT_REQUIRED/);
  assert.match(guard,/path\.split\("\?"\)\[0\]/);
});
