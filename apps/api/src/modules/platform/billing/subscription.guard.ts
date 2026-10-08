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
    if (path.includes("/api/v1/auth/logout")) return true;
    if (path.includes("/api/v1/auth/switch-tenant")) return true;

    throw new HttpException(
      "Рабочее пространство доступно только для чтения. Обновите подписку.",
      HttpStatus.PAYMENT_REQUIRED
    );
  }
}
