import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess,TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { SitesService } from "./sites.service";

@Controller("sites")
export class SitesController{
  constructor(private readonly sitesService:SitesService){}

  @Get()
  @RequirePermission("sites.read")
  async sites(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.sitesService.sites(this.ctx(req))};
  }

  @Post()
  @RequirePermission("sites.manage")
  async createSite(@Req() req:AuthenticatedRequest,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.sitesService.createSite(this.ctx(req),body)};
  }

  @Get(":siteId/pages")
  @RequirePermission("sites.read")
  async pages(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.sitesService.pages(this.ctx(req),siteId)};
  }

  @Post(":siteId/pages")
  @RequirePermission("sites.manage")
  async createPage(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.sitesService.createPage(this.ctx(req),siteId,body)};
  }

  @Get("pages/:pageId/editor")
  @RequirePermission("sites.read")
  async editor(@Req() req:AuthenticatedRequest,@Param("pageId") pageId:string,@Query("versionId") versionId?:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.sitesService.editor(this.ctx(req),pageId,versionId)};
  }

  @Post("pages/:pageId/draft")
  @RequirePermission("sites.manage")
  async draft(@Req() req:AuthenticatedRequest,@Param("pageId") pageId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.sitesService.createDraft(this.ctx(req),pageId)};
  }

  @Put("pages/:pageId/versions/:versionId/meta")
  @RequirePermission("sites.manage")
  async meta(@Req() req:AuthenticatedRequest,@Param("pageId") pageId:string,@Param("versionId") versionId:string,@Body() body:any):Promise<ApiSuccess<{updated:true}>>{
    await this.sitesService.saveMeta(this.ctx(req),pageId,versionId,body);
    return {ok:true,data:{updated:true}};
  }

  @Put("pages/:pageId/versions/:versionId/blocks")
  @RequirePermission("sites.manage")
  async blocks(@Req() req:AuthenticatedRequest,@Param("pageId") pageId:string,@Param("versionId") versionId:string,@Body() body:any):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.sitesService.replaceBlocks(this.ctx(req),pageId,versionId,body)};
  }

  @Post("pages/:pageId/versions/:versionId/publish")
  @RequirePermission("sites.manage")
  async publish(@Req() req:AuthenticatedRequest,@Param("pageId") pageId:string,@Param("versionId") versionId:string):Promise<ApiSuccess<{published:true}>>{
    await this.sitesService.publish(this.ctx(req),pageId,versionId);
    return {ok:true,data:{published:true}};
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
