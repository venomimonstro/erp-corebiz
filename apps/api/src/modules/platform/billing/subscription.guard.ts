import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import type { Request } from "express";
import type { TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { BillingService } from "./billing.service";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly billing: BillingService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request =
      context.switchToHttp().getRequest<AuthenticatedRequest & Request>();

    if (!request.auth) return true;

    const tenantContext: TenantContext = {
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      membershipId: request.auth.membershipId
    };

    const state = await this.billing.evaluate(tenantContext);

    if (state !== "READ_ONLY") return true;
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const path = request.originalUrl || request.url;
    if (path.includes("/api/v1/billing")) return true;
    // A suspended customer must be able to pay and restore the workspace.
    if (path.startsWith("/api/v1/payments/saas/")) return true;
    if (path.includes("/api/v1/auth/logout")) return true;
    if (path.includes("/api/v1/auth/switch-tenant")) return true;
    // READ_ONLY accounts must still be able to prove ownership of their
    // email before paying to reactivate. Match only the intended endpoints.
    const cleanPath = path.split("?")[0];
    // Tenant subscription of an operator's own workspace does not control
    // platform administration. The SQL function authenticates the operator
    // again against the session and the dedicated platform_operator registry.
    if (/^\/api\/v1\/platform-operations\/tenants\/[0-9a-f-]{36}\/suspension$/i.test(cleanPath))
      return true;
    if (cleanPath === "/api/v1/auth/email-verification/request" ||
        cleanPath === "/api/v1/auth/email-verification/complete" ||
        cleanPath === "/api/v1/auth/password-reset/request" ||
        cleanPath === "/api/v1/auth/password-reset/complete") return true;

    throw new HttpException(
      "Рабочее пространство доступно только для чтения. Обновите подписку.",
      HttpStatus.PAYMENT_REQUIRED
    );
  }
}
