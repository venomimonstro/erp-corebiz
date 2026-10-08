import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Response } from "express";
import { TenantContextService } from "../tenant-context/tenant-context.service";
import { AuthService } from "./auth.service";
import type { AuthenticatedRequest } from "./auth.types";
import { parseCookie, SESSION_COOKIE } from "./auth.utils";

@Injectable()
export class SessionContextMiddleware implements NestMiddleware {
  constructor(
    private readonly authService: AuthService,
    private readonly tenantContext: TenantContextService
  ) {}

  async use(
    request: AuthenticatedRequest,
    _response: Response,
    next: NextFunction
  ): Promise<void> {
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);

    if (!token) {
      next();
      return;
    }

    const auth = await this.authService.resolveSession(token);

    if (!auth) {
      next();
      return;
    }

    request.auth = auth;

    this.tenantContext.run(
      {
        tenantId: auth.tenantId,
        userId: auth.userId,
        membershipId: auth.membershipId
      },
      next
    );
  }
}
