import { ConflictException } from "@nestjs/common";
import { FinanceService } from "./finance.service";

const context = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333"
};
const originalPayment = {
  id: "44444444-4444-4444-8444-444444444444",
  business_number: "PAY-001",
  source_type: "SALES_ORDER",
  source_id: "55555555-5555-4555-8555-555555555555",
  amount_minor: "15000",
  direction: "IN",
  kind: "PAYMENT",
  cash_account_id: "66666666-6666-4666-8666-666666666666"
};

describe("payment retry safety", () => {
  function fixture() {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return {rows:[],rowCount:1};
      if (sql.includes("FROM payment") && sql.includes("idempotency_key")) {
        return {rows:[originalPayment],rowCount:1};
      }
      if (sql.includes("FROM sales_order") && sql.includes("payment_status")) {
        return {rows:[{payment_status:"PAID"}],rowCount:1};
      }
      throw new Error("unexpected query: " + sql);
    });
    const database = {
      withTenantTransaction: jest.fn(async (_ctx:unknown, cb:any) => cb({query}))
    };
    // Retry path uses no collaborators beyond the DB.
    return {query, service: new FinanceService(
      database as any, {} as any, {} as any
    )};
  }

  it("allows an exact retry without reposting money", async () => {
    const {service,query} = fixture();
    const result=await service.receiveSalesPayment(context, {
      orderId:originalPayment.source_id, amountMinor:"15000",
      idempotencyKey:"same-key"
    });
    expect(result.paymentId).toBe(originalPayment.id);
    expect(result.paymentStatus).toBe("PAID");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects reusing a payment key for another order", async () => {
    const {service,query}=fixture();
    await expect(service.receiveSalesPayment(context, {
      orderId:"77777777-7777-4777-8777-777777777777",
      amountMinor:"15000",idempotencyKey:"same-key"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects changed amount and payment/refund type for same key", async () => {
    const {service}=fixture();
    await expect(service.receiveSalesPayment(context, {
      orderId:originalPayment.source_id,
      amountMinor:"16000",idempotencyKey:"same-key"
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.refundSalesPayment(context, {
      orderId:originalPayment.source_id,
      amountMinor:"15000",idempotencyKey:"same-key"
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
