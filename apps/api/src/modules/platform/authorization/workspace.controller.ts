import {
  Controller,
  Get,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { AuthorizationService } from "./authorization.service";

@Controller("workspace")
export class WorkspaceController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Get("context")
  async context(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    const auth = request.auth!;
    const context: TenantContext = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };

    return {
      ok: true,
      data: await this.authorization.workspaceContext(context)
    };
  }
}
