import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess } from "@corebiz/contracts";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { AuthService } from "../auth/auth.service";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { TenantsService } from "./tenants.service";

function requiredField(body: unknown, key: string, min: number, max: number): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Некорректные данные");
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw new BadRequestException("Некорректное значение: " + key);
  }
  return value.trim();
}

@Controller("tenants")
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly auth: AuthService
  ) {}

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ): Promise<ApiSuccess<{
    tenantId: string;
    membershipId: string;
    tenantName: string;
  }>> {
    const current = request.auth!;
    const created = await this.tenants.createTenant(current.userId, requiredField(body, "name", 2, 160));

    await this.auth.switchTenant(
      current.sessionId,
      current.userId,
      created.membershipId
    );

    return { ok: true, data: created };
  }

  @Post("invite")
  @RequirePermission("users.manage")
  async invite(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ): Promise<ApiSuccess<{
    invitationId: string;
    expiresAt: string;
    developmentToken?: string;
  }>> {
    const current = request.auth!;

    const invitation = await this.tenants.createInvitation(
      {
        tenantId: current.tenantId,
        userId: current.userId,
        membershipId: current.membershipId
      },
      requiredField(body, "email", 3, 254)
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
    @Body() body: unknown
  ): Promise<ApiSuccess<{ tenantId: string; membershipId: string }>> {
    const current = request.auth!;
    const accepted = await this.tenants.acceptInvitation(
      current.userId,
      current.email,
      requiredField(body, "token", 32, 256)
    );

    return { ok: true, data: accepted };
  }
}
