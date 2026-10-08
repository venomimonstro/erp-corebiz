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
import { MarketingService } from "./marketing.service";

@Controller("analytics/marketing")
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get("connections")
  @RequirePermission("analytics.manage")
  async connections(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.marketing.connections(this.context(request))
    };
  }

  @Post("connections/yandex-direct")
  @RequirePermission("analytics.manage")
  async createYandex(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      name: string;
      oauthToken: string;
      clientLogin?: string;
      externalAccountId?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.marketing.createYandex(
        this.context(request),
        body
      )
    };
  }

  @Post("connections/:id/sync")
  @RequirePermission("analytics.manage")
  async sync(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { from: string; to: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.marketing.requestSync(
        this.context(request),
        id,
        body
      )
    };
  }

  @Get("jobs")
  @RequirePermission("analytics.manage")
  async jobs(
    @Req() request: AuthenticatedRequest,
    @Query("connectionId") connectionId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.marketing.jobs(
        this.context(request),
        connectionId
      )
    };
  }

  @Get("stats")
  @RequirePermission("analytics.read")
  async stats(
    @Req() request: AuthenticatedRequest,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.marketing.stats(
        this.context(request),
        { from, to }
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
