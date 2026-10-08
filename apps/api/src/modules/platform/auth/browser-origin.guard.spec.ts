import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { BrowserOriginGuard } from "./browser-origin.guard";

jest.mock("../../../infrastructure/config/env", () => ({
  getEnv: () => ({ nodeEnv: "production", webOrigin: "https://app.example" })
}));

function context(method: string, path: string, origin?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method, path, headers: origin === undefined ? {} : { origin }
      })
    }),
    getHandler: () => (() => undefined),
    getClass: () => class Stub {}
  } as unknown as ExecutionContext;
}

function guard(isPublic: boolean) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic)
  } as unknown as Reflector;
  return new BrowserOriginGuard(reflector);
}

describe("BrowserOriginGuard", () => {
  it("rejects an authenticated mutation without Origin in production", () => {
    expect(() => guard(false).canActivate(context("POST", "/api/v1/finance/accounts")))
      .toThrow(ForbiddenException);
  });

  it("rejects cross-site login despite @Public", () => {
    expect(() => guard(true).canActivate(context("POST", "/api/v1/auth/login", "https://evil.example")))
      .toThrow(ForbiddenException);
  });

  it("allows same-origin authenticated mutation", () => {
    expect(guard(false).canActivate(context("POST", "/api/v1/finance/accounts", "https://app.example")))
      .toBe(true);
  });

  it("accepts a signed public webhook without browser Origin", () => {
    expect(guard(true).canActivate(context("POST", "/api/v1/channels/webhook/a/b/orders")))
      .toBe(true);
  });

  it("does not exempt internal endpoints even if decorated public", () => {
    expect(() => guard(true).canActivate(context("POST", "/api/v1/finance/sales-payment")))
      .toThrow(ForbiddenException);
  });

  it("allows public external tracker collection", () => {
    expect(guard(true).canActivate(context("POST", "/api/v1/tracker/collect", "https://merchant.example")))
      .toBe(true);
  });

  it("does not require Origin for safe reads", () => {
    expect(guard(false).canActivate(context("GET", "/api/v1/finance/summary")))
      .toBe(true);
  });
});
