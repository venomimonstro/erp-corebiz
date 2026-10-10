import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("workspace")
  async workspace(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.dashboard.memberWorkspace(this.context(request))
    };
  }

  @Get("activation")
  @RequirePermission("dashboard.owner.read")
  async activation(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.dashboard.activation(this.context(request))
    };
  }

  @Patch("activation/dismiss")
  @RequirePermission("dashboard.owner.read")
  async dismissActivation(
    @Req() request: AuthenticatedRequest,
    @Body() body: { dismissed: boolean }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.dashboard.dismissActivation(
      this.context(request),
      Boolean(body.dismissed)
    );
    return { ok: true, data: { updated: true } };
  }

  @Get("operational")
  @RequirePermission("dashboard.owner.read")
  async operational(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.dashboard.operational(this.context(request))
    };
  }

  @Get("owner")
  @RequirePermission("dashboard.owner.read")
  async owner(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.dashboard.owner(this.context(request))
    };
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
