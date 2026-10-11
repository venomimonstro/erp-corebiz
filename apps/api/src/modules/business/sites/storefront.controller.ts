import {
  Body,Controller,Get,Param,Post,Put,Query,Req
} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import {ApiCost} from "../../../infrastructure/http/api-cost.decorator";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {Public} from "../../platform/auth/public.decorator";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {StorefrontService} from "./storefront.service";

@Controller("storefront")
export class StorefrontController{
  constructor(private readonly storefront:StorefrontService){}

  @Get("site/:siteId/readiness")
  @RequirePermission("sites.read")
  async readiness(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.readiness(this.ctx(req),siteId)};
  }

  @Put("site/:siteId/config")
  @RequirePermission("sites.manage")
  async config(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string,@Body() body:any):Promise<ApiSuccess<{updated:true}>>{
    await this.storefront.configure(this.ctx(req),siteId,body);
    return {ok:true,data:{updated:true}};
  }

  @Public()
  @Get(":siteCode/catalog")
  @ApiCost("SEARCH")
  async catalog(
    @Param("siteCode") code:string,
    @Query("cursor") cursor?:string,
    @Query("q") q?:string,
    @Query("limit") limit?:string
  ):Promise<ApiSuccess<unknown>>{
    const n=limit===undefined?24:Number(limit);
    return {ok:true,data:await this.storefront.catalog(code,{cursor,q,limit:n})};
  }

  @Public()
  @Post(":siteCode/carts")
  @ApiCost("PUBLIC_CART")
  async cartCreate(@Param("siteCode") code:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.createCart(code)};
  }

  @Public()
  @Get("carts/:cartKey")
  @ApiCost("SEARCH")
  async cart(@Param("cartKey") key:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.cart(key)};
  }

  @Public()
  @Put("carts/:cartKey/lines")
  @ApiCost("PUBLIC_CART")
  async line(@Param("cartKey") key:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.setLine(key,body)};
  }

  @Public()
  @Post("carts/:cartKey/checkout")
  @ApiCost("PUBLIC_CHECKOUT")
  async checkout(@Param("cartKey") key:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.checkout(key,body)};
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
