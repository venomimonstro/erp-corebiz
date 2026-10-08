import {
  Body,Controller,Get,Headers,Param,Post,Query,Req
} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {Public} from "../../platform/auth/public.decorator";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {Wms3plRequestsService} from "./wms-3pl-requests.service";

@Controller("wms/3pl-requests")
export class Wms3plRequestsController{
  constructor(private readonly requests:Wms3plRequestsService){}

  @Get()
  @RequirePermission("wms.read")
  async queue(
    @Req() req:AuthenticatedRequest,
    @Query("status") status?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.requests.queue(this.ctx(req),status)};
  }

  @Get(":id")
  @RequirePermission("wms.read")
  async detail(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.requests.operatorDetail(this.ctx(req),id)};
  }

  @Post(":id/reply")
  @RequirePermission("wms.manage")
  async reply(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.requests.operatorReply(this.ctx(req),id,body);
    return {ok:true,data:{updated:true}};
  }

  @Public()
  @Get("public/list")
  async publicList(
    @Headers("authorization") authorization?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.requests.publicList(this.token(authorization))};
  }

  @Public()
  @Post("public/create")
  async publicCreate(
    @Headers("authorization") authorization:string|undefined,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.requests.publicCreate(this.token(authorization),body)
    };
  }

  @Public()
  @Get("public/:id")
  async publicDetail(
    @Headers("authorization") authorization:string|undefined,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.requests.publicDetail(this.token(authorization),id)
    };
  }

  @Public()
  @Post("public/:id/reply")
  async publicReply(
    @Headers("authorization") authorization:string|undefined,
    @Param("id") id:string,
    @Body() body:{body:string}
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.requests.publicReply(this.token(authorization),id,body.body);
    return {ok:true,data:{updated:true}};
  }

  private token(value?:string):string{
    return value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()??"";
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
