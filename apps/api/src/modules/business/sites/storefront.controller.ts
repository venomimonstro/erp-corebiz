import {
  Body,Controller,Get,Param,Post,Put,Req
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

  @Put("site/:siteId/config")
  @RequirePermission("sites.manage")
  async config(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string,@Body() body:any):Promise<ApiSuccess<{updated:true}>>{
    await this.storefront.configure(this.ctx(req),siteId,body);
    return {ok:true,data:{updated:true}};
  }

  @Public()
  @Get(":siteCode/catalog")
  @ApiCost("SEARCH")
  async catalog(@Param("siteCode") code:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.catalog(code)};
  }

  @Public()
  @Post(":siteCode/carts")
  @ApiCost("WEBHOOK")
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
  @ApiCost("WEBHOOK")
  async line(@Param("cartKey") key:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.setLine(key,body)};
  }

  @Public()
  @Post("carts/:cartKey/checkout")
  @ApiCost("WEBHOOK")
  async checkout(@Param("cartKey") key:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.storefront.checkout(key,body)};
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
