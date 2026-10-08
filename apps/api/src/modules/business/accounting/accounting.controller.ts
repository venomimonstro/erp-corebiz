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
