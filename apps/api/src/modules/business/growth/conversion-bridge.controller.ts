import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { Public } from "../../platform/auth/public.decorator";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ConversionBridgeService } from "./conversion-bridge.service";

@Controller("analytics/conversions")
export class ConversionBridgeController {
  constructor(
    private readonly bridge: ConversionBridgeService
  ) {}

  @Get("calltracking/connections")
  @RequirePermission("analytics.read")
  async callConnections(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.callConnections(this.context(request))
    };
  }

  @Post("calltracking/connections")
  @RequirePermission("analytics.manage")
  async createCallConnection(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.createCallConnection(
        this.context(request),
        body
      )
    };
  }

  @Public()
  @Post("calltracking/webhook/:connectionId/:secret")
  async callWebhook(
    @Param("connectionId") connectionId: string,
    @Param("secret") secret: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.ingestCall(
        connectionId,
        secret,
        body
      )
    };
  }

  @Get("calls")
  @RequirePermission("analytics.read")
  async calls(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.calls(this.context(request))
    };
  }

  @Get("offline/connections")
  @RequirePermission("analytics.read")
  async offlineConnections(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.offlineConnections(this.context(request))
    };
  }

  @Post("offline/connections/yandex-metrica")
  @RequirePermission("analytics.manage")
  async createMetrica(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.createYandexMetrica(
        this.context(request),
        body
      )
    };
  }

  @Post("offline/connections/:id/queue")
  @RequirePermission("analytics.manage")
  async queue(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { model?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.queueOfflineConversions(
        this.context(request),
        id,
        body.model
      )
    };
  }

  @Get("offline/jobs")
  @RequirePermission("analytics.read")
  async jobs(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.bridge.offlineJobs(this.context(request))
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
