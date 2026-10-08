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
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ReturnsService } from "./returns.service";

@Controller("returns")
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  @RequirePermission("returns.read")
  async list(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.returns.list(this.context(request)) };
  }

  @Get(":id")
  @RequirePermission("returns.read")
  async details(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.returns.details(this.context(request), id)
    };
  }

  @Post()
  @RequirePermission("returns.manage")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.returns.create(this.context(request), body)
    };
  }

  @Post(":id/authorize")
  @RequirePermission("returns.manage")
  async authorize(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.returns.authorize(this.context(request), id, body);
    return { ok: true, data: { updated: true } };
  }

  @Post(":id/lines/:lineId/receive")
  @RequirePermission("returns.manage")
  async receive(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("lineId") lineId: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.returns.receiveLine(
        this.context(request),
        id,
        lineId,
        body
      )
    };
  }

  @Post(":id/complete")
  @RequirePermission("returns.manage")
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.returns.complete(this.context(request), id);
    return { ok: true, data: { updated: true } };
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
