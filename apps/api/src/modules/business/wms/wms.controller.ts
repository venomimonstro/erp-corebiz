import {
  Body,Controller,Get,Param,Patch,Post,Put,Req
} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {WmsService} from "./wms.service";

@Controller("wms")
export class WmsController{
  constructor(private readonly wms:WmsService){}

  @Get("warehouses")
  @RequirePermission("wms.read")
  async warehouses(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.wms.warehouses(this.ctx(req))};
  }

  @Put("warehouses/:warehouseId/profile")
  @RequirePermission("wms.manage")
  async profile(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Body() body:any
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.wms.configure(this.ctx(req),warehouseId,body);
    return {ok:true,data:{updated:true}};
  }

  @Get("warehouses/:warehouseId/topology")
  @RequirePermission("wms.read")
  async topology(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.wms.topology(this.ctx(req),warehouseId)};
  }

  @Post("warehouses/:warehouseId/zones")
  @RequirePermission("wms.manage")
  async zone(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.wms.createZone(this.ctx(req),warehouseId,body)};
  }

  @Post("warehouses/:warehouseId/locations")
  @RequirePermission("wms.manage")
  async location(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.wms.createLocation(this.ctx(req),warehouseId,body)};
  }

  @Patch("warehouses/:warehouseId/locations/:locationId/status")
  @RequirePermission("wms.manage")
  async locationStatus(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Param("locationId") locationId:string,
    @Body() body:{status:"ACTIVE"|"BLOCKED"|"MAINTENANCE"}
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.wms.updateLocationStatus(
      this.ctx(req),warehouseId,locationId,body.status
    );
    return {ok:true,data:{updated:true}};
  }

  @Post("warehouses/:warehouseId/sku-rules")
  @RequirePermission("wms.manage")
  async skuRule(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.wms.setSkuRule(this.ctx(req),warehouseId,body)};
  }

  @Post("warehouses/:warehouseId/location-ledger/initialize")
  @RequirePermission("wms.manage")
  async initialize(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.initializeLocationLedger(
        this.ctx(req),warehouseId
      )
    };
  }

  @Get("warehouses/:warehouseId/location-balances")
  @RequirePermission("wms.read")
  async locationBalances(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.locationBalances(this.ctx(req),warehouseId)
    };
  }

  @Post("warehouses/:warehouseId/putaway-tasks")
  @RequirePermission("wms.manage")
  async putawayTask(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Body() body:{skuId:string;quantityMilli:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.createPutawayTask(
        this.ctx(req),warehouseId,body
      )
    };
  }

  @Get("warehouses/:warehouseId/tasks")
  @RequirePermission("wms.read")
  async tasks(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.tasks(this.ctx(req),warehouseId)
    };
  }

  @Post("tasks/:taskId/claim")
  @RequirePermission("wms.manage")
  async claim(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.wms.claimTask(this.ctx(req),taskId);
    return {ok:true,data:{updated:true}};
  }

  @Post("tasks/:taskId/complete-putaway")
  @RequirePermission("wms.manage")
  async completePutaway(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.wms.completePutaway(this.ctx(req),taskId);
    return {ok:true,data:{updated:true}};
  }

  @Get("warehouses/:warehouseId/reconciliation")
  @RequirePermission("wms.read")
  async reconciliation(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.reconciliation(this.ctx(req),warehouseId)
    };
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
