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

  @Post("feedback")
  @RequirePermission("pilot.manage")
  async feedback(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      category: "BUG" | "UX" | "SPEC_GAP" | "FEATURE";
      priority?: "P0" | "P1" | "P2" | "P3" | "P4";
      title: string;
      description?: string;
      screenPath?: string;
      sourceIncidentId?: string;
      sourceTicketId?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.pilot.createFeedback(this.context(request), body)
    };
  }

  @Post("feedback/:id/triage")
  @RequirePermission("pilot.manage")
  async triageFeedback(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      disposition: "CORE" | "MODULE" | "CONFIG" | "EXTENSION" | "REJECT";
      rootCause?: string;
      remediation?: string;
      ownerMembershipId?: string;
      releaseBlocking?: boolean;
    }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.pilot.triageFeedback(this.context(request), id, body);
    return { ok: true, data: { updated: true } };
  }

  @Post("feedback/:id/advance")
  @RequirePermission("pilot.manage")
  async advanceFeedback(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      status: "IN_PROGRESS" | "VERIFY" | "DONE";
      fixVersion?: string;
      verificationReference?: string;
    }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.pilot.advanceFeedback(this.context(request), id, body);
    return { ok: true, data: { updated: true } };
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
