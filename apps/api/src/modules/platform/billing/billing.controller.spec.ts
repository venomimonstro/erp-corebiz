import { BadRequestException } from "@nestjs/common";
import { BillingController } from "./billing.controller";

describe("billing cancellation request", () => {
  const request = { auth: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    membershipId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333"
  } };
  it("rejects string false instead of accidentally enabling cancellation", async () => {
    const service = { setCancelAtPeriodEnd: jest.fn() };
    const controller = new BillingController(service as any);
    await expect(controller.cancelAtPeriodEnd(request as any, {value:"false"} as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(service.setCancelAtPeriodEnd).not.toHaveBeenCalled();
  });
  it("honors explicit false", async () => {
    const service = { setCancelAtPeriodEnd: jest.fn(async () => undefined) };
    const controller = new BillingController(service as any);
    await controller.cancelAtPeriodEnd(request as any, {value:false});
    expect(service.setCancelAtPeriodEnd).toHaveBeenCalledWith(
      expect.objectContaining({tenantId:request.auth.tenantId}), false);
  });
});
