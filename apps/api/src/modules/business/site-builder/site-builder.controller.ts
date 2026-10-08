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
import { Public } from "../../platform/auth/public.decorator";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { SiteBuilderService } from "./site-builder.service";

@Controller()
export class SiteBuilderController {
  constructor(private readonly sites: SiteBuilderService) {}

  @Get("sites")
  @RequirePermission("sites.read")
  async projects(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.sites.projects(this.context(request)) };
  }

  @Post("sites")
  @RequirePermission("sites.manage")
  async createProject(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string; publicSlug: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sites.createProject(this.context(request), body)
    };
  }

  @Get("sites/:projectId/pages")
  @RequirePermission("sites.read")
  async pages(
    @Req() request: AuthenticatedRequest,
    @Param("projectId") projectId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sites.pages(this.context(request), projectId)
    };
  }

  @Post("sites/:projectId/pages")
  @RequirePermission("sites.manage")
  async createPage(
    @Req() request: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { title: string; slug: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sites.createPage(
        this.context(request),
        projectId,
        body
      )
    };
  }

  @Get("sites/pages/:pageId/editor")
  @RequirePermission("sites.read")
  async editor(
    @Req() request: AuthenticatedRequest,
    @Param("pageId") pageId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sites.editor(this.context(request), pageId)
    };
  }

  @Put("sites/pages/:pageId/draft")
  @RequirePermission("sites.manage")
  async saveDraft(
    @Req() request: AuthenticatedRequest,
    @Param("pageId") pageId: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sites.saveDraft(
        this.context(request),
        pageId,
        body
      )
    };
  }

  @Post("sites/pages/:pageId/publish")
  @RequirePermission("sites.manage")
  async publish(
    @Req() request: AuthenticatedRequest,
    @Param("pageId") pageId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sites.publish(this.context(request), pageId)
    };
  }

  @Public()
  @Get("public/sites/:publicSlug/page")
  async publicPage(
    @Param("publicSlug") publicSlug: string,
    @Query("slug") slug?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.sites.publicPage(publicSlug, slug)
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
