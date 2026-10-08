import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { AccountingService } from "./accounting.service";

@Controller("accounting")
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get("accounts")
  @RequirePermission("accounting.read")
  async accounts(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.accounting.accounts(this.context(request))};
  }

  @Post("accounts")
  @RequirePermission("accounting.policy.manage")
  async createAccount(@Req() request:AuthenticatedRequest,@Body() body:{
    code:string;name:string;category:"ASSET"|"LIABILITY"|"EQUITY"|"INCOME"|"EXPENSE"|"OFF_BALANCE";
  }):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.accounting.createAccount(this.context(request),body)};
  }

  @Post("periods")
  @RequirePermission("accounting.period.close")
  async createPeriod(@Req() request:AuthenticatedRequest,@Body() body:{
    legalEntityId:string;dateFrom:string;dateTo:string;
  }):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.accounting.createPeriod(this.context(request),body)};
  }

  @Get("periods")
  @RequirePermission("accounting.read")
  async periods(@Req() request: AuthenticatedRequest,@Query("legalEntityId") legalEntityId:string): Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.accounting.periods(this.context(request),legalEntityId)};
  }

  @Get("entries")
  @RequirePermission("accounting.read")
  async entries(@Req() request: AuthenticatedRequest,@Query("legalEntityId") legalEntityId:string): Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.accounting.entries(this.context(request),legalEntityId)};
  }

  @Post("entries")
  @RequirePermission("accounting.post")
  async post(@Req() request: AuthenticatedRequest,@Body() body: {
    legalEntityId:string;periodId:string;businessDate:string;
    sourceType:string;sourceId:string;postingKey:string;
    ruleCode:string;ruleVersion:number;amountMinor:string;reversalOfId?:string;
  }): Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.accounting.post(this.context(request),body)};
  }

  private context(request:AuthenticatedRequest):TenantContext {
    const auth=request.auth!;
    return {tenantId:auth.tenantId,userId:auth.userId,membershipId:auth.membershipId};
  }
}
