import {
  Body,
  Controller,
  Get,
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
    @Body() body: {
      trackerKey: string;
      visitorId: string;
      partyId: string;
      source?:
        | "MANUAL"
        | "FORM"
        | "CHECKOUT"
        | "BOOKING"
        | "CALL"
        | "IMPORT"
        | "API";
      confidence?: number;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.attribution.linkVisitor(
        this.context(request),
        body
      )
    };
  }

  @Get("results")
  @RequirePermission("analytics.read")
  async results(
    @Req() request: AuthenticatedRequest,
    @Query("model") model:
      | "FIRST_TOUCH"
      | "LAST_TOUCH"
      | "LAST_NON_DIRECT"
      | "LINEAR" = "LAST_NON_DIRECT",
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.attribution.attribution(
        this.context(request),
        { model, from, to }
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
