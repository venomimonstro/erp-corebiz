import {
  Body,Controller,Get,Param,Post,Query,Req
} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {WmsInboundService} from "./wms-inbound.service";

@Controller("wms/inbound")
export class WmsInboundController{
  constructor(private readonly inbound:WmsInboundService){}

  @Get("asn")
  @RequirePermission("wms.read")
  async list(
    @Req() req:AuthenticatedRequest,
    @Query("warehouseId") warehouseId?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.inbound.list(this.ctx(req),warehouseId)};
  }

  @Post("asn")
  @RequirePermission("wms.manage")
  async create(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.inbound.create(this.ctx(req),body)};
  }

  @Get("asn/:id")
  @RequirePermission("wms.read")
  async details(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.inbound.details(this.ctx(req),id)};
  }

  @Post("asn/:id/schedule")
  @RequirePermission("wms.manage")
  async schedule(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.inbound.schedule(this.ctx(req),id,body)};
  }

  @Post("appointments/:id/action")
  @RequirePermission("wms.manage")
  async action(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{action:"CHECK_IN"|"START"|"COMPLETE"|"NO_SHOW"|"CANCEL"}
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.inbound.transitionAppointment(this.ctx(req),id,body.action);
    return {ok:true,data:{updated:true}};
  }

  @Get("warehouses/:warehouseId/docks")
  @RequirePermission("wms.read")
  async docks(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.inbound.dockSchedule(this.ctx(req),warehouseId,from,to)
    };
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
