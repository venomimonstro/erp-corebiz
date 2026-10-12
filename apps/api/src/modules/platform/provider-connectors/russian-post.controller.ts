import {Body,Controller,Get,Param,Post,Req} from "@nestjs/common";
import type {TenantContext,ApiSuccess} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../auth/auth.types";
import {RequirePermission} from "../authorization/require-permission.decorator";
import {ApiCost} from "../../../infrastructure/http/api-cost.decorator";
import {RussianPostService} from "./russian-post.service";

@Controller("provider-connectors")
export class RussianPostController{
  constructor(private readonly post:RussianPostService){}
  private ctx(request:AuthenticatedRequest):TenantContext{
    const {tenantId,userId,membershipId}=request.auth!;
    return {tenantId,userId,membershipId};
  }
  @Get("sites/:siteId/russian-post")
  @RequirePermission("sites.manage")
  async status(@Req() request:AuthenticatedRequest,@Param("siteId") siteId:string)
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.post.status(this.ctx(request),siteId)};
  }
  @Post("sites/:siteId/russian-post/configure")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async configure(@Req() request:AuthenticatedRequest,@Param("siteId") siteId:string,
    @Body() body:{
      accessToken:string;userAuthorizationKey:string;fromPostcode:string
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.post.configure(this.ctx(request),siteId,body)};
  }
  @Post("sites/:siteId/russian-post/verify")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async verify(@Req() request:AuthenticatedRequest,@Param("siteId") siteId:string,
    @Body() body:{toPostcode:string}):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.post.verify(
      this.ctx(request),siteId,body?.toPostcode)};
  }
  @Post("sites/:siteId/russian-post/quotes")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async quote(@Req() request:AuthenticatedRequest,@Param("siteId") siteId:string,
    @Body() body:{toPostcode:string;massGrams:number})
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.post.quote(this.ctx(request),siteId,body)};
  }
}