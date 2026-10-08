import { Body, Controller, Get, Put, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "./require-permission.decorator";
import { RolesService } from "./roles.service";

@Controller("roles")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission("roles.manage")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    const auth = request.auth!;
    const context: TenantContext = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };

    return {
      ok: true,
      data: await this.roles.list(context)
    };
  }

  @Put("assign")
  @RequirePermission("roles.manage")
  async assign(
    @Req() request: AuthenticatedRequest,
    @Body() body: { membershipId: string; roleId: string }
  ): Promise<ApiSuccess<{ assigned: true }>> {
    const auth = request.auth!;
    const context: TenantContext = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };

    await this.roles.assignRole(
      context,
      body.membershipId,
      body.roleId
    );

    return {
      ok: true,
      data: { assigned: true }
    };
  }
}
