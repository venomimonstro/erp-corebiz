import {Body,Controller,Get,Param,Post,Query,Req} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {RetailNetworkService} from "./retail-network.service";

@Controller("retail")
export class RetailNetworkController{
  constructor(private readonly service:RetailNetworkService){}
  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
  @Get("locations")
  @RequirePermission("inventory.read")
  async locations(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.locations(this.ctx(req))};
  }
  @Post("locations")
  @RequirePermission("organization.write")
  async create(@Req() req:AuthenticatedRequest,
    @Body() body:{code:string;name:string;address?:string;pickupEnabled?:boolean}
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.createLocation(this.ctx(req),body)};
  }
  @Get("locations/:id/stock")
  @RequirePermission("inventory.read")
  async stock(@Req() req:AuthenticatedRequest,
    @Param("id") id:string,@Query("q") q?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.locationStock(this.ctx(req),id,q??"")};
  }
  @Get("locations/:id/orders")
  @RequirePermission("sales.read")
  async orders(@Req() req:AuthenticatedRequest,@Param("id") id:string)
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.orders(this.ctx(req),id)};
  }
  @Post("orders/reserve")
  @RequirePermission("sales.write")
  async reserve(@Req() req:AuthenticatedRequest,
    @Body() body:{
      locationId:string;partyId?:string;idempotencyKey:string;
      channel:"COUNTER"|"CLICK_COLLECT";
      lines:Array<{skuId:string;quantityMilli:string}>
    }
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.reserve(this.ctx(req),body)};
  }
  @Post("locations/:id/shift/open")
  @RequirePermission("finance.write")
  async open(@Req() req:AuthenticatedRequest,@Param("id") id:string,
    @Body() body:{openingCashMinor?:string}
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.shift(this.ctx(req),id,"OPEN",body?.openingCashMinor)};
  }
  @Post("locations/:id/shift/close")
  @RequirePermission("finance.write")
  async close(@Req() req:AuthenticatedRequest,@Param("id") id:string,
    @Body() body:{closingCashMinor:string}
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.shift(this.ctx(req),id,"CLOSE",undefined,body?.closingCashMinor)};
  }
}
