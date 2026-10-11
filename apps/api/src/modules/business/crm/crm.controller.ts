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

  @Get("pipelines")
  @RequirePermission("crm.read")
  async pipelines(
    @Req() request:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.crm.pipelines(this.context(request))};
  }

  @Post("pipelines")
  @RequirePermission("crm.write")
  async createPipeline(
    @Req() request:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.crm.createPipeline(this.context(request),body)
    };
  }

  @Get("deals/:id")
  @RequirePermission("crm.read")
  async dealDetails(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.crm.dealDetails(this.context(request),id)
    };
  }

  @Patch("deals/:id")
  @RequirePermission("crm.write")
  async updateDeal(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.crm.updateDeal(this.context(request),id,body)
    };
  }

  @Post("deals/:id/notes")
  @RequirePermission("crm.write")
  async addNote(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.crm.addNote(this.context(request),id,body)
    };
  }

  @Post("deals/:id/activities")
  @RequirePermission("crm.write")
  async addActivity(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.crm.addActivity(this.context(request),id,body)
    };
  }

  @Get("tags")
  @RequirePermission("crm.read")
  async tags(
    @Req() request:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.crm.tags(this.context(request))};
  }

  @Post("tags")
  @RequirePermission("crm.write")
  async createTag(
    @Req() request:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.crm.createTag(this.context(request),body)};
  }

  @Patch("deals/:id/tags")
  @RequirePermission("crm.write")
  async setDealTags(
    @Req() request:AuthenticatedRequest,
    @Param("id") id:string,
    @Body() body:{tagIds:string[]}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.crm.setDealTags(
        this.context(request),id,body.tagIds??[]
      )
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
