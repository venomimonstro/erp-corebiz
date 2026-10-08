import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  Res
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { Public } from "../../platform/auth/public.decorator";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { TrackerService } from "./tracker.service";

@Controller("tracker")
export class TrackerController {
  constructor(private readonly tracker: TrackerService) {}

  @Get("sites")
  @RequirePermission("analytics.manage")
  async sites(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tracker.listSites(this.context(request))
    };
  }

  @Post("sites")
  @RequirePermission("analytics.manage")
  async createSite(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      name: string;
      allowedDomains?: string[];
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tracker.createSite(this.context(request), body)
    };
  }

  @Post("sites/rotate")
  @RequirePermission("analytics.manage")
  async rotate(
    @Req() request: AuthenticatedRequest,
    @Body() body: { siteId: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tracker.rotateKey(
        this.context(request),
        body.siteId
      )
    };
  }

  @Public()
  @Post("collect")
  async collect(
    @Req() request: any,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tracker.collect(body, {
        origin: request.headers?.origin
      })
    };
  }

  @Get("summary")
  @RequirePermission("analytics.read")
  async summary(
    @Req() request: AuthenticatedRequest,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tracker.summary(this.context(request), from, to)
    };
  }

  @Public()
  @Get("script.js")
  @Header("Cache-Control", "public, max-age=300")
  async script(
    @Query("key") key: string,
    @Res() response: Response
  ): Promise<void> {
    response.type("application/javascript");
    response.send(this.tracker.snippet(key));
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
