import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess,TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { TaxComplianceService } from "./tax-compliance.service";

@Controller("accounting/tax")
export class TaxComplianceController {
  constructor(private readonly tax:TaxComplianceService){}

  @Get("dashboard")
  @RequirePermission("accounting.compliance.read")
  async dashboard(
    @Req() req:AuthenticatedRequest,
    @Query("legalEntityId") legalEntityId:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.dashboard(this.ctx(req),legalEntityId)};
  }

  @Post("profile")
  @RequirePermission("accounting.compliance.manage")
  async saveProfile(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.saveProfile(this.ctx(req),body)};
  }

  @Post("calendar/generate")
  @RequirePermission("accounting.compliance.manage")
  async generateCalendar(
    @Req() req:AuthenticatedRequest,
    @Body() body:{legalEntityId:string;year:number}
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.generateCalendar(this.ctx(req),body)};
  }

  @Post("payments/auto-classify")
  @RequirePermission("accounting.compliance.manage")
  async autoClassify(
    @Req() req:AuthenticatedRequest,
    @Body() body:{legalEntityId:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.tax.autoClassifyPayments(this.ctx(req),body.legalEntityId)
    };
  }

  @Get("payments/classifications")
  @RequirePermission("accounting.compliance.read")
  async classifications(
    @Req() req:AuthenticatedRequest,
    @Query("legalEntityId") legalEntityId:string,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.tax.classifications(
        this.ctx(req),legalEntityId,from,to
      )
    };
  }

  @Patch("payments/:paymentId/classification")
  @RequirePermission("accounting.compliance.manage")
  async classify(
    @Req() req:AuthenticatedRequest,
    @Param("paymentId") paymentId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.tax.classifyPayment(this.ctx(req),{
        ...body,
        paymentId
      })
    };
  }

  @Post("calculations/usn")
  @RequirePermission("accounting.compliance.manage")
  async calculateUsn(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.calculateUsn(this.ctx(req),body)};
  }

  @Post("calculations/:id/confirm")
  @RequirePermission("accounting.compliance.approve")
  async confirmCalculation(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.tax.confirmCalculation(this.ctx(req),id)
    };
  }

  @Post("obligations/:id/packet")
  @RequirePermission("accounting.compliance.manage")
  async preparePacket(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.preparePacket(this.ctx(req),id)};
  }

  @Post("packets/:id/validate")
  @RequirePermission("accounting.compliance.manage")
  async validatePacket(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{valid:boolean;errors?:string[]}
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.validatePacket(this.ctx(req),id,body)};
  }

  @Post("packets/:id/signature")
  @RequirePermission("accounting.compliance.approve")
  async recordSignature(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{signatureReference:string;certificateFingerprint:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.tax.recordPacketSignature(this.ctx(req),id,body)
    };
  }

  @Post("obligations/:id/approve")
  @RequirePermission("accounting.compliance.approve")
  async approveObligation(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{note?:string}
  ):Promise<ApiSuccess<unknown>>{
    return {
      ok:true,
      data:await this.tax.approveObligation(this.ctx(req),id,body.note)
    };
  }

  @Post("obligations/:id/queue")
  @RequirePermission("accounting.compliance.approve")
  async queueSubmission(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.queueSubmission(this.ctx(req),id)};
  }

  @Post("ens")
  @RequirePermission("accounting.compliance.manage")
  async recordEns(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.tax.recordEns(this.ctx(req),body)};
  }

  private ctx(req:AuthenticatedRequest):TenantContext{
    const auth=req.auth!;
    return {
      tenantId:auth.tenantId,
      userId:auth.userId,
      membershipId:auth.membershipId
    };
  }
}
