import {
  Body,Controller,Get,Param,Post,Query,Req
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
