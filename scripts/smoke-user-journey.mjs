#!/usr/bin/env node
/**
 * Disposable-environment API journey. Intentionally creates users, tenants,
 * orders and deals. NEVER run against production, even via an SSH tunnel.
 *
 * COREBIZ_CONFIRM_DISPOSABLE_DB=YES
 * COREBIZ_SMOKE_BASE_URL=http://127.0.0.1:4000
 * COREBIZ_SMOKE_WEB_ORIGIN=http://localhost:3000
 * node scripts/smoke-user-journey.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.COREBIZ_CONFIRM_DISPOSABLE_DB !== "YES") {
  throw new Error("BLOCKED: explicit disposable DB confirmation is required");
}
if (!process.env.COREBIZ_SMOKE_BASE_URL) {
  throw new Error("BLOCKED: COREBIZ_SMOKE_BASE_URL required");
}
const base = new URL(process.env.COREBIZ_SMOKE_BASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.protocol !== "http:") {
  throw new Error("BLOCKED: smoke tests may target only local HTTP disposable services");
}
const origin = process.env.COREBIZ_SMOKE_WEB_ORIGIN ?? "http://localhost:3000";
const suffix = randomUUID();
const email = "smoke-" + suffix + "@example.invalid";
const password = "SmokeTest-" + randomUUID();
let cookie = "";

async function request(method, path, data, expectedStatus) {
  const response = await fetch(new URL("/api/v1" + path, base), {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: "manual",
    signal: AbortSignal.timeout(15000)
  });
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus,
      method + " " + path + " status " + response.status);
  } else {
    assert.equal(response.ok, true, method + " " + path + " HTTP " + response.status +
      ": " + (await response.text()).slice(0, 400));
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie?.startsWith("corebiz_session=")) cookie = setCookie.split(";")[0];
  const payload = await response.json();
  if (expectedStatus === undefined) {
    assert.equal(payload.ok, true, method + " " + path + " response");
  }
  return payload;
}

async function main() {
  const ready = await request("GET", "/health/ready");
  assert.equal(ready.data.status, "ok", "Postgres/Redis/RLS readiness");

  const invalidLogin = await request("POST", "/auth/login",
    { email: {}, password: [] }, 400);
  assert.equal(invalidLogin.ok, false);

  const registered = await request("POST", "/auth/register",
    { email, password, companyName: "Smoke Test Company" });
  assert.ok(registered.data.auth.tenantId, "registration tenant ID");
  const firstTenantId = registered.data.auth.tenantId;
  const me = await request("GET", "/auth/me");
  assert.equal(me.data.auth.email, email);

  const product = await request("POST", "/catalog/products",
    { name: "Smoke consulting service", kind: "NON_STOCK",
      salePriceMinor: "15000", costPriceMinor: "3000" });
  const skuId = product.data.skuId;
  assert.ok(skuId);
  const products = await request("GET", "/catalog/products");
  assert.ok(products.data.some((row) => row.skuId === skuId));

  const deal = await request("POST", "/crm/deals",
    { title: "Smoke deal", amountMinor: "15000" });
  assert.ok(deal.data.id);
  const board = await request("GET", "/crm/board");
  assert.ok(board.data.stages.some((stage) => stage.deals.some((d) => d.id === deal.data.id)));

  const idempotencyKey = "smoke-" + suffix;
  const orderInput = { idempotencyKey,
    lines: [{ skuId, quantityMilli: "1000", unitPriceMinor: "15000" }] };
  const order = await request("POST", "/sales/orders", orderInput);
  assert.ok(order.data.id);
  const retried = await request("POST", "/sales/orders", orderInput);
  assert.equal(retried.data.id, order.data.id, "duplicate order retry must be idempotent");
  const orders = await request("GET", "/sales/orders");
  assert.equal(orders.data.filter((item) => item.id === order.data.id).length, 1);

  const confirmed = await request("PATCH", "/sales/orders/" + order.data.id + "/confirm",
    { version: order.data.version });
  assert.equal(confirmed.data.orderStatus, "CONFIRMED");

  const account = await request("POST", "/finance/accounts",
    { name: "Smoke settlement account", kind: "BANK", currency: "RUB" });
  assert.ok(account.data.id);
  const paymentInput = {
    orderId: order.data.id, amountMinor: "15000",
    cashAccountId: account.data.id, idempotencyKey: "payment-" + suffix
  };
  const payment = await request("POST", "/finance/sales-payment", paymentInput);
  assert.ok(payment.data.paymentId);
  const paymentRetry = await request("POST", "/finance/sales-payment", paymentInput);
  assert.equal(paymentRetry.data.paymentId, payment.data.paymentId);
  const collision = await request("POST", "/finance/sales-payment",
    { ...paymentInput, amountMinor: "14000" }, 409);
  assert.equal(collision.ok, false);
  const payments = await request("GET", "/finance/payments");
  assert.equal(payments.data.filter((item) => item.id === payment.data.paymentId).length, 1);
  const paidOrder = await request("GET", "/sales/orders");
  assert.equal(paidOrder.data.find((item) => item.id === order.data.id)?.paymentStatus, "PAID");

  const warehouse = await request("POST", "/inventory/warehouses",
    { name: "Smoke warehouse", code: "SMOKE" });
  assert.ok(warehouse.data.id);
  const stockProduct = await request("POST", "/catalog/products", {
    name: "Smoke stock item", kind: "STOCKABLE",
    salePriceMinor: "2500", costPriceMinor: "800"
  });
  const adjustInput = {
    warehouseId: warehouse.data.id, skuId: stockProduct.data.skuId,
    quantityDeltaMilli: "5000", reason: "Disposable smoke initial stock",
    idempotencyKey: "stock-" + suffix
  };
  const adjustment = await request("POST", "/inventory/adjustments", adjustInput);
  assert.ok(adjustment.data.movementId);
  const duplicateAdjustment = await request("POST", "/inventory/adjustments", adjustInput);
  assert.equal(duplicateAdjustment.data.movementId, adjustment.data.movementId);
  const balances = await request("GET", "/inventory/balances");
  assert.equal(
    balances.data.find((item) => item.skuId === stockProduct.data.skuId &&
      item.warehouseId === warehouse.data.id)?.physicalMilli,
    "5000"
  );

  const newTenant = await request("POST", "/tenants", { name: "Other smoke tenant" });
  assert.notEqual(newTenant.data.tenantId, firstTenantId);
  const switched = await request("GET", "/auth/me");
  assert.equal(switched.data.auth.tenantId, newTenant.data.tenantId);
  const isolatedOrders = await request("GET", "/sales/orders");
  assert.equal(isolatedOrders.data.some((item) => item.id === order.data.id), false,
    "orders from another tenant must never leak");
  const isolatedPayments = await request("GET", "/finance/payments");
  assert.equal(isolatedPayments.data.some((item) => item.id === payment.data.paymentId), false,
    "payments from another tenant must never leak");
  const isolatedBalances = await request("GET", "/inventory/balances");
  assert.equal(isolatedBalances.data.some((item) => item.skuId === stockProduct.data.skuId), false,
    "stock from another tenant must never leak");

  const originalMembership = switched.data.memberships.find(
    (item) => item.tenantId === firstTenantId);
  assert.ok(originalMembership);
  await request("POST", "/auth/switch-tenant",
    { membershipId: originalMembership.membershipId });
  const switchedBack = await request("GET", "/auth/me");
  assert.equal(switchedBack.data.auth.tenantId, firstTenantId);

  await request("POST", "/auth/logout", {});
  const unauth = await request("GET", "/auth/me", undefined, 401);
  assert.equal(unauth.ok, false);

  await request("POST", "/auth/login", { email, password });
  const afterLogin = await request("GET", "/auth/me");
  assert.equal(afterLogin.data.auth.email, email);
  console.log("PASS: auth → catalog → CRM → sales → finance/payment → inventory → idempotency → cross-tenant isolation → logout/login");
  console.log("Smoke environment only. Production acceptance is still required.");
}

main().catch((error) => {
  console.error("FAIL: disposable user journey", error?.message ?? String(error));
  process.exitCode = 1;
});
