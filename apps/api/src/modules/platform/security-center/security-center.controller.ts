import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { SecurityCenterService } from "./security-center.service";

@Controller("security-center")
export class SecurityCenterController {
  constructor(private readonly security: SecurityCenterService) {}

  @Get("audit")
  @RequirePermission("audit.read")
  async audit(
    @Req() request: AuthenticatedRequest,
    @Query("action") action?: string,
    @Query("resourceType") resourceType?: string,
    @Query("resourceId") resourceId?: string,
    @Query("actorMembershipId") actorMembershipId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.security.audit(this.context(request), {
        action,
        resourceType,
        resourceId,
        actorMembershipId,
        from,
        to,
        limit: limit ? Number(limit) : undefined
      })
    };
  }

  @Get("sessions")
  async sessions(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    const auth = request.auth!;
    return {
      ok: true,
      data: await this.security.sessions(
        this.context(request),
        auth.sessionId
      )
    };
  }

  @Post("sessions/:id/revoke")
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    const auth = request.auth!;
    return {
      ok: true,
      data: await this.security.revokeSession(
        this.context(request),
        auth.sessionId,
        id
      )
    };
  }

  @Post("sessions/revoke-others")
  async revokeOthers(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    const auth = request.auth!;
    return {
      ok: true,
      data: await this.security.revokeOthers(
        this.context(request),
        auth.sessionId
      )
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
