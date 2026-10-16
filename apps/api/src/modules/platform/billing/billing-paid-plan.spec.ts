import { BadRequestException, ConflictException } from "@nestjs/common";
import { BillingService } from "./billing.service";

const context = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333"
};

function serviceFor(price: string, currentPlan = "FREE") {
  const statements: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM billing_plan")) return { rows: [
        { id: "44444444-4444-4444-8444-444444444444", code: "PRO", monthly_price_minor: price }
      ] };
      if (sql.includes("FROM plan_entitlement")) return { rows: [] };
      if (sql.includes("FROM tenant_subscription s")) return { rows: [
        { status: "ACTIVE", current_plan_code: currentPlan }
      ] };
      return { rows: [] };
    })
  };
  const db = {
    withTenantTransaction: jest.fn(async (_context: unknown, cb: any) => cb(client))
  };
  const service = new BillingService(db as any);
  jest.spyOn(service as any, "usageSnapshot").mockResolvedValue({});
  return { service, statements };
}

describe("paid subscription activation requires a verified payment flow", () => {
  it("blocks a self-service paid upgrade without modifying the subscription", async () => {
    const {service, statements} = serviceFor("100000");
    await expect(service.selectPlan(context, "PRO"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(statements.every(sql => !/UPDATE\s+tenant_subscription/i.test(sql))).toBe(true);
    expect(statements.every(sql => !/INSERT\s+INTO\s+billing_event/i.test(sql))).toBe(true);
  });

  it("allows an idempotent selection of the existing paid tier", async () => {
    const {service, statements} = serviceFor("100000", "PRO");
    await expect(service.selectPlan(context, "PRO"))
      .resolves.toEqual({ selected: true, planCode: "PRO" });
    expect(statements.some(sql => /UPDATE\s+tenant_subscription/i.test(sql))).toBe(false);
  });

  it("allows a free tier selection subject to entitlement limits", async () => {
    const {service, statements} = serviceFor("0");
    await expect(service.selectPlan(context, "PRO"))
      .resolves.toEqual({ selected: true, planCode: "PRO" });
    expect(statements.some(sql => /UPDATE\s+tenant_subscription/i.test(sql))).toBe(true);
  });

  it("rejects malformed plan codes before querying", async () => {
    const {service} = serviceFor("100000");
    await expect(service.selectPlan(context, {} as string))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("tenant subscription security gate", () => {
  it("fails closed when no tenant subscription exists", async () => {
    const statements: string[] = [];
    const db = {
      withTenantTransaction: jest.fn(async (_context: unknown, cb: any) =>
        cb({
          query: jest.fn(async (sql: string) => {
            statements.push(sql);
            return { rows: [], rowCount: 0 };
          })
        }))
    };
    const service = new BillingService(db as any);

    await expect(service.evaluate(context)).resolves.toBe("READ_ONLY");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("FROM tenant_subscription");
    expect(statements.some(sql => /UPDATE\s+(tenant|tenant_subscription)/i.test(sql)))
      .toBe(false);
  });

  it("keeps an unexpired trial active", async () => {
    const statements: string[] = [];
    const db = {
      withTenantTransaction: jest.fn(async (_context: unknown, cb: any) =>
        cb({
          query: jest.fn(async (sql: string) => {
            statements.push(sql);
            if (sql.includes("FROM tenant_subscription")) {
              return { rows: [{
                status: "TRIAL",
                current_period_end: new Date(Date.now() + 86400000),
                grace_until: null
              }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          })
        }))
    };
    const service = new BillingService(db as any);

    await expect(service.evaluate(context)).resolves.toBe("ACTIVE");
    expect(statements.some(sql => /UPDATE\s+tenant_subscription/i.test(sql)))
      .toBe(true);
  });
});
