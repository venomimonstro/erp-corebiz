import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiRateLimitGuard } from "./api-rate-limit.guard";
import { API_COST_CLASS } from "./api-cost.decorator";

describe("ApiRateLimitGuard", () => {
  const redis = {
    incrementWindow: jest.fn(async () => 1),
    acquireSemaphore: jest.fn(async () => true),
    releaseSemaphore: jest.fn(async () => undefined)
  };

  const pressure = {
    deny: jest.fn(async () => {
      throw new Error("DENIED");
    })
  };

  function context(
    metadata: string | undefined,
    requestOverrides: Record<string, unknown> = {}
  ): ExecutionContext {
    const response = {
      once: jest.fn()
    };

    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method: "POST",
          path: "/api/v1/data-management/exports",
          url: "/api/v1/data-management/exports",
          ip: "127.0.0.1",
          auth: {
            tenantId: "tenant-a",
            userId: "user-a",
            membershipId: "membership-a"
          },
          ...requestOverrides
        }),
        getResponse: () => response
      }),
      getHandler: () => ({ metadata }),
      getClass: () => class TestController {}
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses EXPENSIVE metadata and acquires user + tenant semaphores", async () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        expect(key).toBe(API_COST_CLASS);
        return "EXPENSIVE";
      })
    } as unknown as Reflector;

    const guard = new ApiRateLimitGuard(
      redis as any,
      reflector,
      pressure as any
    );

    await expect(
      guard.canActivate(context("EXPENSIVE"))
    ).resolves.toBe(true);

    expect(redis.acquireSemaphore).toHaveBeenCalledTimes(2);
    expect(redis.acquireSemaphore.mock.calls[0]?.[2]).toBe(1);
    expect(redis.acquireSemaphore.mock.calls[1]?.[2]).toBe(2);
  });

  it("records pressure and denies when user semaphore is exhausted", async () => {
    redis.acquireSemaphore.mockResolvedValueOnce(false);

    const reflector = {
      getAllAndOverride: jest.fn(() => "HEAVY")
    } as unknown as Reflector;

    const guard = new ApiRateLimitGuard(
      redis as any,
      reflector,
      pressure as any
    );

    await expect(
      guard.canActivate(context("HEAVY"))
    ).rejects.toThrow("DENIED");

    expect(pressure.deny).toHaveBeenCalledWith(
      {
        tenantId: "tenant-a",
        userId: "user-a",
        membershipId: "membership-a"
      },
      expect.objectContaining({
        reason: "USER_CONCURRENCY_LIMIT",
        limitValue: 2
      })
    );
  });

  it("does not create semaphores for public WEBHOOK traffic", async () => {
    const reflector = {
      getAllAndOverride: jest.fn(() => "WEBHOOK")
    } as unknown as Reflector;

    const guard = new ApiRateLimitGuard(
      redis as any,
      reflector,
      pressure as any
    );

    await expect(
      guard.canActivate(
        context("WEBHOOK", {
          auth: undefined,
          path: "/api/v1/channels/webhook/id/secret/orders"
        })
      )
    ).resolves.toBe(true);

    expect(redis.acquireSemaphore).not.toHaveBeenCalled();
  });
  it("uses one rate bucket for many object ids on the same route",async()=>{
    const reflector={
      getAllAndOverride:jest.fn(()=> "NORMAL")
    } as unknown as Reflector;
    const guard=new ApiRateLimitGuard(redis as any,reflector,pressure as any);
    const first="11111111-1111-4111-8111-111111111111";
    const second="22222222-2222-4222-8222-222222222222";
    await guard.canActivate(context("NORMAL",{
      method:"GET",path:"/api/v1/projects/"+first,
      route:{path:"/api/v1/projects/:projectId"}
    }));
    await guard.canActivate(context("NORMAL",{
      method:"GET",path:"/api/v1/projects/"+second,
      route:{path:"/api/v1/projects/:projectId"}
    }));
    expect(redis.incrementWindow).toHaveBeenCalledTimes(4);
    expect(redis.incrementWindow.mock.calls[0]?.[0])
      .toBe(redis.incrementWindow.mock.calls[2]?.[0]);
    expect(redis.incrementWindow.mock.calls[1]?.[0])
      .toBe(redis.incrementWindow.mock.calls[3]?.[0]);
  });

});
