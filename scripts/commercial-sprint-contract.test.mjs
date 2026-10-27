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

test("operator suspension requires real session, explanation, and records an audit", () => {
  const sql = read("infrastructure/postgres/256_platform_tenant_suspension.sql");
  const service = read("apps/api/src/modules/platform/platform-operations/platform-operations.service.ts");
  const web = read("apps/web/app/platform-operations/page.tsx");
  const controller = read("apps/api/src/modules/platform/platform-operations/platform-operations.controller.ts");
  assert.match(sql,/s\.session_hash=p_session_hash/);
  assert.match(sql,/s\.revoked_at IS NULL/);
  assert.match(sql,/p_action NOT IN \('SUSPEND','RESUME'\)/);
  assert.match(sql,/length\(btrim\(p_reason\)\) NOT BETWEEN 15 AND 800/);
  assert.match(sql,/m\.user_id=p_operator_user_id/);
  assert.match(sql,/UPDATE public\.user_session s SET revoked_at=now\(\)/);
  assert.match(sql,/INSERT INTO public\.audit_event/);
  assert.match(sql,/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
  assert.doesNotMatch(sql,/UPDATE public\.tenant_subscription/);
  assert.match(service,/hashToken\(session\)/);
  assert.match(web,/confirmation\.trim\(\)!==tenant\.companyName/);
  assert.match(controller,/@Patch\("tenants\/:id\/suspension"\)/);
});

test("operator actions do not remove read-only billing enforcement for customers", () => {
  const guard = read("apps/api/src/modules/platform/billing/subscription.guard.ts");
  const bill = read("apps/api/src/modules/platform/billing/billing.service.ts");
  assert.match(guard,/platform-operations/);
  assert.match(guard,/HttpStatus\.PAYMENT_REQUIRED/);
  assert.match(bill,/status NOT IN \('SUSPENDED','CANCELLED'\)/);
});

test("SaaS operating metrics are operator-authenticated and do not include customer PII", () => {
  const sql = read("infrastructure/postgres/257_platform_commercial_overview.sql");
  const api = read("apps/api/src/modules/platform/platform-operations/platform-operations.controller.ts");
  const web = read("apps/web/app/platform-operations/page.tsx");
  assert.match(sql,/s\.session_hash=p_session_hash/);
  assert.match(sql,/s\.revoked_at IS NULL/);
  assert.match(sql,/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
  assert.match(sql,/missingSubscription/);
  assert.match(sql,/pastDue/);
  assert.doesNotMatch(sql,/SELECT \* FROM public\.app_user/);
  assert.match(api,/@Get\("summary"\)/);
  assert.match(web,/Коммерческое состояние платформы/);
});


test("operator suspension history is scoped and session verified", () => {
  const sql = read("infrastructure/postgres/258_platform_suspension_history.sql");
  const api = read("apps/api/src/modules/platform/platform-operations/platform-operations.service.ts");
  assert.match(sql, /s\.session_hash=p_session_hash/);
  assert.match(sql, /WHERE tenant_id=p_tenant_id/);
  assert.match(sql, /LIMIT 25/);
  assert.match(api, /corebiz_platform_suspension_history/);
});

test("current paid tariff remains purchasable for trial conversion and renewal", () => {
  const web = read("apps/web/app/app/settings/billing/page.tsx");
  const pay = read("apps/api/src/modules/platform/payments/commerce-payments.service.ts");
  assert.match(web, /const requiresPayment = Number\(plan\.monthlyPriceMinor\) > 0/);
  assert.match(web, /Продлить на месяц/);
  assert.match(web, /Оплатить этот тариф/);
  assert.match(web, /Автоматических списаний пока нет/);
  assert.match(pay, /if\(!subscription\.rows\[0\]\)/);
  assert.match(pay, /current_period_end=GREATEST\(current_period_end,now\(\)\)\+interval '1 month'/);
});

test("tenant suspension and subscription lifecycle stop public traffic and external workers", () => {
  const lifecycle = read("infrastructure/postgres/259_commercial_tenant_operability.sql");
  const publicSites = read("infrastructure/postgres/260_public_site_operability.sql");
  const workers = read("infrastructure/postgres/261_worker_operability_claims.sql");
  const storefront = read("apps/api/src/modules/business/sites/storefront.service.ts");
  const forms = read("apps/api/src/modules/business/sites/site-forms.service.ts");
  const channels = read("apps/api/src/modules/business/channels/channels.service.ts");
  const release = read("scripts/production-gate.sh");

  assert.match(lifecycle,/tenant_subscription/);
  assert.match(lifecycle,/t\.status NOT IN \('SUSPENDED','CANCELLED'\)/);
  assert.match(lifecycle,/s\.status NOT IN \('SUSPENDED','CANCELLED','READ_ONLY'\)/);
  assert.match(lifecycle,/current_period_end>now\(\)/);
  assert.match(lifecycle,/grace_until>now\(\)/);
  assert.match(lifecycle,/REVOKE ALL ON FUNCTION public\.corebiz_tenant_is_operational\(uuid\) FROM PUBLIC/);

  for (const name of [
    "corebiz_public_site_page",
    "corebiz_public_site_page_by_host",
    "corebiz_public_site_routes",
    "corebiz_public_site_routes_by_host",
    "corebiz_public_site_tracker"
  ]) {
    assert.match(publicSites,new RegExp(name+"[\\s\\S]*corebiz_tenant_is_operational"));
  }

  for (const name of [
    "corebiz_claim_domain_event",
    "corebiz_claim_marketing_sync_job",
    "corebiz_claim_channel_sync_job",
    "corebiz_claim_stock_dirty",
    "corebiz_claim_stock_target",
    "corebiz_schedule_fbs_stock_poll",
    "corebiz_claim_offline_conversion_job",
    "corebiz_claim_offline_conversion_status_job"
  ]) {
    assert.match(workers,new RegExp(name+"[\\s\\S]*corebiz_tenant_is_operational"));
  }

  assert.match(storefront,/corebiz_tenant_is_operational\(r\.tenant_id\)/);
  assert.match(forms,/corebiz_tenant_is_operational\(r\.tenant_id\)/);
  assert.match(channels,/corebiz_tenant_is_operational\(r\.tenant_id\)/);
  assert.match(release,/security_tenant_operability_gate\.sql/);
});

test("channel stock hub exposes only one mappings route", () => {
  const controller = read("apps/api/src/modules/business/channels/channels.controller.ts");
  assert.equal(
    (controller.match(/@Get\("stock-hub\\/mappings"\)/g) ?? []).length,
    1
  );
  assert.equal(
    (controller.match(/async stockHubMappings\(/g) ?? []).length,
    1
  );
});

