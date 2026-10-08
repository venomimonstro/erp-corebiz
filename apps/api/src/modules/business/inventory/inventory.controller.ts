import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { InventoryService } from "./inventory.service";

@Controller("inventory")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("warehouses")
  @RequirePermission("inventory.read")
  async warehouses(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.listWarehouses(this.context(request))
    };
  }

  @Post("warehouses")
  @RequirePermission("inventory.write")
  async createWarehouse(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string; code?: string; branchId?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.createWarehouse(this.context(request), body)
    };
  }

  @Get("balances")
  @RequirePermission("inventory.read")
  async balances(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.balances(this.context(request))
    };
  }

  @Post("adjustments")
  @RequirePermission("inventory.write")
  async adjust(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      warehouseId: string;
      skuId: string;
      quantityDeltaMilli: string;
      reason: string;
      idempotencyKey: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.adjust(this.context(request), body)
    };
  }

  @Post("reserve-order")
  @RequirePermission("inventory.write")
  async reserveOrder(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      orderId: string;
      warehouseId?: string;
      idempotencyKey: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.reserveOrder(this.context(request), body)
    };
  }

  @Post("ship-order")
  @RequirePermission("inventory.write")
  async shipOrder(
    @Req() request: AuthenticatedRequest,
    @Body() body: { orderId: string; idempotencyKey: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.shipOrder(this.context(request), body)
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
