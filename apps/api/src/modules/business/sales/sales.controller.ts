import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { SalesService } from "./sales.service";

@Controller("sales/orders")
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  @RequirePermission("sales.read")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sales.list(this.context(request))
    };
  }

  @Post()
  @RequirePermission("sales.write")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      partyId?: string;
      responsibleMembershipId?: string;
      currency?: string;
      notes?: string;
      idempotencyKey?: string;
      inventoryOwnerId?: string;
      lines: Array<{
        skuId?: string;
        description?: string;
        quantityMilli?: string;
        unitPriceMinor?: string;
        discountMinor?: string;
      }>;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sales.create(this.context(request), body)
    };
  }

  @Post("from-deal/:dealId")
  @RequirePermission("sales.write")
  async fromDeal(
    @Req() request: AuthenticatedRequest,
    @Param("dealId") dealId: string,
    @Body() body: { idempotencyKey: string }
  ): Promise<ApiSuccess<unknown>> {
    if (!body.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return {
      ok: true,
      data: await this.sales.createFromDeal(
        this.context(request),
        dealId,
        body.idempotencyKey.trim()
      )
    };
  }

  @Post(":id/reserve")
  @RequirePermission("sales.write")
  async reserve(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { idempotencyKey: string; warehouseId?: string }
  ): Promise<ApiSuccess<unknown>> {
    if (!body.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return {
      ok: true,
      data: await this.sales.reserve(
        this.context(request),
        id,
        body.idempotencyKey.trim(),
        body.warehouseId
      )
    };
  }

  @Post(":id/ship")
  @RequirePermission("sales.write")
  async ship(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { idempotencyKey: string }
  ): Promise<ApiSuccess<unknown>> {
    if (!body.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return {
      ok: true,
      data: await this.sales.ship(
        this.context(request),
        id,
        body.idempotencyKey.trim()
      )
    };
  }

  @Patch(":id/confirm")
  @RequirePermission("sales.write")
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { version: number }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sales.confirm(
        this.context(request),
        id,
        body.version
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
