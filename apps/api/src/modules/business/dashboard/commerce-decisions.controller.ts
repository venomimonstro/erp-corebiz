import { Controller, Get, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { CommerceDecisionsService, type CommerceSnapshot } from "./commerce-decisions.service";

@Controller("dashboard/commerce")
export class CommerceDecisionsController {
  constructor(private readonly commerce: CommerceDecisionsService) {}

  @Get()
  @RequirePermission("dashboard.owner.read")
  async snapshot(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<CommerceSnapshot>> {
    const a = request.auth!;
    const context: TenantContext = {
      tenantId: a.tenantId,
      membershipId: a.membershipId,
      userId: a.userId
    };
    return { ok: true, data: await this.commerce.snapshot(context) };
  }
}
