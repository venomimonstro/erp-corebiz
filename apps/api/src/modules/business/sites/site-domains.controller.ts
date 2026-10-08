import {
  Body,Controller,Get,Param,Post,Query,Req
} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {Public} from "../../platform/auth/public.decorator";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {SiteDomainsService} from "./site-domains.service";

@Controller("site-domains")
export class SiteDomainsController{
  constructor(private readonly domains:SiteDomainsService){}

  @Get("site/:siteId")
  @RequirePermission("sites.read")
  async list(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.domains.list(this.ctx(req),siteId)};
  }

  @Post("site/:siteId")
  @RequirePermission("sites.manage")
  async create(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string,@Body() body:{hostname:string}):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.domains.create(this.ctx(req),siteId,body.hostname)};
  }

  @Get(":id/verification")
  @RequirePermission("sites.read")
  async instructions(@Req() req:AuthenticatedRequest,@Param("id") id:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.domains.verificationInstructions(this.ctx(req),id)};
  }

  @Post(":id/verify")
  @RequirePermission("sites.manage")
  async verify(@Req() req:AuthenticatedRequest,@Param("id") id:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.domains.verify(this.ctx(req),id)};
  }

  @Post(":id/activate")
  @RequirePermission("sites.manage")
  async activate(@Req() req:AuthenticatedRequest,@Param("id") id:string,@Body() body:{primary?:boolean}):Promise<ApiSuccess<{updated:true}>>{
    await this.domains.activate(this.ctx(req),id,body.primary??true);
    return {ok:true,data:{updated:true}};
  }

  @Public()
  @Get("public/page")
  async publicPage(@Query("host") host:string,@Query("slug") slug?:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.domains.publicByHost(host,slug)};
  }

  @Public()
  @Get("public/routes")
  async publicRoutes(
    @Query("host") host:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.domains.publicRoutesByHost(host)
    };
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
