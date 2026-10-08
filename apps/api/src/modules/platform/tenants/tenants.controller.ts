import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess } from "@corebiz/contracts";
import { AuthService } from "../auth/auth.service";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { TenantsService } from "./tenants.service";

@Controller("tenants")
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly auth: AuthService
  ) {}

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string }
  ): Promise<ApiSuccess<{
    tenantId: string;
    membershipId: string;
    tenantName: string;
  }>> {
    const current = request.auth!;
    const created = await this.tenants.createTenant(current.userId, body.name);

    await this.auth.switchTenant(
      current.sessionId,
      current.userId,
      created.membershipId
    );

    return { ok: true, data: created };
  }

  @Post("invite")
  async invite(
    @Req() request: AuthenticatedRequest,
    @Body() body: { email: string }
  ): Promise<ApiSuccess<{
    invitationId: string;
    expiresAt: string;
    developmentToken?: string;
  }>> {
    const current = request.auth!;
    if (!current.isOwner) {
      throw new ForbiddenException("Приглашать сотрудников может владелец компании");
    }

    const invitation = await this.tenants.createInvitation(
      {
        tenantId: current.tenantId,
        userId: current.userId,
        membershipId: current.membershipId
      },
      body.email
    );

    return {
      ok: true,
      data: {
        invitationId: invitation.invitationId,
        expiresAt: invitation.expiresAt,
        ...(process.env.NODE_ENV !== "production"
          ? { developmentToken: invitation.token }
          : {})
      }
    };
  }

  @Post("accept-invitation")
  async acceptInvitation(
    @Req() request: AuthenticatedRequest,
    @Body() body: { token: string }
  ): Promise<ApiSuccess<{ tenantId: string; membershipId: string }>> {
    const current = request.auth!;
    const accepted = await this.tenants.acceptInvitation(
      current.userId,
      current.email,
      body.token
    );

    return { ok: true, data: accepted };
  }
}
