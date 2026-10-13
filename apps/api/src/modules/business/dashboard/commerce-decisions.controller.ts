import { Body, Controller, Get, Param, Put, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { CommerceDecisionsService, type CommerceSnapshot } from "./commerce-decisions.service";

@Controller("dashboard/commerce")
export class CommerceDecisionsController {
  constructor(private readonly commerce: CommerceDecisionsService) {}

  @Get("rules")
  @RequirePermission("procurement.read")
  async rules(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.commerce.rules(this.context(request))};
  }

  @Put("rules/:skuId")
  @RequirePermission("procurement.write")
  async rule(@Req() request:AuthenticatedRequest,
    @Param("skuId") skuId:string,
    @Body() body:{
      leadDays:number;reviewDays:number;minimumBatchMilli:string;enabled:boolean
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.commerce.updateRule(this.context(request),skuId,body)};
  }

  @Get()
  @RequirePermission("dashboard.owner.read")
  async snapshot(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<CommerceSnapshot>> {
    return { ok: true, data: await this.commerce.snapshot(this.context(request)) };
  }

  private context(request: AuthenticatedRequest):TenantContext {
    const a=request.auth!;
    return {tenantId:a.tenantId,membershipId:a.membershipId,userId:a.userId};
  }
}
