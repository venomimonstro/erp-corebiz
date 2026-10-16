import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
