import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ResourcesService } from "./resources.service";

@Controller("service/resources")
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  @RequirePermission("service.read")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.resources.list(this.context(request)) };
  }

  @Post()
  @RequirePermission("service.write")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.resources.create(this.context(request), body)
    };
  }

  @Post("skills")
  @RequirePermission("service.write")
  async createSkill(
    @Req() request: AuthenticatedRequest,
    @Body() body: { code: string; name: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.resources.createSkill(this.context(request), body)
    };
  }

  @Put(":id/skills/:skillId")
  @RequirePermission("service.write")
  async assignSkill(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("skillId") skillId: string,
    @Body() body: { level: number }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.resources.assignSkill(
      this.context(request),
      id,
      skillId,
      body.level
    );
    return { ok: true, data: { updated: true } };
  }

  @Get(":id/schedule")
  @RequirePermission("service.read")
  async schedule(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.resources.schedule(this.context(request), id)
    };
  }

  @Put(":id/schedule")
  @RequirePermission("service.write")
  async replaceSchedule(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { windows: any[] }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.resources.replaceSchedule(
      this.context(request),
      id,
      body.windows ?? []
    );
    return { ok: true, data: { updated: true } };
  }

  @Post(":id/blocks")
  @RequirePermission("service.write")
  async addBlock(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.resources.addBlock(this.context(request), id, body)
    };
  }

  @Get(":id/blocks")
  @RequirePermission("service.read")
  async blocks(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.resources.blocks(this.context(request), id, from, to)
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
