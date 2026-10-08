import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { PayrollService } from "./payroll.service";

@Controller("accounting/payroll")
export class PayrollController {
  constructor(private readonly payroll:PayrollService) {}
  @Get("batches")
  @RequirePermission("accounting.read")
  async batches(@Req() req:AuthenticatedRequest,@Query("legalEntityId") legalEntityId:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.payroll.batches(this.ctx(req),legalEntityId)};
  }
  @Post("batches")
  @RequirePermission("accounting.policy.manage")
  async create(@Req() req:AuthenticatedRequest,@Body() body:{
    legalEntityId:string;periodFrom:string;periodTo:string;
  }):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.payroll.createBatch(this.ctx(req),body)};
  }
  @Post("lines")
  @RequirePermission("accounting.policy.manage")
  async upsertLine(@Req() req:AuthenticatedRequest,@Body() body:{
    batchId:string;employeeRef:string;grossMinor:string;deductionMinor:string;
  }):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.payroll.upsertLine(this.ctx(req),body)};
  }
  @Post("batches/:batchId/approve")
  @RequirePermission("accounting.period.close")
  async approve(@Req() req:AuthenticatedRequest,@Param("batchId") batchId:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.payroll.approve(this.ctx(req),batchId)};
  }
  @Get("batches/:batchId/summary")
  @RequirePermission("accounting.read")
  async summary(@Req() req:AuthenticatedRequest,@Param("batchId") batchId:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.payroll.batchSummary(this.ctx(req),batchId)};
  }
  @Post("exports/prepare")
  @RequirePermission("accounting.period.close")
  async prepareExport(@Req() req:AuthenticatedRequest,@Body() body:{
    batchId:string;kind:"ACCOUNTING_PREVIEW"|"PAYMENT_PREVIEW";
  }):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.payroll.prepareExport(this.ctx(req),body)};
  }

  private ctx(req:AuthenticatedRequest):TenantContext {
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
