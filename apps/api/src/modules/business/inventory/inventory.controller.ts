import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
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

  @Post("transfers")
  @RequirePermission("inventory.write")
  async transfer(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      fromWarehouseId: string;
      toWarehouseId: string;
      idempotencyKey: string;
      lines: Array<{ skuId: string; quantityMilli: string }>;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.transfer(this.context(request), body)
    };
  }

  @Post("stock-counts")
  @RequirePermission("inventory.write")
  async createStockCount(
    @Req() request: AuthenticatedRequest,
    @Body() body: { warehouseId: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.createStockCount(
        this.context(request),
        body.warehouseId
      )
    };
  }

  @Get("stock-counts/:id/lines")
  @RequirePermission("inventory.read")
  async stockCountLines(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.stockCountLines(this.context(request), id)
    };
  }

  @Patch("stock-counts/:id/lines/:lineId")
  @RequirePermission("inventory.write")
  async updateStockCountLine(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("lineId") lineId: string,
    @Body() body: { countedMilli: string }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.inventory.updateStockCountLine(
      this.context(request),
      id,
      lineId,
      body.countedMilli
    );

    return { ok: true, data: { updated: true } };
  }

  @Post("stock-counts/:id/post")
  @RequirePermission("inventory.write")
  async postStockCount(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.inventory.postStockCount(this.context(request), id)
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
