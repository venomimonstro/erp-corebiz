#!/usr/bin/env node
/**
 * Golden business journeys for a LOCAL disposable CoreBiz stack.
 * Creates real tenants and business objects through public/authenticated APIs.
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
  throw new Error(
    "BLOCKED: golden journeys may target only local HTTP disposable services"
  );
}

const origin =
  process.env.COREBIZ_SMOKE_WEB_ORIGIN ?? "http://localhost:3000";
const runId = randomUUID();
const email = "golden-" + runId + "@example.invalid";
const password = "Golden-" + randomUUID();
let cookie = "";

async function request(
  method,
  path,
  data,
  { authenticated = true, expectedStatus } = {}
) {
  const response = await fetch(new URL("/api/v1" + path, base), {
    method,
    headers: {
      Origin: origin,
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(data === undefined
        ? {}
        : { "Content-Type": "application/json" })
    },
    body:
      data === undefined ? undefined : JSON.stringify(data),
    redirect: "manual",
    signal: AbortSignal.timeout(20000)
  });

  const setCookie = response.headers.get("set-cookie");
  if (
    authenticated &&
    setCookie?.startsWith("corebiz_session=")
  ) {
    cookie = setCookie.split(";")[0];
  }

  let payload;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, raw: text.slice(0, 500) };
  }

  if (expectedStatus !== undefined) {
    assert.equal(
      response.status,
      expectedStatus,
      method + " " + path + " status"
    );
    return payload;
  }

  assert.equal(
    response.ok,
    true,
    method +
      " " +
      path +
      " HTTP " +
      response.status +
      ": " +
      text.slice(0, 500)
  );
  assert.equal(payload.ok, true, method + " " + path + " response");
  return payload.data;
}

async function newTenant(name, profileCode) {
  const created = await request("POST", "/tenants", { name });
  assert.ok(created.tenantId, name + " tenant");

  const profile = await request(
    "PUT",
    "/customization/business-profile",
    { profileCode }
  );
  assert.equal(profile.profileCode, profileCode);

  const current = await request(
    "GET",
    "/customization/business-profile"
  );
  assert.equal(current.profileCode, profileCode);

  return {
    tenantId: created.tenantId,
    membershipId: created.membershipId,
    profile: current
  };
}

async function stockProduct(prefix, quantityMilli = "10000") {
  const warehouse = await request(
    "POST",
    "/inventory/warehouses",
    {
      name: prefix + " warehouse",
      code: prefix.slice(0, 8).toUpperCase()
    }
  );

  const product = await request(
    "POST",
    "/catalog/products",
    {
      name: prefix + " product",
      kind: "STOCKABLE",
      salePriceMinor: "4900",
      costPriceMinor: "1900"
    }
  );

  await request("POST", "/inventory/adjustments", {
    warehouseId: warehouse.id,
    skuId: product.skuId,
    quantityDeltaMilli: quantityMilli,
    reason: "Golden disposable initial stock",
    idempotencyKey: "golden-stock-" + randomUUID()
  });

  return {
    warehouseId: warehouse.id,
    skuId: product.skuId
  };
}

async function tradeJourney() {
  await newTenant("Golden Trade " + runId.slice(0, 8), "TRADE");
  const stock = await stockProduct("trade");

  const order = await request("POST", "/sales/orders", {
    idempotencyKey: "golden-trade-order-" + randomUUID(),
    lines: [
      {
        skuId: stock.skuId,
        quantityMilli: "2000",
        unitPriceMinor: "4900"
      }
    ]
  });

  const confirmed = await request(
    "PATCH",
    "/sales/orders/" + order.id + "/confirm",
    { version: order.version }
  );
  assert.equal(confirmed.orderStatus, "CONFIRMED");

  await request("POST", "/inventory/reserve-order", {
    orderId: order.id,
    warehouseId: stock.warehouseId,
    idempotencyKey: "golden-trade-reserve-" + randomUUID()
  });

  await request("POST", "/inventory/ship-order", {
    orderId: order.id,
    idempotencyKey: "golden-trade-ship-" + randomUUID()
  });

  const orders = await request("GET", "/sales/orders");
  const shipped = orders.find((item) => item.id === order.id);
  assert.equal(
    shipped?.fulfillmentStatus,
    "SHIPPED",
    "TRADE order must reach SHIPPED"
  );

  const balances = await request("GET", "/inventory/balances");
  const balance = balances.find(
    (item) =>
      item.skuId === stock.skuId &&
      item.warehouseId === stock.warehouseId
  );
  assert.equal(balance?.physicalMilli, "8000");
  assert.equal(balance?.reservedMilli, "0");

  return {
    profile: "TRADE",
    result: "stock → order → reserve → ship",
    orderId: order.id
  };
}

async function ecommerceJourney() {
  await newTenant(
    "Golden Ecommerce " + runId.slice(0, 8),
    "ECOMMERCE"
  );
  const stock = await stockProduct("ecom", "5000");

  const slug =
    "golden-" +
    runId.replace(/-/g, "").slice(0, 18).toLowerCase();

  const site = await request("POST", "/sites", {
    name: "Golden Store",
    publicSlug: slug
  });

  await request(
    "PUT",
    "/storefront/site/" + site.id + "/config",
    {
      enabled: true,
      currency: "RUB"
    }
  );

  const catalog = await request(
    "GET",
    "/storefront/" + site.publicSlug + "/catalog",
    undefined,
    { authenticated: false }
  );
  const item = catalog.products.find(
    (row) => row.sku_id === stock.skuId
  );
  assert.ok(item, "ECOMMERCE SKU must be visible in public catalog");
  assert.ok(
    BigInt(item.atp_milli) >= 1000n,
    "ECOMMERCE public ATP must be available"
  );

  const cart = await request(
    "POST",
    "/storefront/" + site.publicSlug + "/carts",
    {},
    { authenticated: false }
  );

  await request(
    "PUT",
    "/storefront/carts/" + cart.cartKey + "/lines",
    {
      skuId: stock.skuId,
      quantityMilli: "1000"
    },
    { authenticated: false }
  );

  const checkoutKey = "golden-checkout-" + randomUUID();
  const checkout = await request(
    "POST",
    "/storefront/carts/" + cart.cartKey + "/checkout",
    {
      idempotencyKey: checkoutKey,
      name: "Golden Buyer",
      phone: "+79990000000"
    },
    { authenticated: false }
  );
  assert.equal(checkout.accepted, true);
  assert.equal(checkout.orderStatus, "CONFIRMED");

  const retry = await request(
    "POST",
    "/storefront/carts/" + cart.cartKey + "/checkout",
    {
      idempotencyKey: checkoutKey,
      name: "Golden Buyer",
      phone: "+79990000000"
    },
    { authenticated: false }
  );
  assert.equal(retry.salesOrderId, checkout.salesOrderId);

  const orders = await request("GET", "/sales/orders");
  assert.equal(
    orders.filter((item) => item.id === checkout.salesOrderId).length,
    1,
    "ECOMMERCE checkout retry must not duplicate order"
  );

  return {
    profile: "ECOMMERCE",
    result: "ERP catalog → public cart → confirmed SalesOrder",
    orderId: checkout.salesOrderId,
    siteId: site.id
  };
}

async function serviceJourney() {
  await newTenant(
    "Golden Service " + runId.slice(0, 8),
    "SERVICE"
  );

  const service = await request("POST", "/service/catalog", {
    name: "Golden consultation",
    code: "GOLDEN-" + runId.slice(0, 6).toUpperCase(),
    durationMinutes: 30,
    priceMinor: "350000",
    currency: "RUB"
  });

  const resource = await request(
    "POST",
    "/service/resources",
    {
      type: "EMPLOYEE",
      name: "Golden specialist",
      code: "GS-" + runId.slice(0, 6).toUpperCase(),
      capacity: 1,
      timezone: "Europe/Moscow"
    }
  );

  const windows = Array.from({ length: 7 }, (_, index) => ({
    weekday: index + 1,
    startMinute: 0,
    endMinute: 1440
  }));

  await request(
    "PUT",
    "/service/resources/" + resource.id + "/schedule",
    { windows }
  );

  const startsAt = new Date(
    Date.now() + 48 * 60 * 60 * 1000
  );
  startsAt.setUTCMinutes(0, 0, 0);

  const key = "golden-booking-" + randomUUID();
  const bookingInput = {
    serviceId: service.id,
    resourceIds: [resource.id],
    startsAt: startsAt.toISOString(),
    source: "API",
    idempotencyKey: key
  };

  const booking = await request(
    "POST",
    "/service/bookings",
    bookingInput
  );
  const retry = await request(
    "POST",
    "/service/bookings",
    bookingInput
  );
  assert.equal(retry.id, booking.id);

  const rows = await request(
    "GET",
    "/service/bookings?from=" +
      encodeURIComponent(
        new Date(startsAt.getTime() - 3600000).toISOString()
      ) +
      "&to=" +
      encodeURIComponent(
        new Date(startsAt.getTime() + 3600000).toISOString()
      )
  );
  assert.ok(
    rows.some((item) => item.id === booking.id),
    "SERVICE booking must appear in schedule"
  );

  return {
    profile: "SERVICE",
    result: "service + resource + schedule → idempotent booking",
    bookingId: booking.id
  };
}

async function warehouse3plJourney() {
  await newTenant(
    "Golden 3PL " + runId.slice(0, 8),
    "WAREHOUSE_3PL"
  );

  const warehouse = await request(
    "POST",
    "/inventory/warehouses",
    {
      name: "Golden 3PL warehouse",
      code: "G3PL"
    }
  );

  await request(
    "PUT",
    "/wms/warehouses/" + warehouse.id + "/profile",
    {
      mode: "ADDRESS",
      status: "ACTIVE",
      coordinateUnit: "GRID"
    }
  );

  const zone = await request(
    "POST",
    "/wms/warehouses/" + warehouse.id + "/zones",
    {
      code: "STOR",
      name: "Storage",
      zoneType: "STORAGE",
      priority: 100
    }
  );

  const location = await request(
    "POST",
    "/wms/warehouses/" + warehouse.id + "/locations",
    {
      zoneId: zone.id,
      code: "A01",
      name: "A-01",
      locationType: "BIN",
      pickSequence: 100
    }
  );
  assert.ok(location.fullCode);

  const client = await request("POST", "/crm/customers", {
    type: "ORGANIZATION",
    displayName: "Golden 3PL Client"
  });

  const owner = await request("POST", "/wms/owners", {
    partyId: client.id,
    code: "CLIENT-" + runId.slice(0, 6).toUpperCase(),
    name: "Golden Client Stock"
  });

  await request(
    "PUT",
    "/wms/warehouses/" +
      warehouse.id +
      "/3pl/" +
      owner.id,
    {
      status: "ACTIVE",
      services: {
        receiving: true,
        storage: true,
        picking: true
      },
      billingRules: {
        currency: "RUB"
      }
    }
  );

  const topology = await request(
    "GET",
    "/wms/warehouses/" + warehouse.id + "/topology"
  );
  assert.equal(topology.profile?.status, "ACTIVE");
  assert.ok(
    topology.locations.some((row) => row.id === location.id),
    "3PL location must be visible in topology"
  );

  const owners = await request("GET", "/wms/owners");
  assert.ok(
    owners.some((row) => row.id === owner.id),
    "3PL client owner must be visible"
  );

  return {
    profile: "WAREHOUSE_3PL",
    result: "warehouse → WMS topology → client owner → 3PL contract",
    warehouseId: warehouse.id,
    ownerId: owner.id
  };
}

async function main() {
  const ready = await request("GET", "/health/ready");
  assert.equal(ready.status, "ok");

  const registered = await request("POST", "/auth/register", {
    email,
    password,
    companyName: "Golden Bootstrap " + runId.slice(0, 8)
  });
  assert.ok(registered.auth?.tenantId);

  const results = [];
  results.push(await tradeJourney());
  results.push(await ecommerceJourney());
  results.push(await serviceJourney());
  results.push(await warehouse3plJourney());

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        runId,
        journeys: results
      },
      null,
      2
    ) + "\n"
  );
  console.log(
    "PASS: TRADE + ECOMMERCE + SERVICE + WAREHOUSE_3PL golden journeys"
  );
  console.log(
    "Disposable local environment only. This is not production approval."
  );
}

main().catch((error) => {
  console.error(
    "FAIL: golden business journeys",
    error instanceof Error ? error.stack ?? error.message : String(error)
  );
  process.exitCode = 1;
});
