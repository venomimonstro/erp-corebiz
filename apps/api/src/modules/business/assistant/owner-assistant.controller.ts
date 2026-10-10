import {
  Controller,
  Get,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { OwnerAssistantService } from "./owner-assistant.service";

@Controller("assistant")
export class OwnerAssistantController {
  constructor(private readonly assistant: OwnerAssistantService) {}

  @Get("owner/brief")
  @RequirePermission("dashboard.owner.read")
  async brief(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.assistant.brief(this.context(request))
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
