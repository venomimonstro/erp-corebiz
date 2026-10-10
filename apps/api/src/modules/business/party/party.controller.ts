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
import { PartyService } from "./party.service";

@Controller("crm/customers")
export class PartyController {
  constructor(private readonly parties: PartyService) {}

  @Get()
  @RequirePermission("crm.read")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    const context = this.context(request);
    return { ok: true, data: await this.parties.list(context) };
  }

  @Get(":partyId/assets")
  @RequirePermission("crm.read")
  async assets(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.parties.assets(this.context(request), partyId)
    };
  }

  @Post(":partyId/assets")
  @RequirePermission("crm.write")
  async createAsset(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.parties.createAsset(
        this.context(request),
        partyId,
        body
      )
    };
  }

  @Patch("assets/:assetId")
  @RequirePermission("crm.write")
  async updateAsset(
    @Req() request: AuthenticatedRequest,
    @Param("assetId") assetId: string,
    @Body() body: any
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.parties.updateAsset(
      this.context(request),
      assetId,
      body
    );
    return { ok: true, data: { updated: true } };
  }

  @Post()
  @RequirePermission("crm.write")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      type?: "PERSON" | "ORGANIZATION";
      displayName: string;
      phone?: string;
      email?: string;
      responsibleMembershipId?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    const context = this.context(request);
    return { ok: true, data: await this.parties.create(context, body) };
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
