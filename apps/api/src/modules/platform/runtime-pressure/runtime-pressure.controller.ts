import {
  Controller,
  Get,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { RuntimePressureService } from "./runtime-pressure.service";

@Controller("runtime-pressure")
export class RuntimePressureController {
  constructor(private readonly runtime: RuntimePressureService) {}

  @Get("overview")
  @RequirePermission("runtime.pressure.read")
  async overview(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.runtime.overview(this.context(request))
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
