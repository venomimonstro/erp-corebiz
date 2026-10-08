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
import { WorkflowService } from "./workflow.service";

@Controller("workflows")
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService) {}

  @Get()
  @RequirePermission("workflow.manage")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflows.list(this.context(request))
    };
  }

  @Post()
  @RequirePermission("workflow.manage")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      name: string;
      triggerEvent: string;
      entityType?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflows.createDefinition(
        this.context(request),
        body
      )
    };
  }

  @Post(":id/versions")
  @RequirePermission("workflow.manage")
  async draft(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflows.createDraft(
        this.context(request),
        id,
        body
      )
    };
  }

  @Post("versions/:id/test")
  @RequirePermission("workflow.manage")
  async test(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { payload: Record<string, unknown> }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflows.test(
        this.context(request),
        id,
        body.payload ?? {}
      )
    };
  }

  @Post("versions/:id/publish")
  @RequirePermission("workflow.manage")
  async publish(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ published: true }>> {
    await this.workflows.publish(this.context(request), id);
    return { ok: true, data: { published: true } };
  }

  @Get("executions")
  @RequirePermission("workflow.manage")
  async executions(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workflows.executions(this.context(request))
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
