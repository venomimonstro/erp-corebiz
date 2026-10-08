import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { CrmService } from "./crm.service";

@Controller("crm")
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get("board")
  @RequirePermission("crm.read")
  async board(
    @Req() request: AuthenticatedRequest,
    @Query("pipelineId") pipelineId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.crm.board(this.context(request), pipelineId)
    };
  }

  @Post("deals")
  @RequirePermission("crm.write")
  async createDeal(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      title: string;
      pipelineId?: string;
      stageId?: string;
      partyId?: string;
      amountMinor?: string;
      responsibleMembershipId?: string;
      source?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.crm.createDeal(this.context(request), body)
    };
  }

  @Patch("deals/:id/stage")
  @RequirePermission("crm.write")
  async moveDeal(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      toStageId: string;
      version: number;
      lostReason?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.crm.moveDeal(this.context(request), id, body)
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
