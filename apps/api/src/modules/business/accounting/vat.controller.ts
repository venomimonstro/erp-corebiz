import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { VatService } from "./vat.service";

@Controller("accounting/vat")
export class VatController {
  constructor(private readonly vat:VatService) {}
  @Get("documents")
  @RequirePermission("accounting.read")
  async documents(@Req() req:AuthenticatedRequest,@Query("legalEntityId") legalEntityId:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.vat.documents(this.ctx(req),legalEntityId)};
  }
  @Post("documents")
  @RequirePermission("accounting.policy.manage")
  async createDraft(@Req() req:AuthenticatedRequest,@Body() body:{
    legalEntityId:string;documentKind:"ISSUED_INVOICE"|"RECEIVED_INVOICE"|"UPD"|"CORRECTION";
    documentNumber:string;documentDate:string;counterpartyId?:string;
    sourceType:string;sourceId:string;currency?:string;
    taxableBaseMinor:string;vatAmountMinor:string;rateCode:string;
  }):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.vat.createDraft(this.ctx(req),body)};
  }
  @Get("register")
  @RequirePermission("accounting.read")
  async entries(@Req() req:AuthenticatedRequest,@Query("legalEntityId") legalEntityId:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.vat.registerEntries(this.ctx(req),legalEntityId)};
  }
  private ctx(req:AuthenticatedRequest):TenantContext {
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
