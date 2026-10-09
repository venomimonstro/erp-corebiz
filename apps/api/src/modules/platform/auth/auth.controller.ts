import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiSuccess } from "@corebiz/contracts";
import { AuthRateLimitService } from "./auth-rate-limit.service";
import { AuthService } from "./auth.service";
import { parseLoginPayload, parseRegisterPayload, parseMembershipPayload } from "./auth-payload";
import type { AuthenticatedRequest } from "./auth.types";
import {
  clearSessionCookie,
  setSessionCookie
} from "./auth.utils";
import { Public } from "./public.decorator";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimit: AuthRateLimitService
  ) {}

  @Public()
  @Post("register")
  async register(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response
  ): Promise<ApiSuccess<{ auth: unknown }>> {
    await this.rateLimit.assertRegistrationAllowed(request.ip ?? "unknown");

    const result = await this.authService.register(parseRegisterPayload(body));
    setSessionCookie(response, result.token);

    return {
      ok: true,
      data: { auth: result.auth }
    };
  }

  @Public()
  @Post("login")
  async login(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response
  ): Promise<ApiSuccess<{ auth: unknown }>> {
    const ip = request.ip ?? "unknown";

    const payload = parseLoginPayload(body);
    await this.rateLimit.assertLoginAllowed(ip, payload.email);
    const result = await this.authService.login(payload);
    await this.rateLimit.resetLogin(ip, payload.email);

    setSessionCookie(response, result.token);

    return {
      ok: true,
      data: { auth: result.auth }
    };
  }

  @Post("logout")
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): Promise<ApiSuccess<{ loggedOut: true }>> {
    if (request.auth) {
      await this.authService.logout(request.auth.sessionId);
    }

    clearSessionCookie(response);

    return {
      ok: true,
      data: { loggedOut: true }
    };
  }

  @Get("me")
  async me(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<{
    auth: NonNullable<AuthenticatedRequest["auth"]>;
    memberships: Awaited<ReturnType<AuthService["listMemberships"]>>;
  }>> {
    const auth = request.auth!;
    const memberships = await this.authService.listMemberships(auth.userId);

    return {
      ok: true,
      data: { auth, memberships }
    };
  }

  @Post("switch-tenant")
  async switchTenant(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ): Promise<ApiSuccess<{ switched: true }>> {
    const auth = request.auth!;
    await this.authService.switchTenant(
      auth.sessionId,
      auth.userId,
      parseMembershipPayload(body)
    );

    return {
      ok: true,
      data: { switched: true }
    };
  }
}
