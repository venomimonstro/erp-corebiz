import {
  BadRequestException,
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
import { EmailVerificationService } from "./email-verification.service";
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
    private readonly rateLimit: AuthRateLimitService,
    private readonly verification: EmailVerificationService
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
  @Post("register-invited")
  async registerInvited(
    @Req() request:AuthenticatedRequest,
    @Body() body:unknown,
    @Res({passthrough:true}) response:Response
  ):Promise<ApiSuccess<{auth:unknown}>>{
    await this.rateLimit.assertRegistrationAllowed(request.ip??"unknown");
    if(!body || typeof body!=="object" || Array.isArray(body))
      throw new BadRequestException("Некорректные данные");
    const b=body as Record<string,unknown>;
    if(typeof b.email!=="string"||typeof b.password!=="string"||
       typeof b.invitationToken!=="string")
      throw new BadRequestException("Укажите email, пароль и приглашение");
    const result=await this.authService.registerInvited({
      email:b.email,password:b.password,invitationToken:b.invitationToken
    });
    setSessionCookie(response,result.token);
    return {ok:true,data:{auth:result.auth}};
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

  @Public()
  @Post("password-reset/request")
  async requestPasswordReset(
    @Req() request: AuthenticatedRequest,
    @Body() body: {email?:unknown}
  ): Promise<ApiSuccess<{accepted:true}>> {
    await this.rateLimit.assertPasswordResetAllowed(
      request.ip ?? "unknown",
      typeof body?.email === "string" ? body.email : ""
    );
    await this.authService.requestPasswordReset(body?.email);
    return {ok:true,data:{accepted:true}};
  }

  @Public()
  @Post("password-reset/complete")
  async completePasswordReset(
    @Req() request: AuthenticatedRequest,
    @Body() body: {token?:unknown;password?:unknown}
  ): Promise<ApiSuccess<{changed:true}>> {
    await this.rateLimit.assertRecoveryCompletionAllowed(
      request.ip ?? "unknown"
    );
    await this.authService.completePasswordReset(
      body?.token, body?.password
    );
    return {ok:true,data:{changed:true}};
  }

  @Get("email-verification/status")
  async verificationStatus(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<{verified:boolean;email:string}>> {
    return {
      ok: true,
      data: await this.verification.status(request.auth!.userId)
    };
  }

  @Post("email-verification/request")
  async verificationRequest(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<{queued:boolean;verified:boolean}>> {
    await this.rateLimit.assertEmailVerificationAllowed(
      request.ip ?? "unknown", request.auth!.userId
    );
    return {
      ok: true,
      data: await this.verification.request(request.auth!.userId)
    };
  }

  @Public()
  @Post("email-verification/complete")
  async verificationComplete(
    @Req() request: AuthenticatedRequest,
    @Body() body: {token?:unknown}
  ): Promise<ApiSuccess<{verified:true}>> {
    await this.rateLimit.assertRecoveryCompletionAllowed(
      request.ip ?? "unknown"
    );
    return {
      ok: true,
      data: await this.verification.complete(body?.token)
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
