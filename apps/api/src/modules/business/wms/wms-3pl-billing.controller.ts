import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { Wms3plBillingService } from "./wms-3pl-billing.service";

@Controller("wms/3pl-billing")
export class Wms3plBillingController {
  constructor(private readonly billing: Wms3plBillingService) {}

  @Get("contracts")
  @RequirePermission("wms.3pl_billing.read")
  async contracts(
    @Req() request: AuthenticatedRequest,
    @Query("warehouseId") warehouseId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.billing.contracts(
        this.context(request),
        warehouseId
      )
    };
  }

  @Put("contracts/:contractId/rates")
  @RequirePermission("wms.3pl_billing.manage")
  async rate(
    @Req() request: AuthenticatedRequest,
    @Param("contractId") contractId: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.billing.setRate(
        this.context(request),
        contractId,
        body
      )
    };
  }

  @Get("statements")
  @RequirePermission("wms.3pl_billing.read")
  async statements(
    @Req() request: AuthenticatedRequest,
    @Query("contractId") contractId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.billing.statements(
        this.context(request),
        contractId
      )
    };
  }

  @Get("statements/:id")
  @RequirePermission("wms.3pl_billing.read")
  async statement(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.billing.statement(this.context(request), id)
    };
  }

  @Post("contracts/:contractId/statements")
  @RequirePermission("wms.3pl_billing.manage")
  async generate(
    @Req() request: AuthenticatedRequest,
    @Param("contractId") contractId: string,
    @Body() body: { periodFrom: string; periodTo: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.billing.generate(
        this.context(request),
        contractId,
        body
      )
    };
  }

  @Post("statements/:id/finalize")
  @RequirePermission("wms.3pl_billing.manage")
  async finalize(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ finalized: true }>> {
    await this.billing.finalize(this.context(request), id);
    return { ok: true, data: { finalized: true } };
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
