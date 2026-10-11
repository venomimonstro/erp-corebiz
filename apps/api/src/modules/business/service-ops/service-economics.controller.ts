import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ServiceEconomicsService } from "./service-economics.service";

@Controller("service/economics")
export class ServiceEconomicsController {
  constructor(private readonly economics:ServiceEconomicsService) {}

  @Get()
  @RequirePermission("service.read")
  async dashboard(
    @Req() request:AuthenticatedRequest,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.dashboard(this.context(request),from,to)
    };
  }

  @Get("compensation-plans")
  @RequirePermission("service.read")
  async compensationPlans(
    @Req() request:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.compensationPlans(this.context(request))
    };
  }

  @Post("compensation-plans")
  @RequirePermission("service.write")
  async createCompensationPlan(
    @Req() request:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.createCompensationPlan(
        this.context(request),body
      )
    };
  }

  @Get("payroll-profiles")
  @RequirePermission("service.read")
  async payrollProfiles(
    @Req() request:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.payrollProfiles(this.context(request))
    };
  }

  @Post("payroll-profiles")
  @RequirePermission("service.write")
  async createPayrollProfile(
    @Req() request:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.createPayrollProfile(
        this.context(request),body
      )
    };
  }

  @Get("payroll-batches")
  @RequirePermission("service.read")
  async payrollBatches(
    @Req() request:AuthenticatedRequest,
    @Query("month") month?:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.draftPayrollBatches(
        this.context(request),month
      )
    };
  }

  @Post("payroll-statements/export")
  @RequirePermission("service.write")
  async exportPayroll(
    @Req() request:AuthenticatedRequest,
    @Body() body:{batchId:string;month?:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.exportPayrollToBatch(
        this.context(request),body
      )
    };
  }

  @Get("payroll-statements")
  @RequirePermission("service.read")
  async payrollStatements(
    @Req() request:AuthenticatedRequest,
    @Query("month") month?:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.payrollStatements(
        this.context(request),month
      )
    };
  }

  @Post("payroll-statements/:statementId/review")
  @RequirePermission("service.read")
  async reviewPayrollStatement(
    @Req() request:AuthenticatedRequest,
    @Param("statementId") statementId:string,
    @Body() body:{
      status:"ACKNOWLEDGED"|"DISPUTED";
      comment?:string;
    }
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.reviewPayrollStatement(
        this.context(request),statementId,body
      )
    };
  }

  @Post("payroll-reviews/:reviewId/resolve")
  @RequirePermission("service.write")
  async resolvePayrollReview(
    @Req() request:AuthenticatedRequest,
    @Param("reviewId") reviewId:string,
    @Body() body:{
      status:"RESOLVED"|"WAIVED";
      comment:string;
    }
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.resolvePayrollReview(
        this.context(request),reviewId,body
      )
    };
  }

  @Post("payroll-statements/finalize")
  @RequirePermission("service.write")
  async finalizePayroll(
    @Req() request:AuthenticatedRequest,
    @Body() body:{month?:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.economics.finalizePayroll(
        this.context(request),body?.month
      )
    };
  }

  private context(request:AuthenticatedRequest):TenantContext{
    const auth=request.auth!;
    return {
      tenantId:auth.tenantId,
      userId:auth.userId,
      membershipId:auth.membershipId
    };
  }
}
