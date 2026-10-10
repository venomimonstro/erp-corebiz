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
import { ApiCost } from "../../../infrastructure/http/api-cost.decorator";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ProfitabilityService } from "./profitability.service";

@Controller("analytics/profitability")
export class ProfitabilityController {
  constructor(
    private readonly profitability: ProfitabilityService
  ) {}

  @Get()
  @ApiCost("HEAVY")
  @RequirePermission("analytics.read")
  async dashboard(
    @Req() request: AuthenticatedRequest,
    @Query("model") model?: any,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.profitability.dashboard(
        this.context(request),
        { model, from, to }
      )
    };
  }

  @Post("campaigns/:id/aliases")
  @RequirePermission("analytics.manage")
  async alias(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      type?: "UTM_CAMPAIGN" | "MANUAL";
      value: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.profitability.addAlias(
        this.context(request),
        id,
        body
      )
    };
  }

  @Post("alerts/rules")
  @RequirePermission("analytics.manage")
  async createRule(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.profitability.createAlertRule(
        this.context(request),
        body
      )
    };
  }

  @Post("alerts/evaluate")
  @ApiCost("EXPENSIVE")
  @RequirePermission("analytics.manage")
  async evaluate(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.profitability.evaluateAlerts(
        this.context(request)
      )
    };
  }

  @Get("alerts")
  @RequirePermission("analytics.read")
  async alerts(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.profitability.alerts(
        this.context(request)
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
