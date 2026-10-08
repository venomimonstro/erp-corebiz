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
import { TasksService } from "./tasks.service";

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermission("tasks.read")
  async list(
    @Req() request: AuthenticatedRequest,
    @Query("filter") filter?: "all" | "today" | "overdue" | "mine"
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tasks.list(this.context(request), filter ?? "all")
    };
  }

  @Post()
  @RequirePermission("tasks.write")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      title: string;
      type?: string;
      priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      dueAt?: string;
      responsibleMembershipId?: string;
      linkedType?: string;
      linkedId?: string;
      description?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tasks.create(this.context(request), body)
    };
  }

  @Patch(":id/state")
  @RequirePermission("tasks.write")
  async move(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      state: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.tasks.move(this.context(request), id, body.state)
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
