import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { FinanceService } from "./finance.service";

@Controller("finance")
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get("summary")
  @RequirePermission("finance.read")
  async summary(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.finance.summary(this.context(request)) };
  }

  @Get("obligations")
  @RequirePermission("finance.read")
  async obligations(
    @Req() request: AuthenticatedRequest,
    @Query("direction") direction?: "RECEIVABLE" | "PAYABLE"
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.finance.listObligations(this.context(request), direction)
    };
  }

  @Get("payments")
  @RequirePermission("finance.read")
  async payments(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.finance.listPayments(this.context(request)) };
  }

  @Post("accounts")
  @RequirePermission("finance.write")
  async createAccount(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      name: string;
      kind?: "BANK" | "CASH" | "ACQUIRING" | "OTHER";
      currency?: string;
      openingBalanceMinor?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.finance.createCashAccount(this.context(request), body)
    };
  }

  @Post("sales-payment")
  @RequirePermission("finance.write")
  async salesPayment(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      orderId: string;
      amountMinor: string;
      cashAccountId?: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.finance.receiveSalesPayment(this.context(request), body)
    };
  }

  @Post("supplier-payment")
  @RequirePermission("finance.write")
  async supplierPayment(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      purchaseOrderId: string;
      amountMinor: string;
      cashAccountId?: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.finance.paySupplier(this.context(request), body)
    };
  }

  @Post("sales-refund")
  @RequirePermission("finance.write")
  async salesRefund(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      orderId: string;
      amountMinor: string;
      cashAccountId?: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.finance.refundSalesPayment(this.context(request), body)
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
