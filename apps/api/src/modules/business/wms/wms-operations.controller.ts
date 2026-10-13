import {BadRequestException,Controller,Get,Param,Query,Req} from "@nestjs/common";
import type {ApiSuccess,TenantContext} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../../platform/auth/auth.types";
import {RequirePermission} from "../../platform/authorization/require-permission.decorator";
import {WmsOperationsService} from "./wms-operations.service";

@Controller("wms/operations")
export class WmsOperationsController{
  constructor(private readonly operations:WmsOperationsService){}
  private ctx(req:AuthenticatedRequest):TenantContext{
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }

  @Get("warehouses/:warehouseId/stock")
  @RequirePermission("wms.read")
  async stock(@Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.operations.stock(this.ctx(req),warehouseId)};
  }

  @Get("warehouses/:warehouseId/stock-page")
  @RequirePermission("wms.read")
  async stockPage(@Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Query("query") query?:string,
    @Query("onlyProblems") onlyProblems?:string,
    @Query("cursor") cursor?:string,
    @Query("limit") limit?:string):Promise<ApiSuccess<unknown>>{
    if(onlyProblems!==undefined&&!["true","false"].includes(onlyProblems))
      throw new BadRequestException("Некорректный фильтр");
    return {ok:true,data:await this.operations.stockPage(
      this.ctx(req),warehouseId,{
        query,onlyProblems:onlyProblems==="true",cursor,
        limit:limit===undefined?undefined:Number(limit)
      }
    )};
  }

  @Get("warehouses/:warehouseId/pick-route")
  @RequirePermission("wms.read")
  async route(@Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Query("waveId") waveId?:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,
      data:await this.operations.pickRoute(this.ctx(req),warehouseId,waveId)};
  }
}
