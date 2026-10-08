import {
  Body,Controller,Get,Param,Post,Req
} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {Public} from "../../platform/auth/public.decorator";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {SiteFormsService} from "./site-forms.service";

@Controller("site-forms")
export class SiteFormsController{
  constructor(private readonly forms:SiteFormsService){}

  @Get("site/:siteId")
  @RequirePermission("sites.read")
  async list(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.forms.bindings(this.ctx(req),siteId)};
  }

  @Post("site/:siteId")
  @RequirePermission("sites.manage")
  async create(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.forms.createBinding(this.ctx(req),siteId,body)};
  }

  @Public()
  @Post("submit/:publicKey")
  async submit(@Param("publicKey") key:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.forms.submit(key,body)};
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
