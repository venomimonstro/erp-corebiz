import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ProjectsService } from "./projects.service";

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission("projects.read")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.projects.list(this.context(request)) };
  }

  @Get("agency/overview")
  @RequirePermission("projects.read")
  async agencyOverview(
    @Req() request:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.projects.agencyOverview(this.context(request))
    };
  }

  @Get(":id/expenses")
  @RequirePermission("projects.read")
  async expenses(@Req() request:AuthenticatedRequest,@Param("id") id:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.projects.agencyExpenses(this.context(request),id)};
  }

  @Post(":id/expenses")
  @RequirePermission("projects.write")
  async addExpense(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:any):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.projects.addAgencyExpense(this.context(request),id,body)};
  }

  @Get(":id/deliverables")
  @RequirePermission("projects.read")
  async deliverables(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.projects.deliverables(this.context(request),id)
    };
  }

  @Post(":id/deliverables")
  @RequirePermission("projects.write")
  async addDeliverable(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.projects.addDeliverable(this.context(request),id,body)
    };
  }

  @Patch(":id/deliverables/:deliverableId/status")
  @RequirePermission("projects.write")
  async deliverableStatus(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Param("deliverableId") deliverableId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.projects.changeDeliverableStatus(
        this.context(request),id,deliverableId,body
      )
    };
  }

  @Get(":id/approvals")
  @RequirePermission("projects.read")
  async approvals(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.projects.approvals(this.context(request),id)
    };
  }

  @Post(":id/approvals")
  @RequirePermission("projects.write")
  async requestApproval(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.projects.requestApproval(this.context(request),id,body)
    };
  }

  @Get(":id")
  @RequirePermission("projects.read")
  async details(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.projects.details(this.context(request), id)
    };
  }

  @Post()
  @RequirePermission("projects.write")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.projects.create(this.context(request), body)
    };
  }

  @Post("from-deal/:dealId")
  @RequirePermission("projects.write")
  async fromDeal(
    @Req() request: AuthenticatedRequest,
    @Param("dealId") dealId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.projects.createFromDeal(
        this.context(request),
        dealId
      )
    };
  }

  @Patch(":id/status")
  @RequirePermission("projects.write")
  async status(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.projects.changeStatus(
        this.context(request),
        id,
        body
      )
    };
  }

  @Post(":id/milestones")
  @RequirePermission("projects.write")
  async addMilestone(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.projects.addMilestone(
        this.context(request),
        id,
        body
      )
    };
  }

  @Patch(":id/milestones/:milestoneId/status")
  @RequirePermission("projects.write")
  async milestoneStatus(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("milestoneId") milestoneId: string,
    @Body() body: { status: "IN_PROGRESS" | "DONE" | "CANCELLED" }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.projects.changeMilestoneStatus(
        this.context(request),
        id,
        milestoneId,
        body.status
      )
    };
  }

  @Post(":id/time-entries")
  @RequirePermission("projects.write")
  async timeEntry(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.projects.addTimeEntry(
        this.context(request),
        id,
        body
      )
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
