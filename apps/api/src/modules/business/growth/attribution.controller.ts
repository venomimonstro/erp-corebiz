import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { AttributionService } from "./attribution.service";

@Controller("analytics/attribution")
export class AttributionController {
  constructor(private readonly attribution: AttributionService) {}

  @Post("link")
  @RequirePermission("analytics.manage")
  async link(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.attribution.linkVisitor(
        this.context(request),
        body
      )
    };
  }

  @Post("recalculate")
  @RequirePermission("analytics.manage")
  async recalculate(
    @Req() request: AuthenticatedRequest,
    @Body() body: { partyId?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.attribution.recalculate(
        this.context(request),
        body.partyId
      )
    };
  }

  @Get("results")
  @RequirePermission("analytics.read")
  async results(
    @Req() request: AuthenticatedRequest,
    @Query("model") model = "LAST_PAID_TOUCH",
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.attribution.results(
        this.context(request),
        model as any,
        from,
        to
      )
    };
  }

  @Get("party/:id")
  @RequirePermission("analytics.read")
  async journey(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.attribution.journey(
        this.context(request),
        id
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
