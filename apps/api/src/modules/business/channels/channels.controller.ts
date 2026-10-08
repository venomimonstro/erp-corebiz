import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { Public } from "../../platform/auth/public.decorator";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ChannelsService } from "./channels.service";

@Controller("channels")
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get("connections")
  @RequirePermission("channels.read")
  async connections(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.connections(this.context(request))
    };
  }

  @Post("connections")
  @RequirePermission("channels.manage")
  async createConnection(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.createConnection(
        this.context(request),
        body
      )
    };
  }

  @Public()
  @Post("webhook/:connectionId/:secret/orders")
  async webhookOrder(
    @Param("connectionId") connectionId: string,
    @Param("secret") secret: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.ingestOrder(
        connectionId,
        secret,
        body
      )
    };
  }

  @Get("inbox")
  @RequirePermission("channels.read")
  async inbox(
    @Req() request: AuthenticatedRequest,
    @Query("status") status?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.inbox(
        this.context(request),
        status
      )
    };
  }

  @Get("inbox/:id")
  @RequirePermission("channels.read")
  async inboxOrder(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.inboxOrder(
        this.context(request),
        id
      )
    };
  }

  @Post("connections/:id/mappings")
  @RequirePermission("channels.manage")
  async mapping(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.channels.mapOffer(
      this.context(request),
      id,
      body
    );
    return { ok: true, data: { updated: true } };
  }

  @Post("inbox/:id/import")
  @RequirePermission("channels.manage")
  async importOrder(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.importOrder(
        this.context(request),
        id
      )
    };
  }

  @Patch("inbox/:id/ignore")
  @RequirePermission("channels.manage")
  async ignore(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ ignored: true }>> {
    await this.channels.ignore(this.context(request), id);
    return { ok: true, data: { ignored: true } };
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
