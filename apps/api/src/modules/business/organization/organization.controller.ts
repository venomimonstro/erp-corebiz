import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { OrganizationService } from "./organization.service";

@Controller("organization")
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get()
  @RequirePermission("organization.read")
  async overview(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.organization.overview(this.context(request))
    };
  }

  @Post("legal-entities")
  @RequirePermission("organization.write")
  async createLegalEntity(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string; inn?: string; kpp?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.organization.createLegalEntity(this.context(request), body)
    };
  }

  @Post("branches")
  @RequirePermission("organization.write")
  async createBranch(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string; legalEntityId?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.organization.createBranch(this.context(request), body)
    };
  }

  @Post("teams")
  @RequirePermission("organization.write")
  async createTeam(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string; branchId?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.organization.createTeam(this.context(request), body)
    };
  }

  @Post("teams/assign")
  @RequirePermission("users.manage")
  async assignTeam(
    @Req() request: AuthenticatedRequest,
    @Body() body: { teamId: string; membershipId: string }
  ): Promise<ApiSuccess<{ assigned: true }>> {
    await this.organization.assignTeam(
      this.context(request),
      body.teamId,
      body.membershipId
    );

    return { ok: true, data: { assigned: true } };
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
