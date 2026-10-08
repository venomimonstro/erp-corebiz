import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { Public } from "../../platform/auth/public.decorator";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { Wms3plPortalService } from "./wms-3pl-portal.service";

@Controller("wms/3pl-portal")
export class Wms3plPortalController {
  constructor(private readonly portal: Wms3plPortalService) {}

  @Get("accesses")
  @RequirePermission("wms.manage")
  async accesses(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.portal.accesses(this.context(request))
    };
  }

  @Post("owners/:ownerId/accesses")
  @RequirePermission("wms.manage")
  async create(
    @Req() request: AuthenticatedRequest,
    @Param("ownerId") ownerId: string,
    @Body() body: { label?: string; expiresAt?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.portal.createAccess(
        this.context(request),
        ownerId,
        body
      )
    };
  }

  @Post("accesses/:id/revoke")
  @RequirePermission("wms.manage")
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ revoked: true }>> {
    await this.portal.revoke(this.context(request), id);
    return { ok: true, data: { revoked: true } };
  }

  @Public()
  @Get("public/overview")
  async publicOverview(
    @Headers("authorization") authorization?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.portal.portalOverview(
        this.token(authorization)
      )
    };
  }

  @Public()
  @Get("public/statements/:id")
  async publicStatement(
    @Param("id") id: string,
    @Headers("authorization") authorization?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.portal.portalStatement(
        this.token(authorization),
        id
      )
    };
  }

  private token(authorization?: string): string {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() ?? "";
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
