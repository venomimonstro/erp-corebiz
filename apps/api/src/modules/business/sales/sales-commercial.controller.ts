import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { SalesService } from "./sales.service";

@Controller("sales/commercial")
export class SalesCommercialController {
  constructor(private readonly sales: SalesService) {}

  @Get("parties/:partyId/terms")
  @RequirePermission("sales.read")
  async terms(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sales.commercialTerms(
        this.context(request),
        partyId
      )
    };
  }

  @Patch("parties/:partyId/terms")
  @RequirePermission("sales.write")
  async setTerms(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string,
    @Body() body: any
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.sales.setCommercialTerms(
      this.context(request),
      partyId,
      body
    );
    return { ok: true, data: { updated: true } };
  }

  @Get("parties/:partyId/prices")
  @RequirePermission("sales.read")
  async prices(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sales.partyPrices(
        this.context(request),
        partyId
      )
    };
  }

  @Post("parties/:partyId/prices")
  @RequirePermission("sales.write")
  async addPrice(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sales.addPartyPrice(
        this.context(request),
        partyId,
        body
      )
    };
  }

  @Patch("parties/:partyId/prices/:priceId/archive")
  @RequirePermission("sales.write")
  async archivePrice(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string,
    @Param("priceId") priceId: string
  ): Promise<ApiSuccess<{ archived: true }>> {
    await this.sales.archivePartyPrice(
      this.context(request),
      partyId,
      priceId
    );
    return { ok: true, data: { archived: true } };
  }

  private context(request: AuthenticatedRequest): TenantContext {
    const auth = request.auth!;
    return {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };
  }
}
