import { ConflictException, BadRequestException } from "@nestjs/common";
import { StorefrontService } from "./storefront.service";
import { SiteFormsService } from "./site-forms.service";

const context = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333"
};

const cart = {
  cart_id: "44444444-4444-4444-8444-444444444444",
  tenant_id: context.tenantId,
  site_id: "55555555-5555-4555-8555-555555555555",
  status: "OPEN",
  sales_order_id: null,
  expires_at: new Date(Date.now() + 60000)
};

describe("public commerce safeguards", () => {
  it("rejects malformed public cart input before querying the database", async () => {
    const database = { withTenantTransaction: jest.fn(), query: jest.fn() };
    const service = new StorefrontService(database as any, {} as any, {} as any, {} as any);
    await expect(service.setLine("key", null as any))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setLine("key", { skuId: {}, quantityMilli: 1000 } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.checkout("key", { idempotencyKey: ["x"], name: "John", email: "a@b.test" } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.checkout("key", { idempotencyKey: "x", name: "John", email: [] } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.configure(context, cart.site_id, { enabled: "false" } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it("rejects malformed site submissions and form configuration before SQL", async () => {
    const database = { query: jest.fn(), withTenantTransaction: jest.fn() };
    const service = new SiteFormsService(database as any, {} as any, {} as any, {} as any, {} as any);
    await expect(service.submit("form", null as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.submit("form", { idempotencyKey: { x: 1 }, name: "John" } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createBinding(context, cart.site_id,
      { name: "Book", action: "BOOKING", serviceId: "a", resourceIds: {} } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("rejects cart edits when checkout owns the cart row", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) {
        return {
          rows: [{ status: "PROCESSING", expires_at: cart.expires_at }],
          rowCount: 1
        };
      }
      throw new Error("unexpected query after locked cart conflict");
    });
    const database = {
      withTenantTransaction: jest.fn(async (_context: unknown, callback: any) =>
        callback({ query })
      )
    };
    const service = new StorefrontService(
      database as any,
      {} as any,
      {} as any,
      {} as any
    );
    jest.spyOn(service as any, "resolveCart").mockResolvedValue(cart);

    await expect(
      service.setLine("cart_key", {
        skuId: "66666666-6666-4666-8666-666666666666",
        quantityMilli: "1000"
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("FOR UPDATE");
  });

  it("does not create a customer when a checkout lease is already held", async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = {
      withTenantTransaction: jest.fn(async (_context: unknown, callback: any) =>
        callback({ query })
      )
    };
    const parties = { create: jest.fn() };
    const sales = { create: jest.fn(), confirm: jest.fn() };
    const service = new StorefrontService(
      database as any,
      parties as any,
      sales as any,
      {} as any
    );
    jest.spyOn(service as any, "resolveCart").mockResolvedValue(cart);

    await expect(
      service.checkout("cart_key", {
        idempotencyKey: "attempt-one",
        name: "Тестовый покупатель",
        phone: "+79990000000"
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(parties.create).not.toHaveBeenCalled();
    expect(sales.create).not.toHaveBeenCalled();
    expect(sales.confirm).not.toHaveBeenCalled();
  });

  it("retains the checkout lease if Sales fails after Party was created", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("SET status='PROCESSING'")) {
        return {
          rows: [{ checkout_party_id: null, sales_order_id: null }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM storefront_config c")) {
        return {
          rows: [{
            responsible_membership_id: context.membershipId,
            currency: "RUB",
            user_id: context.userId
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM storefront_cart_line l")) {
        return {
          rows: [{
            sku_id: "66666666-6666-4666-8666-666666666666",
            quantity_milli: "1000"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("SET checkout_party_id=")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error("Unexpected SQL in checkout mock: " + sql);
    });
    const database = {
      withTenantTransaction: jest.fn(async (_context: unknown, callback: any) =>
        callback({ query })
      )
    };
    const parties = {
      create: jest.fn().mockResolvedValue({
        id: "77777777-7777-4777-8777-777777777777"
      })
    };
    const sales = {
      create: jest.fn().mockRejectedValue(new Error("SALES_TEMPORARY_ERROR")),
      confirm: jest.fn()
    };
    const service = new StorefrontService(
      database as any, parties as any, sales as any, {} as any
    );
    jest.spyOn(service as any, "resolveCart").mockResolvedValue(cart);

    await expect(service.checkout("cart_key", {
      idempotencyKey: "retry-1",
      name: "Клиент",
      phone: "+79990000000"
    })).rejects.toThrow("SALES_TEMPORARY_ERROR");

    expect(parties.create).toHaveBeenCalledTimes(1);
    expect(sales.create).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status='OPEN'")
    )).toBe(false);
  });

  it("reopens the cart only when failure happens before domain writes", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("SET status='PROCESSING'")) {
        return {
          rows: [{ checkout_party_id: null, sales_order_id: null }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM storefront_config c")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SET status='OPEN'")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error("Unexpected SQL in pre-domain checkout mock");
    });
    const database = {
      withTenantTransaction: jest.fn(async (_context: unknown, callback: any) =>
        callback({ query })
      )
    };
    const parties = { create: jest.fn() };
    const sales = { create: jest.fn(), confirm: jest.fn() };
    const service = new StorefrontService(
      database as any, parties as any, sales as any, {} as any
    );
    jest.spyOn(service as any, "resolveCart").mockResolvedValue(cart);

    await expect(service.checkout("cart_key", {
      idempotencyKey: "retry-2",
      name: "Клиент",
      phone: "+79990000000"
    })).rejects.toBeInstanceOf(ConflictException);

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status='OPEN'")
    )).toBe(true);
    expect(parties.create).not.toHaveBeenCalled();
    expect(sales.create).not.toHaveBeenCalled();
  });

  it("rejects public booking bindings with no authorized resources", async () => {
    const database = {
      withTenantTransaction: jest.fn()
    };
    const service = new SiteFormsService(
      database as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    await expect(
      service.createBinding(context, cart.site_id, {
        name: "Онлайн-запись",
        action: "BOOKING",
        serviceId: "77777777-7777-4777-8777-777777777777",
        resourceIds: []
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
