import { Body, Controller, Get, Post, Req } from "@nestjs/common";
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
