import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { CapabilityGuard } from "./capability.guard";

describe("CapabilityGuard", () => {
  const auth = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    membershipId: "33333333-3333-3333-3333-333333333333"
  };

  function executionContext(request: any): ExecutionContext {
    return {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({
        getRequest: () => request
      })
    } as unknown as ExecutionContext;
  }

  function guard(permission: string | undefined, enabled?: boolean) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(permission)
    };
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: enabled === undefined ? [] : [{ enabled }]
      })
    };
    const database = {
      withTenantTransaction: jest.fn(
        async (_context: unknown, callback: (client: any) => unknown) =>
          callback(client)
      )
    };

    return {
      guard: new CapabilityGuard(reflector as any, database as any),
      reflector,
      client,
      database
    };
  }

  it("allows routes without mapped business capability", async () => {
    const subject = guard("platform.settings.manage", false);
    await expect(
      subject.guard.canActivate(executionContext({ auth }))
    ).resolves.toBe(true);
    expect(subject.database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("allows an enabled module", async () => {
    const subject = guard("finance.write", true);
    await expect(
      subject.guard.canActivate(executionContext({ auth }))
    ).resolves.toBe(true);
  });

  it("blocks an explicitly disabled module", async () => {
    const subject = guard("service.write", false);
    await expect(
      subject.guard.canActivate(executionContext({ auth }))
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("keeps a missing legacy capability row enabled", async () => {
    const subject = guard("projects.read");
    await expect(
      subject.guard.canActivate(executionContext({ auth }))
    ).resolves.toBe(true);
  });

  it("maps returns permissions to the OMS capability", async () => {
    const subject = guard("returns.read", false);
    await expect(
      subject.guard.canActivate(executionContext({ auth }))
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(subject.client.query).toHaveBeenCalledWith(
      expect.any(String),
      [auth.tenantId, "oms"]
    );
  });
});
