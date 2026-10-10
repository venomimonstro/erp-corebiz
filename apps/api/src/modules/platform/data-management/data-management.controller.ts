import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import { ApiCost } from "../../../infrastructure/http/api-cost.decorator";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { DataManagementService } from "./data-management.service";

@Controller("data-management")
export class DataManagementController {
  constructor(private readonly data: DataManagementService) {}

  @Post("exports")
  @ApiCost("EXPENSIVE")
  @RequirePermission("data.export")
  async requestExport(
    @Req() request: AuthenticatedRequest,
    @Body() body: { format?: "JSON_GZIP" | "CSV_GZIP" }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.data.requestExport(this.context(request), body)
    };
  }

  @Get("exports")
  @RequirePermission("data.export")
  async exports(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.data.exports(this.context(request))
    };
  }

  @Get("exports/:id/download")
  @ApiCost("HEAVY")
  @RequirePermission("data.export")
  async download(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Res() response: Response
  ): Promise<void> {
    const file = await this.data.artifact(this.context(request), id);

    response.setHeader("Content-Type", file.contentType);
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="' +
        file.filename.replace(/[^A-Za-z0-9._-]/g, "_") +
        '"'
    );
    response.setHeader("X-Checksum-SHA256", file.checksumSha256);
    response.setHeader("Cache-Control", "private, no-store");
    response.end(file.artifact);
  }

  @Post("offboarding/review")
  @ApiCost("HEAVY")
  @RequirePermission("data.offboarding.read")
  async offboardingReview(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.data.offboardingReview(this.context(request))
    };
  }

  @Get("offboarding/reviews")
  @RequirePermission("data.offboarding.read")
  async offboardingHistory(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.data.offboardingHistory(this.context(request))
    };
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
