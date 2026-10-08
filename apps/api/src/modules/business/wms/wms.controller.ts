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

  @Post("orders/:orderId/plan-outbound")
  @RequirePermission("wms.manage")
  async planOutbound(
    @Req() req:AuthenticatedRequest,
    @Param("orderId") orderId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.planOutbound(this.ctx(req),orderId)
    };
  }

  @Post("tasks/:taskId/complete-pick")
  @RequirePermission("wms.manage")
  async completePick(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.wms.completePick(this.ctx(req),taskId);
    return {ok:true,data:{updated:true}};
  }

  @Post("orders/:orderId/warehouses/:warehouseId/pack-task")
  @RequirePermission("wms.manage")
  async packTask(
    @Req() req:AuthenticatedRequest,
    @Param("orderId") orderId:string,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.createPackTask(
        this.ctx(req),orderId,warehouseId
      )
    };
  }

  @Post("tasks/:taskId/complete-pack")
  @RequirePermission("wms.manage")
  async completePack(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.completePack(this.ctx(req),taskId)
    };
  }

  @Post("tasks/:taskId/complete-ship")
  @RequirePermission("wms.manage")
  async completeShip(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.completeShip(this.ctx(req),taskId)
    };
  }

  @Post("warehouses/:warehouseId/cycle-counts")
  @RequirePermission("wms.manage")
  async cycleCount(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Body() body:{zoneId?:string;locationId?:string;reason?:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.createCycleCount(
        this.ctx(req),warehouseId,body??{}
      )
    };
  }

  @Post("tasks/:taskId/complete-count")
  @RequirePermission("wms.manage")
  async completeCount(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:{countedMilli:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.completeCycleCountTask(
        this.ctx(req),taskId,body.countedMilli
      )
    };
  }

  @Post("warehouses/:warehouseId/replenishment/plan")
  @RequirePermission("wms.manage")
  async planReplenishment(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.planReplenishment(
        this.ctx(req),warehouseId
      )
    };
  }

  @Post("tasks/:taskId/complete-replenishment")
  @RequirePermission("wms.manage")
  async completeReplenishment(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string
  ):Promise<ApiSuccess<{updated:true}>>{
    await this.wms.completeReplenishment(this.ctx(req),taskId);
    return {ok:true,data:{updated:true}};
  }

  @Post("warehouses/:warehouseId/scanner/next")
  @RequirePermission("wms.manage")
  async scannerNext(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.scannerNextTask(
        this.ctx(req),warehouseId
      )
    };
  }

  @Get("scanner/tasks/:taskId")
  @RequirePermission("wms.read")
  async scannerTask(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.scannerTask(this.ctx(req),taskId)
    };
  }

  @Post("scanner/tasks/:taskId/scan")
  @RequirePermission("wms.manage")
  async scannerScan(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:{
      scanType:"FROM_LOCATION"|"TO_LOCATION"|"SKU"|"ORDER";
      value:string;
    }
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.scanTask(this.ctx(req),taskId,body)
    };
  }

  @Post("scanner/tasks/:taskId/complete")
  @RequirePermission("wms.manage")
  async scannerComplete(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:{countedMilli?:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.completeScannerTask(
        this.ctx(req),taskId,body??{}
      )
    };
  }

  @Get("warehouses/:warehouseId/waves")
  @RequirePermission("wms.read")
  async waves(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.waves(this.ctx(req),warehouseId)
    };
  }

  @Post("warehouses/:warehouseId/waves")
  @RequirePermission("wms.manage")
  async createWave(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string,
    @Body() body:{
      strategy:"ORDER"|"BATCH"|"ZONE"|"CLUSTER";
      maxTasks?:number;
      priority?:number;
    }
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.createWave(
        this.ctx(req),warehouseId,body
      )
    };
  }

  @Post("waves/:waveId/release")
  @RequirePermission("wms.manage")
  async releaseWave(
    @Req() req:AuthenticatedRequest,
    @Param("waveId") waveId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.releaseWave(this.ctx(req),waveId)
    };
  }

  @Post("waves/:waveId/claim-next")
  @RequirePermission("wms.manage")
  async claimNextWaveTask(
    @Req() req:AuthenticatedRequest,
    @Param("waveId") waveId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.claimNextWaveTask(
        this.ctx(req),waveId
      )
    };
  }

  @Get("warehouses/:warehouseId/dispatcher")
  @RequirePermission("wms.read")
  async dispatcher(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.dispatcher(this.ctx(req),warehouseId)
    };
  }

  @Get("mobile/warehouses/:warehouseId/next")
  @RequirePermission("wms.manage")
  async mobileNext(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.nextMobileTask(
        this.ctx(req),warehouseId
      )
    };
  }

  @Post("mobile/tasks/:taskId/scan")
  @RequirePermission("wms.manage")
  async mobileScan(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:{
      kind:"FROM_LOCATION"|"SKU"|"TO_LOCATION";
      value:string;
      idempotencyKey:string;
    }
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.scanMobileTask(
        this.ctx(req),taskId,body
      )
    };
  }

  @Post("mobile/tasks/:taskId/problem")
  @RequirePermission("wms.manage")
  async mobileProblem(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.reportMobileTaskProblem(
        this.ctx(req),taskId,body
      )
    };
  }

  @Get("warehouses/:warehouseId/mobile/next")
  @RequirePermission("wms.manage")
  async mobileNext(
    @Req() req:AuthenticatedRequest,
    @Param("warehouseId") warehouseId:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.nextMobileTask(this.ctx(req),warehouseId)
    };
  }

  @Post("tasks/:taskId/mobile/scan")
  @RequirePermission("wms.manage")
  async mobileScan(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:{
      kind:"FROM_LOCATION"|"SKU"|"TO_LOCATION";
      value:string;
      idempotencyKey:string;
    }
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.scanMobileTask(
        this.ctx(req),taskId,body
      )
    };
  }

  @Post("tasks/:taskId/mobile/problem")
  @RequirePermission("wms.manage")
  async mobileProblem(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.reportMobileTaskProblem(
        this.ctx(req),taskId,body
      )
    };
  }

  @Post("tasks/:taskId/mobile/complete")
  @RequirePermission("wms.manage")
  async mobileComplete(
    @Req() req:AuthenticatedRequest,
    @Param("taskId") taskId:string,
    @Body() body:{countedMilli?:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.wms.completeMobileTask(
        this.ctx(req),taskId,body
      )
    };
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
