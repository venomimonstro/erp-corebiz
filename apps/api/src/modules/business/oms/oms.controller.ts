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
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { OmsService } from "./oms.service";

@Controller("oms")
export class OmsController {
  constructor(private readonly oms: OmsService) {}

  @Get("orders")
  @RequirePermission("oms.read")
  async list(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.oms.list(this.context(request)) };
  }

  @Post("orders")
  @RequirePermission("oms.manage")
  async ensure(
    @Req() request: AuthenticatedRequest,
    @Body() body: { salesOrderId: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.oms.ensureOrder(
        this.context(request),
        body.salesOrderId
      )
    };
  }

  @Get("orders/:id")
  @RequirePermission("oms.read")
  async details(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.oms.orderDetails(this.context(request), id)
    };
  }

  @Post("orders/:id/allocate")
  @RequirePermission("oms.manage")
  async allocate(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.oms.allocate(this.context(request), id)
    };
  }

  @Post("orders/:id/fulfillment")
  @RequirePermission("oms.manage")
  async fulfillment(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.oms.markFulfillment(this.context(request), id);
    return { ok: true, data: { updated: true } };
  }

  @Post("orders/:id/shipped")
  @RequirePermission("oms.manage")
  async shipped(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.oms.markShipped(this.context(request), id);
    return { ok: true, data: { updated: true } };
  }

  @Get("backorders")
  @RequirePermission("oms.read")
  async backorders(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.oms.backorders(this.context(request))
    };
  }

  @Patch("backorders/:id")
  @RequirePermission("oms.manage")
  async updateBackorder(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { expectedAt?: string | null; cancel?: boolean }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.oms.updateBackorder(this.context(request), id, body);
    return { ok: true, data: { updated: true } };
  }

  @Get("atp")
  @RequirePermission("oms.read")
  async atp(
    @Req() request: AuthenticatedRequest,
    @Query("skuId") skuId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.oms.atp(this.context(request), skuId)
    };
  }

  @Post("policies")
  @RequirePermission("oms.manage")
  async policy(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.oms.setPolicy(this.context(request), body);
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
