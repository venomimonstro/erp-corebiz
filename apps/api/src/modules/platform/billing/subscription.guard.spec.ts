import { HttpException } from "@nestjs/common";
import { SubscriptionGuard } from "./subscription.guard";

const session = {
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};

function requestContext(path: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({auth:session,method:"POST",originalUrl:path})
    })
  } as any;
}

describe("read-only subscription renewal path", () => {
  const billing = {evaluate:jest.fn(async () => "READ_ONLY")};
  const guard = new SubscriptionGuard(billing as any);

  it("allows unverified owners to request a confirmation letter",async()=>{
    await expect(guard.canActivate(requestContext(
      "/api/v1/auth/email-verification/request"
    ))).resolves.toBe(true);
  });

  it("allows token confirmation when the account is read-only",async()=>{
    await expect(guard.canActivate(requestContext(
      "/api/v1/auth/email-verification/complete"
    ))).resolves.toBe(true);
  });

  it("allows password reset even if a READ_ONLY session cookie is present",async()=>{
    await expect(guard.canActivate(requestContext(
      "/api/v1/auth/password-reset/complete"
    ))).resolves.toBe(true);
  });

  it("does not block duly authorized platform operators due to tenant billing",async()=>{
    await expect(guard.canActivate(requestContext(
      "/api/v1/platform-operations/tenants/11111111-1111-4111-8111-111111111111/suspension"
    ))).resolves.toBe(true);
    // The operator's session and rights are checked by the protected SQL,
    // not by the billing guard.
  });

  it("rejects malformed platform mutation paths",async()=>{
    await expect(guard.canActivate(requestContext(
      "/api/v1/platform-operations/tenants/x/suspension"
    ))).rejects.toBeInstanceOf(HttpException);
  });

  it("still blocks unrelated writes",async()=>{
    await expect(guard.canActivate(requestContext(
      "/api/v1/sales/orders"
    ))).rejects.toBeInstanceOf(HttpException);
  });

  it("does not accept a prefixed verification lookalike route",async()=>{
    await expect(guard.canActivate(requestContext(
      "/api/v1/auth/email-verification/request-anything"
    ))).rejects.toBeInstanceOf(HttpException);
  });
});
