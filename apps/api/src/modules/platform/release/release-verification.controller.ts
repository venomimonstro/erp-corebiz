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
import { ReleaseVerificationService } from "./release-verification.service";

@Controller("release")
export class ReleaseVerificationController {
  constructor(
    private readonly release: ReleaseVerificationService
  ) {}

  @Get("overview")
  @RequirePermission("release.read")
  async overview(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.release.overview(this.context(request))
    };
  }

  @Get("candidates")
  @RequirePermission("release.read")
  async candidates(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.release.candidates(this.context(request))
    };
  }

  @Post("candidates")
  @RequirePermission("release.manage")
  async createCandidate(
    @Req() request: AuthenticatedRequest,
    @Body() body: { targetVersion: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.release.createCandidate(
        this.context(request),
        body.targetVersion
      )
    };
  }

  @Post("candidates/:id/evaluate")
  @RequirePermission("release.manage")
  async evaluateCandidate(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.release.evaluateCandidate(
        this.context(request),
        id
      )
    };
  }

  @Post("candidates/:id/review")
  @RequirePermission("release.approve")
  async reviewCandidate(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      decision: "APPROVE" | "REJECT";
      reason?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.release.reviewCandidate(
        this.context(request),
        id,
        body
      )
    };
  }

  @Post("evidence")
  @RequirePermission("release.manage")
  async evidence(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      component: string;
      targetVersion: string;
      kind: string;
      outcome: string;
      evidenceReference: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.release.record(this.context(request), body)
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
