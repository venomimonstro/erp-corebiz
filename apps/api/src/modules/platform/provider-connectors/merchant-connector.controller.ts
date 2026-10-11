import {Body,Controller,Get,Param,Post,Req} from "@nestjs/common";
import type {TenantContext,ApiSuccess} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../auth/auth.types";
import {RequirePermission} from "../authorization/require-permission.decorator";
import {ApiCost} from "../../../infrastructure/http/api-cost.decorator";
import {MerchantConnectorService} from "./merchant-connector.service";

@Controller("provider-connectors")
export class MerchantConnectorController{
  constructor(private readonly service:MerchantConnectorService){}
  private context(req:AuthenticatedRequest):TenantContext{
    const {tenantId,userId,membershipId}=req.auth!;
    return {tenantId,userId,membershipId};
  }
  @Get("sites/:siteId")
  @RequirePermission("sites.read")
  async list(@Req() req:AuthenticatedRequest,@Param("siteId") id:string)
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.list(this.context(req),id)};
  }
  @Post("sites/:siteId/configure")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async configure(@Req() req:AuthenticatedRequest,@Param("siteId") id:string,
    @Body() body:{
      provider:"CDEK"|"ATOL_ONLINE";
      environment:"SANDBOX"|"PRODUCTION";
      credentials:Record<string,unknown>;fromCityCode?:number
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.configure(this.context(req),id,body)};
  }
  @Post("sites/:siteId/:provider/verify")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async verify(@Req() req:AuthenticatedRequest,
    @Param("siteId") id:string,@Param("provider") provider:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.verify(this.context(req),id,provider)};
  }
  @Post("sites/:siteId/cdek/quotes")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async quote(@Req() req:AuthenticatedRequest,@Param("siteId") id:string,
    @Body() body:{
      toCityCode:number;weightGrams:number;
      lengthCm:number;widthCm:number;heightCm:number
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.quote(this.context(req),id,body)};
  }
}
