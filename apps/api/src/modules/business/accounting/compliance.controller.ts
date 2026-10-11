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
import { ComplianceService } from "./compliance.service";

@Controller("accounting/compliance")
export class ComplianceController {
  constructor(private readonly compliance:ComplianceService) {}

  @Get("profile")
  @RequirePermission("accounting.compliance.read")
  async profile(
    @Req() req:AuthenticatedRequest,
    @Query("legalEntityId") legalEntityId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.profile(this.context(req),legalEntityId)
    };
  }

  @Post("profile")
  @RequirePermission("accounting.compliance.manage")
  async saveProfile(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.saveProfile(this.context(req),body)
    };
  }

  @Post("tax-ledger/sync")
  @RequirePermission("accounting.compliance.manage")
  async syncLedger(
    @Req() req:AuthenticatedRequest,
    @Body() body:{legalEntityId:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.syncTaxLedger(
        this.context(req),body.legalEntityId
      )
    };
  }

  @Get("tax-ledger")
  @RequirePermission("accounting.compliance.read")
  async taxLedger(
    @Req() req:AuthenticatedRequest,
    @Query("legalEntityId") legalEntityId:string,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.taxLedger(
        this.context(req),legalEntityId,from,to
      )
    };
  }

  @Post("tax-ledger/:id/review")
  @RequirePermission("accounting.compliance.manage")
  async reviewLedger(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{treatment:"INCLUDED"|"EXCLUDED";reason:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.reviewTaxLedgerItem(
        this.context(req),id,body
      )
    };
  }

  @Post("calculations/usn-preview")
  @RequirePermission("accounting.compliance.manage")
  async usnPreview(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.usnPreview(this.context(req),body)
    };
  }

  @Post("calculations/:id/confirm")
  @RequirePermission("accounting.compliance.approve")
  async confirmCalculation(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{obligationId?:string;note:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.confirmCalculation(
        this.context(req),id,body
      )
    };
  }

  @Post("calendar/generate")
  @RequirePermission("accounting.compliance.manage")
  async generateCalendar(
    @Req() req:AuthenticatedRequest,
    @Body() body:{legalEntityId:string;from:string;to:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.generateCalendar(this.context(req),body)
    };
  }

  @Get("obligations")
  @RequirePermission("accounting.compliance.read")
  async obligations(
    @Req() req:AuthenticatedRequest,
    @Query("legalEntityId") legalEntityId:string,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.obligations(
        this.context(req),legalEntityId,from,to
      )
    };
  }

  @Post("obligations/:id/packet")
  @RequirePermission("accounting.compliance.manage")
  async preparePacket(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.preparePacket(this.context(req),id)
    };
  }

  @Post("obligations/:id/packet/validate")
  @RequirePermission("accounting.compliance.approve")
  async validatePacket(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{note:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.validatePacket(
        this.context(req),id,body
      )
    };
  }

  @Post("obligations/:id/approve")
  @RequirePermission("accounting.compliance.approve")
  async approve(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.approveObligation(this.context(req),id)
    };
  }

  @Post("obligations/:id/submitted")
  @RequirePermission("accounting.compliance.approve")
  async recordSubmitted(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{provider:string;externalReference:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.recordSubmitted(
        this.context(req),id,body
      )
    };
  }

  @Post("obligations/:id/receipt")
  @RequirePermission("accounting.compliance.approve")
  async recordReceipt(
    @Req() req:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.recordReceipt(
        this.context(req),id,body
      )
    };
  }

  @Get("connectors")
  @RequirePermission("accounting.compliance.read")
  async connectors(
    @Req() req:AuthenticatedRequest,
    @Query("legalEntityId") legalEntityId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.connectors(
        this.context(req),legalEntityId
      )
    };
  }

  @Post("connectors")
  @RequirePermission("accounting.compliance.manage")
  async saveConnector(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.saveConnector(this.context(req),body)
    };
  }

  @Get("ens")
  @RequirePermission("accounting.compliance.read")
  async ens(
    @Req() req:AuthenticatedRequest,
    @Query("legalEntityId") legalEntityId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.ensSnapshots(
        this.context(req),legalEntityId
      )
    };
  }

  @Post("ens")
  @RequirePermission("accounting.compliance.manage")
  async addEns(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.compliance.addEnsSnapshot(this.context(req),body)
    };
  }

  private context(req:AuthenticatedRequest):TenantContext {
    const auth=req.auth!;
    return {
      tenantId:auth.tenantId,
      userId:auth.userId,
      membershipId:auth.membershipId
    };
  }
}
