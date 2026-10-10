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

async function danceStudioJourney() {
  await newTenant(
    "Golden Dance " + runId.slice(0, 8),
    "SERVICE"
  );

  const vertical = await request(
    "PUT",
    "/customization/business-vertical",
    { verticalCode: "DANCE_FITNESS" }
  );
  assert.equal(vertical.verticalCode, "DANCE_FITNESS");

  const parent = await request("POST", "/crm/customers", {
    displayName: "Golden Dance Parent",
    phone: "+79991112233"
  });
  const child = await request("POST", "/crm/customers", {
    displayName: "Golden Dance Child"
  });
  const landlord = await request("POST", "/crm/customers", {
    type: "ORGANIZATION",
    displayName: "Golden Dance Landlord"
  });

  const student = await request("POST", "/dance/students", {
    partyId: child.id,
    birthDate: "2015-05-10",
    status: "ACTIVE",
    payerPartyId: parent.id,
    payerRelation: "PARENT"
  });
  assert.ok(student.id, "DANCE student");

  const service = await request("POST", "/service/catalog", {
    name: "Golden dance group lesson",
    code: "DANCE-" + runId.slice(0, 6).toUpperCase(),
    durationMinutes: 60,
    priceMinor: "100000",
    currency: "RUB"
  });

  const trainer = await request("POST", "/service/resources", {
    type: "EMPLOYEE",
    name: "Golden dance trainer",
    code: "DTR-" + runId.slice(0, 6).toUpperCase(),
    capacity: 1,
    timezone: "Europe/Moscow"
  });
  const room = await request("POST", "/service/resources", {
    type: "ROOM",
    name: "Golden dance hall",
    code: "DRM-" + runId.slice(0, 6).toUpperCase(),
    capacity: 20,
    timezone: "Europe/Moscow"
  });

  const program = await request("POST", "/dance/programs", {
    name: "Golden Hip-Hop",
    code: "HIP-" + runId.slice(0, 6).toUpperCase(),
    serviceId: service.id,
    defaultDurationMinutes: 60
  });

  const group = await request("POST", "/dance/groups", {
    programId: program.id,
    name: "Golden Kids Group",
    trainerResourceId: trainer.id,
    roomResourceId: room.id,
    capacity: 8,
    breakEvenMembers: 2,
    schedule: []
  });

  const membership = await request(
    "POST",
    "/dance/groups/" + group.id + "/members",
    {
      studentId: student.id,
      status: "ACTIVE",
      discountBps: 1000,
      allowWaitlist: true
    }
  );
  assert.equal(membership.waitlisted, false);

  const plan = await request("POST", "/service/package-plans", {
    name: "Golden 8 dance visits",
    packageKind: "VISITS",
    applicableServiceId: service.id,
    danceProgramId: program.id,
    danceGroupId: group.id,
    visitLimit: 8,
    durationDays: 45,
    priceMinor: "800000",
    managementVisitValueMinor: "100000",
    freezeDaysAllowed: 7,
    makeupDaysValid: 14,
    allowMakeup: true,
    activationPolicy: "FULL_PAYMENT",
    noShowPolicy: "CONSUME"
  });

  const issuedPackage = await request("POST", "/service/packages", {
    planId: plan.id,
    partyId: child.id,
    payerPartyId: parent.id,
    startsAt: new Date().toISOString()
  });
  assert.ok(issuedPackage.id);

  const beforePayment = await request(
    "GET",
    "/service/packages?partyId=" + encodeURIComponent(child.id)
  );
  const pendingPackage = beforePayment.find(
    (item) => item.id === issuedPackage.id
  );
  assert.equal(
    pendingPackage?.status,
    "PENDING_PAYMENT",
    "DANCE full-payment package must wait for money"
  );

  const charges = await request(
    "GET",
    "/dance/charges?studentId=" + encodeURIComponent(student.id)
  );
  const packageCharge = charges.find(
    (item) =>
      item.source_type === "PACKAGE" &&
      item.source_id === issuedPackage.id
  );
  assert.ok(packageCharge?.obligation_id, "DANCE package receivable");

  const paymentKey = "golden-dance-payment-" + randomUUID();
  const payment = await request("POST", "/finance/allocated-payment", {
    partyId: parent.id,
    allocations: [
      {
        obligationId: packageCharge.obligation_id,
        amountMinor: packageCharge.remaining_minor
      }
    ],
    idempotencyKey: paymentKey,
    note: "Golden dance family payment"
  });
  const paymentRetry = await request(
    "POST",
    "/finance/allocated-payment",
    {
      partyId: parent.id,
      allocations: [
        {
          obligationId: packageCharge.obligation_id,
          amountMinor: packageCharge.remaining_minor
        }
      ],
      idempotencyKey: paymentKey,
      note: "Golden dance family payment"
    }
  );
  assert.equal(
    paymentRetry.paymentId,
    payment.paymentId,
    "DANCE family payment retry must be idempotent"
  );

  const afterPayment = await request(
    "GET",
    "/service/packages?partyId=" + encodeURIComponent(child.id)
  );
  assert.equal(
    afterPayment.find((item) => item.id === issuedPackage.id)?.status,
    "ACTIVE",
    "DANCE paid package must activate"
  );

  await request("POST", "/dance/compensation-plans", {
    trainerResourceId: trainer.id,
    lessonType: "GROUP",
    calculationType: "ATTENDEE",
    fixedMinor: "120000",
    perAttendeeMinor: "10000",
    revenueBasis: "EARNED"
  });

  await request("POST", "/dance/room-contracts", {
    roomResourceId: room.id,
    counterpartyPartyId: landlord.id,
    pricingType: "HOURLY",
    hourlyRateMinor: "80000",
    minimumBillableMinutes: 60,
    cancellationChargeBps: 5000,
    paymentTermDays: 5
  });

  const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  startsAt.setUTCMinutes(0, 0, 0);

  const lesson = await request("POST", "/dance/lessons", {
    groupId: group.id,
    startsAt: startsAt.toISOString(),
    durationMinutes: 60,
    capacity: 8,
    idempotencyKey: "golden-dance-lesson-" + randomUUID()
  });

  const synced = await request(
    "POST",
    "/dance/groups/" + group.id + "/sync-roster"
  );
  assert.ok(
    synced.enrolled >= 1 || synced.already >= 1,
    "DANCE group roster must reach lesson journal"
  );

  const participants = await request(
    "GET",
    "/dance/lessons/" + lesson.id + "/participants"
  );
  const participant = participants.find(
    (item) => item.student_id === student.id
  );
  assert.ok(participant, "DANCE student must be on lesson");
  assert.equal(
    participant.package_id,
    issuedPackage.id,
    "DANCE roster must choose active scoped package"
  );

  const attended = await request(
    "PATCH",
    "/dance/lessons/" +
      lesson.id +
      "/participants/" +
      participant.id +
      "/attendance",
    {
      status: "ATTENDED",
      version: participant.version
    }
  );
  assert.equal(attended.status, "ATTENDED");

  const profitability = await request(
    "POST",
    "/dance/lessons/" + lesson.id + "/complete"
  );
  assert.equal(profitability.lesson_id, lesson.id);
  assert.ok(
    BigInt(profitability.earned_revenue_minor) > 0n,
    "DANCE completed lesson must recognize revenue"
  );
  assert.ok(
    BigInt(profitability.trainer_cost_minor) > 0n,
    "DANCE completed lesson must accrue trainer compensation"
  );
  assert.ok(
    BigInt(profitability.room_cost_minor) > 0n,
    "DANCE completed lesson must recognize room cost"
  );

  const accruals = await request(
    "GET",
    "/dance/compensation-accruals?from=" +
      encodeURIComponent(
        new Date(startsAt.getTime() - 86400000).toISOString()
      ) +
      "&to=" +
      encodeURIComponent(
        new Date(startsAt.getTime() + 86400000).toISOString()
      )
  );
  assert.ok(
    accruals.some(
      (item) =>
        item.lesson_id === lesson.id &&
        BigInt(item.amount_minor) > 0n
    ),
    "DANCE trainer accrual must be traceable"
  );

  const month = startsAt.toISOString().slice(0, 7);
  const rent = await request(
    "POST",
    "/dance/room-statements/finalize",
    { month }
  );
  const rentStatement = rent.statements.find(
    (item) =>
      item.contractId !== undefined &&
      BigInt(item.amountMinor ?? item.amount_minor ?? "0") > 0n
  );
  assert.ok(rentStatement, "DANCE room rent statement");
  assert.ok(
    rentStatement.obligationId ?? rentStatement.obligation_id,
    "DANCE landlord payable must be created"
  );

  const dashboard = await request("GET", "/dance/dashboard");
  assert.ok(
    dashboard.monthEconomics &&
      typeof dashboard.monthEconomics.revenue_minor === "string",
    "DANCE owner dashboard must expose monthly economics"
  );
  assert.equal(
    dashboard.attention.completed_without_profitability,
    0,
    "DANCE completed lesson must have profitability snapshot"
  );

  return {
    profile: "DANCE_FITNESS",
    result:
      "parent → child → group → package → payment → lesson → attendance → trainer + room economics",
    studentId: student.id,
    groupId: group.id,
    lessonId: lesson.id,
    packageId: issuedPackage.id,
    paymentId: payment.paymentId
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
  results.push(await danceStudioJourney());
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
    "PASS: TRADE + ECOMMERCE + SERVICE + DANCE_FITNESS + WAREHOUSE_3PL golden journeys"
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
