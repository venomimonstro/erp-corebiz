#!/usr/bin/env node
/**
 * 100-user disposable business simulation.
 *
 * Actors:
 *   40 ECOMMERCE buyers competing for 25 units
 *   30 BEAUTY_SALON clients competing for one appointment slot
 *   20 independent public CRM leads
 *   10 tenant-isolation reads
 *
 * Never run against production.
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
if (
  base.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
) {
  throw new Error("BLOCKED: 100-user simulation may target only local HTTP disposable services");
}

const origin =
  process.env.COREBIZ_SMOKE_WEB_ORIGIN ?? "http://localhost:3000";
const runId = randomUUID();
const email = "sim100-" + runId + "@example.invalid";
const password = "Sim100-" + randomUUID();
let cookie = "";

function actorIp(index) {
  // TEST-NET-2: documentation-only address space.
  return "198.51.100." + ((index % 200) + 1);
}

async function call(
  method,
  path,
  data,
  {
    authenticated = true,
    clientIp,
    allowHttpErrors = false,
    timeoutMs = 30000
  } = {}
) {
  const response = await fetch(new URL("/api/v1" + path, base), {
    method,
    headers: {
      Origin: origin,
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
      ...(data === undefined
        ? {}
        : { "Content-Type": "application/json" })
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  });

  const setCookie = response.headers.get("set-cookie");
  if (authenticated && setCookie?.startsWith("corebiz_session=")) {
    cookie = setCookie.split(";")[0];
  }

  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { ok: false, raw: raw.slice(0, 500) };
  }

  if (!allowHttpErrors) {
    assert.equal(
      response.ok,
      true,
      method + " " + path + " HTTP " + response.status + ": " + raw.slice(0, 500)
    );
    assert.equal(payload.ok, true, method + " " + path + " response");
  }

  return {
    status: response.status,
    ok: response.ok && payload.ok === true,
    data: payload.data,
    error: payload.error
  };
}

async function request(method, path, data, options) {
  const result = await call(method, path, data, options);
  return result.data;
}

async function createTenant(name, verticalCode) {
  const tenant = await request("POST", "/tenants", { name });
  const vertical = await request(
    "PUT",
    "/customization/business-vertical",
    { verticalCode }
  );
  assert.equal(vertical.verticalCode, verticalCode);
  return tenant;
}

async function createStock(prefix, quantityMilli) {
  const warehouse = await request("POST", "/inventory/warehouses", {
    name: prefix + " warehouse",
    code: (prefix + runId).replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase()
  });

  const product = await request("POST", "/catalog/products", {
    name: prefix + " product",
    kind: "STOCKABLE",
    salePriceMinor: "4900",
    costPriceMinor: "1900"
  });

  await request("POST", "/inventory/adjustments", {
    warehouseId: warehouse.id,
    skuId: product.skuId,
    quantityDeltaMilli,
    reason: "100-user disposable simulation initial stock",
    idempotencyKey: "sim100-stock-" + randomUUID()
  });

  return { warehouseId: warehouse.id, skuId: product.skuId };
}

async function ecommerce40() {
  await createTenant(
    "Sim100 Ecommerce " + runId.slice(0, 8),
    "ECOMMERCE_STORE"
  );

  const stock = await createStock("simweb", "25000");
  const slug =
    "sim100-" + runId.replace(/-/g, "").slice(0, 20).toLowerCase();
  const site = await request("POST", "/sites", {
    name: "Магазин 100 покупателей",
    publicSlug: slug
  });

  await request("PUT", "/storefront/site/" + site.id + "/config", {
    enabled: true,
    currency: "RUB"
  });

  const actors = Array.from({ length: 40 }, (_, index) => ({
    index,
    ip: actorIp(index),
    phone: "+7999" + String(1000000 + index)
  }));

  const carts = await Promise.all(
    actors.map(async (actor) => {
      const created = await request(
        "POST",
        "/storefront/" + site.publicSlug + "/carts",
        {},
        { authenticated: false, clientIp: actor.ip }
      );
      await request(
        "PUT",
        "/storefront/carts/" + created.cartKey + "/lines",
        { skuId: stock.skuId, quantityMilli: "1000" },
        { authenticated: false, clientIp: actor.ip }
      );
      return { ...actor, cartKey: created.cartKey };
    })
  );

  const results = await Promise.all(
    carts.map((actor) =>
      request(
        "POST",
        "/storefront/carts/" + actor.cartKey + "/checkout",
        {
          idempotencyKey: "sim100-checkout-" + actor.index + "-" + runId,
          name: "Покупатель " + actor.index,
          phone: actor.phone
        },
        {
          authenticated: false,
          clientIp: actor.ip,
          timeoutMs: 60000
        }
      )
    )
  );

  assert.equal(results.length, 40);
  assert.ok(results.every((row) => row.accepted === true));

  const allocated = results.filter(
    (row) => row.allocationState === "ALLOCATED"
  );
  const constrained = results.filter(
    (row) =>
      row.allocationState === "PARTIALLY_ALLOCATED" ||
      row.allocationState === "BACKORDER"
  );

  assert.equal(
    allocated.length,
    25,
    "Exactly 25 one-unit orders must receive the 25 available units"
  );
  assert.equal(
    constrained.length,
    15,
    "Remaining 15 buyers must be explicit backorders, not hidden oversell"
  );

  const catalog = await request(
    "GET",
    "/storefront/" + site.publicSlug + "/catalog",
    undefined,
    { authenticated: false, clientIp: actorIp(199) }
  );
  const item = catalog.products.find((row) => row.sku_id === stock.skuId);
  assert.equal(item?.atp_milli, "0", "ATP must be exhausted, never negative");

  return {
    actors: 40,
    allocated: allocated.length,
    backorder: constrained.length
  };
}

async function service30AndLeads20() {
  await createTenant(
    "Sim100 Beauty " + runId.slice(0, 8),
    "BEAUTY_SALON"
  );

  const service = await request("POST", "/service/catalog", {
    name: "Стрижка",
    code: "SIMCUT-" + runId.slice(0, 6).toUpperCase(),
    durationMinutes: 60,
    priceMinor: "250000",
    currency: "RUB"
  });

  const resource = await request("POST", "/service/resources", {
    type: "EMPLOYEE",
    name: "Мастер",
    code: "SIMMASTER-" + runId.slice(0, 5).toUpperCase(),
    capacity: 1,
    timezone: "Europe/Moscow"
  });

  await request(
    "PUT",
    "/service/resources/" + resource.id + "/schedule",
    {
      windows: Array.from({ length: 7 }, (_, index) => ({
        weekday: index + 1,
        startMinute: 0,
        endMinute: 1440
      }))
    }
  );

  const site = await request("POST", "/sites", {
    name: "Салон",
    publicSlug:
      "simbeauty-" + runId.replace(/-/g, "").slice(0, 16).toLowerCase()
  });

  const bookingBinding = await request(
    "POST",
    "/site-forms/site/" + site.id,
    {
      name: "Онлайн-запись",
      action: "BOOKING",
      serviceId: service.id,
      resourceIds: [resource.id]
    }
  );

  const customersBefore = await request("GET", "/crm/customers");

  const startsAt = new Date(Date.now() + 48 * 3600000);
  startsAt.setUTCMinutes(0, 0, 0);
  startsAt.setUTCSeconds(0, 0);

  const bookingResults = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      call(
        "POST",
        "/site-forms/submit/" + bookingBinding.publicKey,
        {
          idempotencyKey: "sim100-book-" + index + "-" + runId,
          name: "Клиент записи " + index,
          phone: "+7888" + String(1000000 + index),
          startsAt: startsAt.toISOString(),
          resourceId: resource.id
        },
        {
          authenticated: false,
          clientIp: actorIp(40 + index),
          allowHttpErrors: true,
          timeoutMs: 60000
        }
      )
    )
  );

  const bookingAccepted = bookingResults.filter(
    (row) => row.ok && row.data?.accepted === true
  );
  assert.equal(
    bookingAccepted.length,
    1,
    "Only one client may win a capacity=1 appointment slot"
  );

  const bookings = await request(
    "GET",
    "/service/bookings?from=" +
      encodeURIComponent(new Date(startsAt.getTime() - 3600000).toISOString()) +
      "&to=" +
      encodeURIComponent(new Date(startsAt.getTime() + 7200000).toISOString())
  );
  const activeAtSlot = bookings.filter(
    (row) =>
      row.starts_at === startsAt.toISOString() &&
      !["CANCELLED", "NO_SHOW"].includes(row.status)
  );
  assert.equal(activeAtSlot.length, 1, "Schedule must contain one active booking");

  const customersAfterBooking = await request("GET", "/crm/customers");
  assert.equal(
    customersAfterBooking.length - customersBefore.length,
    1,
    "Losing concurrent booking attempts must not create ghost CRM customers"
  );

  const leadBinding = await request(
    "POST",
    "/site-forms/site/" + site.id,
    {
      name: "Заявка",
      action: "CRM_LEAD"
    }
  );

  const leadResults = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      call(
        "POST",
        "/site-forms/submit/" + leadBinding.publicKey,
        {
          idempotencyKey: "sim100-lead-" + index + "-" + runId,
          name: "Лид " + index,
          phone: "+7777" + String(1000000 + index),
          message: "Тестовая заявка " + index
        },
        {
          authenticated: false,
          clientIp: actorIp(70 + index),
          allowHttpErrors: true
        }
      )
    )
  );

  assert.equal(
    leadResults.filter(
      (row) =>
        row.ok &&
        row.data?.accepted === true &&
        row.data?.resultType === "CRM_DEAL"
    ).length,
    20,
    "20 independent clients must not block each other through shared throttling"
  );

  const customersAfterLeads = await request("GET", "/crm/customers");
  assert.equal(
    customersAfterLeads.length - customersAfterBooking.length,
    20,
    "Each accepted public lead must create exactly one customer"
  );

  return {
    bookingActors: 30,
    bookingAccepted: 1,
    leadActors: 20,
    leadsAccepted: 20
  };
}

async function tenantIsolation10() {
  await createTenant(
    "Sim100 Tenant A " + runId.slice(0, 8),
    "WHOLESALE_B2B"
  );
  const product = await request("POST", "/catalog/products", {
    name: "Tenant A secret SKU",
    kind: "STOCKABLE",
    salePriceMinor: "10000",
    costPriceMinor: "5000"
  });
  const foreignOrder = await request("POST", "/sales/orders", {
    idempotencyKey: "sim100-tenant-a-" + runId,
    lines: [
      {
        skuId: product.skuId,
        quantityMilli: "1000",
        unitPriceMinor: "10000"
      }
    ]
  });

  await createTenant(
    "Sim100 Tenant B " + runId.slice(0, 8),
    "WHOLESALE_B2B"
  );

  const reads = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      request("GET", "/sales/orders", undefined, {
        clientIp: actorIp(90 + index)
      })
    )
  );

  for (const orders of reads) {
    assert.equal(
      orders.some((order) => order.id === foreignOrder.id),
      false,
      "Tenant B must never see Tenant A order"
    );
  }

  return { actors: 10, leaks: 0 };
}

async function main() {
  const ready = await request("GET", "/health/ready");
  assert.equal(ready.status, "ok");

  const registered = await request("POST", "/auth/register", {
    email,
    password,
    companyName: "Sim100 Bootstrap " + runId.slice(0, 8)
  });
  assert.ok(registered.auth?.tenantId);

  const ecommerce = await ecommerce40();
  const service = await service30AndLeads20();
  const isolation = await tenantIsolation10();

  const actors =
    ecommerce.actors +
    service.bookingActors +
    service.leadActors +
    isolation.actors;

  assert.equal(actors, 100);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        runId,
        actors,
        ecommerce,
        service,
        isolation
      },
      null,
      2
    ) + "\n"
  );
  console.log(
    "PASS: 100-user business simulation — inventory contention, booking contention, public leads and tenant isolation"
  );
}

main().catch((error) => {
  console.error(
    "FAIL: 100-user business simulation",
    error instanceof Error ? error.stack ?? error.message : String(error)
  );
  process.exitCode = 1;
});
