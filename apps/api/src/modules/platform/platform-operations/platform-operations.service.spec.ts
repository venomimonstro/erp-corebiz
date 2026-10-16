import { ForbiddenException } from "@nestjs/common";
import { PlatformOperationsService } from "./platform-operations.service";

const id = "11111111-1111-4111-8111-111111111111";
const token = "long-secret-session-token";

describe("platform operator read-only access", () => {
  it("blocks anonymous operator dashboard", async () => {
    const db = { query: jest.fn() };
    const service = new PlatformOperationsService(db as any);
    await expect(service.tenants(id, undefined, 25, 0))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not pass raw session token to SQL", async () => {
    const db = {
      query: jest.fn(async () => ({
        rows: [{overview:{total:0,items:[]}}]
      }))
    };
    const service = new PlatformOperationsService(db as any);
    const result = await service.tenants(id, token, 25, 0);
    expect(result).toEqual({total:0,items:[]});
    const params = db.query.mock.calls[0]?.[1] as unknown[];
    expect(params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[1]).not.toBe(token);
  });

  it("denies explicit DB permission errors", async () => {
    const db = {
      query: jest.fn(async () => {
        throw Object.assign(new Error("PLATFORM_OPERATOR_FORBIDDEN"), {
          code: "42501"
        });
      })
    };
    const service = new PlatformOperationsService(db as any);
    await expect(service.tenants(id, token, 25, 0))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
