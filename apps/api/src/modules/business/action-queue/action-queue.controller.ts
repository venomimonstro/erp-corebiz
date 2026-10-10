import {
  Body,
  Controller,
  Get,
  Put,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { ActionQueueService } from "./action-queue.service";

@Controller("action-queue")
export class ActionQueueController {
  constructor(private readonly queueService: ActionQueueService) {}

  @Get()
  async queue(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.queueService.queue(this.context(request))
    };
  }

  @Put("state")
  async state(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      sourceKey: string;
      state: "UNREAD" | "READ" | "SNOOZED";
      snoozedUntil?: string;
    }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.queueService.setState(this.context(request), body);
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
