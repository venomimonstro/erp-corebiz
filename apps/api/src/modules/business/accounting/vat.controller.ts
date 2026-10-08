import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
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
  @Post("documents/:documentId/approve")
  @RequirePermission("accounting.policy.manage")
  async approve(@Req() req:AuthenticatedRequest,@Param("documentId") documentId:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.vat.approveDocument(this.ctx(req),documentId)};
  }
  @Post("register")
  @RequirePermission("accounting.post")
  async register(@Req() req:AuthenticatedRequest,@Body() body:{
    documentId:string;eventDate:string;registerKind:"OUTPUT_VAT"|"INPUT_VAT"|"CORRECTION";
  }):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.vat.registerDocument(this.ctx(req),body)};
  }
  private ctx(req:AuthenticatedRequest):TenantContext {
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }
}
