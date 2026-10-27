import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiSuccess } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { parseCookie, SESSION_COOKIE } from "../auth/auth.utils";
import { PlatformOperationsService } from "./platform-operations.service";

function pageNumber(raw: string | undefined, fallback: number,
                    min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new BadRequestException("Некорректная страница");
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw new BadRequestException("Некорректная страница");
  }
  return num;
}

@Controller("platform-operations")
export class PlatformOperationsController {
  constructor(private readonly platform: PlatformOperationsService) {}

  @Get("summary")
  async summary(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): Promise<ApiSuccess<Record<string, number>>> {
    response.setHeader("Cache-Control", "no-store, private");
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
    return {
      ok: true,
      data: await this.platform.summary(request.auth!.userId, token)
    };
  }

  @Get("tenants/:id/suspensions")
  async suspensionHistory(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const session = parseCookie(request.headers.cookie, SESSION_COOKIE);
    return {
      ok: true,
      data: await this.platform.suspensionHistory(
        request.auth!.userId,session,id
      )
    };
  }

  @Patch("tenants/:id/suspension")
  async suspension(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id: string,
    @Body() body: {action?: "SUSPEND" | "RESUME";reason?: string}
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const session = parseCookie(request.headers.cookie, SESSION_COOKIE);
    return {
      ok: true,
      data: await this.platform.setSuspension(
        request.auth!.userId, session, id,
        body?.action as "SUSPEND" | "RESUME", body?.reason ?? ""
      )
    };
  }

  @Get("support/tickets")
  async supportQueue(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Query("limit") limitInput?: string,
    @Query("offset") offsetInput?: string
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.supportQueue(
        request.auth!.userId,
        session,
        pageNumber(limitInput,50,1,100),
        pageNumber(offsetInput,0,0,100000)
      )
    };
  }

  @Get("support/tickets/:id")
  async supportTicket(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id:string
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.supportTicket(
        request.auth!.userId,session,id
      )
    };
  }

  @Post("support/tickets/:id/reply")
  async supportReply(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id:string,
    @Body() body:{body?:string}
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.supportReply(
        request.auth!.userId,session,id,body?.body??""
      )
    };
  }

  @Patch("support/tickets/:id/close")
  async supportClose(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id:string,
    @Body() body:{resolution?:string}
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.supportClose(
        request.auth!.userId,session,id,body?.resolution??""
      )
    };
  }

  @Get("support/attachments/:id/download")
  async supportAttachmentDownload(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id:string
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.supportAttachmentDownload(
        request.auth!.userId,session,id
      )
    };
  }

  @Post("support/diagnostics/claim")
  async claimSupportDiagnostics(
    @Req() request:AuthenticatedRequest,
    @Res({passthrough:true}) response:Response,
    @Body() body:{token?:string}
  ):Promise<ApiSuccess<unknown>>{
    response.setHeader("Cache-Control","no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.claimSupportDiagnostics(
        request.auth!.userId,session,body?.token??""
      )
    };
  }

  @Get("support/diagnostics/:id")
  async supportDiagnostics(
    @Req() request:AuthenticatedRequest,
    @Res({passthrough:true}) response:Response,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>>{
    response.setHeader("Cache-Control","no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.supportDiagnostics(
        request.auth!.userId,session,id
      )
    };
  }

  @Post("support/diagnostics/:id/end")
  async endSupportDiagnostics(
    @Req() request:AuthenticatedRequest,
    @Res({passthrough:true}) response:Response,
    @Param("id") id:string
  ):Promise<ApiSuccess<{ended:true}>>{
    response.setHeader("Cache-Control","no-store, private");
    const session=parseCookie(request.headers.cookie,SESSION_COOKIE);
    return {
      ok:true,
      data:await this.platform.endSupportDiagnostics(
        request.auth!.userId,session,id
      )
    };
  }

  @Get("tenants")
  async tenants(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Query("limit") limitInput?: string,
    @Query("offset") offsetInput?: string
  ): Promise<ApiSuccess<unknown>> {
    response.setHeader("Cache-Control", "no-store, private");
    const limit = pageNumber(limitInput, 25, 1, 100);
    const offset = pageNumber(offsetInput, 0, 0, 100000);
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
    return {
      ok: true,
      data: await this.platform.tenants(
        request.auth!.userId, token, limit, offset
      )
    };
  }
}
