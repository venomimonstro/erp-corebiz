import {
  Body,Controller,Get,Param,Patch,Post,Query,Req
} from "@nestjs/common";
import type { ApiSuccess,TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { AutomotiveService } from "./automotive.service";

@Controller("automotive")
export class AutomotiveController {
  constructor(private readonly automotive:AutomotiveService) {}

  @Get("dashboard")
  @RequirePermission("service.read")
  async dashboard(@Req() request:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.dashboard(this.context(request))};
  }

  @Get("vehicles")
  @RequirePermission("service.read")
  async vehicles(
    @Req() request:AuthenticatedRequest,@Query("q") q?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.vehicles(this.context(request),q)};
  }

  @Post("vehicles")
  @RequirePermission("service.write")
  async createVehicle(
    @Req() request:AuthenticatedRequest,@Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.createVehicle(this.context(request),body)};
  }

  @Get("work-orders")
  @RequirePermission("service.read")
  async workOrders(@Req() request:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.workOrders(this.context(request))};
  }

  @Get("work-orders/:id")
  @RequirePermission("service.read")
  async workOrder(
    @Req() request:AuthenticatedRequest,@Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.workOrder(this.context(request),id)};
  }

  @Patch("work-orders/:id")
  @RequirePermission("service.write")
  async updateWorkOrder(
    @Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.updateWorkOrder(this.context(request),id,body)};
  }

  @Post("work-orders")
  @RequirePermission("service.write")
  async createWorkOrder(
    @Req() request:AuthenticatedRequest,@Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.createWorkOrder(this.context(request),body)};
  }

  @Post("work-orders/:id/lines")
  @RequirePermission("service.write")
  async addWorkOrderLine(
    @Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.addWorkOrderLine(this.context(request),id,body)};
  }

  @Patch("work-orders/:id/lines/:lineId")
  @RequirePermission("service.write")
  async updateWorkOrderLine(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Param("lineId") lineId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.automotive.updateWorkOrderLine(
        this.context(request),id,lineId,body
      )
    };
  }

  @Get("donors")
  @RequirePermission("inventory.read")
  async donors(@Req() request:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.donors(this.context(request))};
  }

  @Post("donors")
  @RequirePermission("inventory.write")
  async createDonor(
    @Req() request:AuthenticatedRequest,@Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.createDonor(this.context(request),body)};
  }

  @Get("parts")
  @RequirePermission("inventory.read")
  async parts(
    @Req() request:AuthenticatedRequest,@Query("q") q?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.parts(this.context(request),q)};
  }

  @Get("fitments")
  @RequirePermission("inventory.read")
  async fitments(
    @Req() request:AuthenticatedRequest,
    @Query("skuId") skuId?:string,
    @Query("vehicleId") vehicleId?:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.automotive.fitments(
        this.context(request),{skuId,vehicleId}
      )
    };
  }

  @Post("fitments")
  @RequirePermission("inventory.write")
  async createFitment(
    @Req() request:AuthenticatedRequest,@Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.automotive.createFitment(this.context(request),body)
    };
  }

  @Get("vehicles/:id/compatible-parts")
  @RequirePermission("inventory.read")
  async compatibleParts(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Query("q") q?:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.automotive.compatibleParts(this.context(request),id,q)
    };
  }

  @Patch("parts/:id/inventory")
  @RequirePermission("inventory.write")
  async linkPartToInventory(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.automotive.linkPartToInventory(
        this.context(request),id,body
      )
    };
  }

  @Post("donors/:id/parts")
  @RequirePermission("inventory.write")
  async addPart(
    @Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.automotive.addDismantledPart(this.context(request),id,body)};
  }

  private context(request:AuthenticatedRequest):TenantContext{
    const auth=request.auth!;
    return {
      tenantId:auth.tenantId,userId:auth.userId,membershipId:auth.membershipId
    };
  }
}
