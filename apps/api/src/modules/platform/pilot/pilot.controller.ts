import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { PilotService } from "./pilot.service";

@Controller("pilot")
export class PilotController {
  constructor(private readonly pilot: PilotService) {}

  @Get("overview")
  @RequirePermission("pilot.read")
  async overview(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.pilot.overview(this.context(request))
    };
  }

  @Post("enroll")
  @RequirePermission("pilot.manage")
  async enroll(
    @Req() request: AuthenticatedRequest,
    @Body() body: { cohortCode: string; targetEndAt?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.pilot.enroll(this.context(request), body)
    };
  }

  @Post("transition")
  @RequirePermission("pilot.manage")
  async transition(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      status:
        | "PLANNED"
        | "READY"
        | "RUNNING"
        | "PAUSED"
        | "COMPLETED"
        | "STOPPED";
      reason?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.pilot.transition(
        this.context(request),
        body.status,
        body.reason
      )
    };
  }

  @Post("snapshots")
  @RequirePermission("pilot.manage")
  async snapshot(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.pilot.captureSnapshot(this.context(request))
    };
  }

  @Post("exit-review")
  @RequirePermission("pilot.manage")
  async exitReview(
    @Req() request: AuthenticatedRequest,
    @Body() body: { note?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.pilot.evaluateExit(
        this.context(request),
        body.note
      )
    };
  }

  @Post("incidents")
  @RequirePermission("pilot.manage")
  async incident(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      severity: "P0" | "P1" | "P2" | "P3";
      code: string;
      summary: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.pilot.openIncident(this.context(request), body)
    };
  }

  @Post("incidents/:id/resolve")
  @RequirePermission("pilot.manage")
  async resolve(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { resolutionNote: string }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.pilot.resolveIncident(
      this.context(request),
      id,
      body.resolutionNote
    );
    return { ok: true, data: { updated: true } };
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
