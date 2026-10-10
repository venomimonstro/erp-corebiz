import {
  Body,Controller,Get,Param,Post,Query,Req
} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import {ApiCost} from "../../../infrastructure/http/api-cost.decorator";
import type {Request} from "express";
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
  @Get("availability/:publicKey")
  @ApiCost("SEARCH")
  async availability(
    @Req() req:Request,
    @Param("publicKey") key:string,
    @Query("from") from:string,
    @Query("to") to:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.forms.bookingAvailability(
        key,from,to,req.ip||req.socket.remoteAddress||"unknown"
      )
    };
  }

  @Public()
  @Post("submit/:publicKey")
  @ApiCost("WEBHOOK")
  async submit(
    @Req() req:Request,
    @Param("publicKey") key:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.forms.submit(
        key,body,req.ip||req.socket.remoteAddress||"unknown"
      )
    };
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
