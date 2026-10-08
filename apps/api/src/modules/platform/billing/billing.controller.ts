import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { BillingService } from "./billing.service";

@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("plans")
  async plans(): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.billing.plans() };
  }

  @Get("current")
  async current(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.billing.current(this.context(request))
    };
  }

  @Post("select-plan")
  @RequirePermission("billing.manage")
  async selectPlan(
    @Req() request: AuthenticatedRequest,
    @Body() body: { planCode: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.billing.selectPlan(
        this.context(request),
        body.planCode
      )
    };
  }

  @Post("cancel-at-period-end")
  @RequirePermission("billing.manage")
  async cancelAtPeriodEnd(
    @Req() request: AuthenticatedRequest,
    @Body() body: { value: boolean }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.billing.setCancelAtPeriodEnd(
      this.context(request),
      Boolean(body.value)
    );
    return { ok: true, data: { updated: true } };
  }

  private context(request: AuthenticatedRequest): TenantContext {
    const auth = request.auth!;
    return {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };
  }
}
