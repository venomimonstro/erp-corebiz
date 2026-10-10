import {
  Body,
  Controller,
  Get,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { GoLiveService } from "./go-live.service";

@Controller("go-live")
export class GoLiveController {
  constructor(private readonly goLive: GoLiveService) {}

  @Get("readiness")
  @RequirePermission("go_live.read")
  async readiness(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.goLive.readiness(this.context(request))
    };
  }

  @Post("review")
  @RequirePermission("go_live.manage")
  async review(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      decision: "GO" | "NO_GO";
      note?: string;
      hypercareDays?: number;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.goLive.review(this.context(request), body)
    };
  }

  @Post("finish-hypercare")
  @RequirePermission("go_live.manage")
  async finishHypercare(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.goLive.finishHypercare(this.context(request));
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
