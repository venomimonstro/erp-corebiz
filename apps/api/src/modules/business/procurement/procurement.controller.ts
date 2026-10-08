import {
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
import { ProcurementService } from "./procurement.service";

@Controller("procurement")
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get("suppliers")
  @RequirePermission("procurement.read")
  async suppliers(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.procurement.listSuppliers(this.context(request))
    };
  }

  @Post("suppliers")
  @RequirePermission("procurement.write")
  async createSupplier(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      displayName: string;
      type?: "PERSON" | "ORGANIZATION";
      phone?: string;
      email?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.procurement.createSupplier(this.context(request), body)
    };
  }

  @Get("orders")
  @RequirePermission("procurement.read")
  async orders(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.procurement.listOrders(this.context(request))
    };
  }

  @Post("orders")
  @RequirePermission("procurement.write")
  async createOrder(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      supplierPartyId: string;
      destinationBranchId?: string;
      destinationWarehouseId?: string;
      expectedAt?: string;
      notes?: string;
      inventoryOwnerId?: string;
      lines: Array<{
        skuId: string;
        quantityMilli?: string;
        unitCostMinor?: string;
      }>;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.procurement.createOrder(this.context(request), body)
    };
  }

  @Patch("orders/:id/confirm")
  @RequirePermission("procurement.write")
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { version: number }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.procurement.confirmOrder(
        this.context(request),
        id,
        body.version
      )
    };
  }

  @Get("orders/:id/lines")
  @RequirePermission("procurement.read")
  async lines(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.procurement.getOrderLines(this.context(request), id)
    };
  }

  @Post("orders/:id/receipts")
  @RequirePermission("procurement.write")
  async receive(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      lines: Array<{
        purchaseOrderLineId: string;
        quantityMilli: string;
      }>;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.procurement.receive(
        this.context(request),
        id,
        body.lines
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
