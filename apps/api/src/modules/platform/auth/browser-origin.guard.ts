import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { getEnv } from "../../../infrastructure/config/env";
import { PUBLIC_ROUTE } from "./public.decorator";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// These routes are explicitly public and receive calls from other sites,
// bank/marketplace integrations, or native clients. They must independently
// validate their public keys/tokens, validate payloads and apply rate limits.
// Do not exempt authenticated routes, login or registration.
const EXTERNAL_PUBLIC_MUTATIONS: ReadonlyArray<RegExp> = [
  /^\/api\/v1\/channels\/webhook\/[^/]+\/[^/]+\/orders\/?$/,
  /^\/api\/v1\/analytics\/conversions\/calltracking\/webhook\/[^/]+\/[^/]+\/?$/,
  /^\/api\/v1\/tracker\/collect\/?$/,
  /^\/api\/v1\/site-forms\/submit\/[^/]+\/?$/,
  /^\/api\/v1\/storefront\/[^/]+\/carts\/?$/,
  /^\/api\/v1\/storefront\/carts\/[^/]+\/lines\/?$/,
  /^\/api\/v1\/storefront\/carts\/[^/]+\/checkout\/?$/,
  /^\/api\/v1\/wms\/3pl-requests\/public\/create\/?$/,
  /^\/api\/v1\/wms\/3pl-requests\/public\/[^/]+\/reply\/?$/
];

@Injectable()
export class BrowserOriginGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass()
    ]);
    const path = request.path || request.url?.split("?")[0] || "";

    if (
      isPublic &&
      EXTERNAL_PUBLIC_MUTATIONS.some((pattern) => pattern.test(path))
    ) {
      return true;
    }

    const env = getEnv();
    const origin = request.headers.origin;

    // Authenticated browser mutations (and login/register) remain fail-closed
    // in production when Origin is absent or different from WEB_ORIGIN.
    if (!origin && env.nodeEnv !== "production") return true;
    if (origin !== env.webOrigin) {
      throw new ForbiddenException("Недопустимый источник запроса");
    }

    return true;
  }
}
