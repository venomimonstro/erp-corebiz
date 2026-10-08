import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { WorkflowService } from "./workflow.service";

@Controller("workflows")
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get()
  @RequirePermission("workflow.manage")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.workflow.list(this.context(request)) };
  }

  @Post()
  @RequirePermission("workflow.manage")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string; triggerEvent: string; entityType?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflow.create(this.context(request), body)
    };
  }

  @Post(":id/versions")
  @RequirePermission("workflow.manage")
  async createDraft(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { conditions?: any[]; actions: any[] }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflow.createDraft(this.context(request), id, body)
    };
  }

  @Post("versions/:versionId/test")
  @RequirePermission("workflow.manage")
  async test(
    @Req() request: AuthenticatedRequest,
    @Param("versionId") versionId: string,
    @Body() body: { payload: Record<string, unknown> }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflow.test(
        this.context(request),
        versionId,
        body.payload ?? {}
      )
    };
  }

  @Post("versions/:versionId/publish")
  @RequirePermission("workflow.manage")
  async publish(
    @Req() request: AuthenticatedRequest,
    @Param("versionId") versionId: string
  ): Promise<ApiSuccess<{ published: true }>> {
    await this.workflow.publish(this.context(request), versionId);
    return { ok: true, data: { published: true } };
  }

  @Get("executions")
  @RequirePermission("workflow.manage")
  async executions(
    @Req() request: AuthenticatedRequest,
    @Query("workflowId") workflowId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflow.executions(this.context(request), workflowId)
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
