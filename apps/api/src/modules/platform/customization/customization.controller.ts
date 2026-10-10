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
import type { AuthenticatedRequest } from "../auth/auth.types";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { CustomizationService } from "./customization.service";

@Controller("customization")
export class CustomizationController {
  constructor(private readonly customization: CustomizationService) {}

  @Get("fields")
  async fields(
    @Req() request: AuthenticatedRequest,
    @Query("entityType") entityType: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.fields(
        this.context(request),
        entityType
      )
    };
  }

  @Post("fields")
  @RequirePermission("customization.manage")
  async createField(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.createField(
        this.context(request),
        body
      )
    };
  }

  @Get("values/:entityType/:entityId")
  async values(
    @Req() request: AuthenticatedRequest,
    @Param("entityType") entityType: any,
    @Param("entityId") entityId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.values(
        this.context(request),
        entityType,
        entityId
      )
    };
  }

  @Put("values/:entityType/:entityId")
  async setValues(
    @Req() request: AuthenticatedRequest,
    @Param("entityType") entityType: any,
    @Param("entityId") entityId: string,
    @Body() body: { values: Record<string, unknown> }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.customization.setValues(
      this.context(request),
      entityType,
      entityId,
      body.values ?? {}
    );
    return { ok: true, data: { updated: true } };
  }

  @Get("layouts")
  async layouts(
    @Req() request: AuthenticatedRequest,
    @Query("entityType") entityType: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.layouts(
        this.context(request),
        entityType
      )
    };
  }

  @Post("layouts")
  @RequirePermission("customization.manage")
  async createLayout(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      entityType: string;
      layout: Record<string, unknown>;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.createLayoutDraft(
        this.context(request),
        body.entityType,
        body.layout ?? {}
      )
    };
  }

  @Post("layouts/:id/publish")
  @RequirePermission("customization.manage")
  async publishLayout(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ published: true }>> {
    await this.customization.publishLayout(this.context(request), id);
    return { ok: true, data: { published: true } };
  }

  @Get("views")
  async views(
    @Req() request: AuthenticatedRequest,
    @Query("entityType") entityType: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.savedViews(
        this.context(request),
        entityType
      )
    };
  }

  @Post("views")
  async createView(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      entityType: string;
      name: string;
      isShared?: boolean;
      configuration: Record<string, unknown>;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.createSavedView(
        this.context(request),
        body
      )
    };
  }

  @Get("business-profile")
  async businessProfile(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.businessProfile(
        this.context(request)
      )
    };
  }

  @Put("business-profile")
  @RequirePermission("customization.manage")
  async applyBusinessProfile(
    @Req() request: AuthenticatedRequest,
    @Body() body: { profileCode: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.applyBusinessProfile(
        this.context(request),
        body.profileCode
      )
    };
  }

  @Get("capabilities")
  async capabilities(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.capabilities(this.context(request))
    };
  }

  @Put("capabilities/:key")
  @RequirePermission("customization.manage")
  async setCapability(
    @Req() request: AuthenticatedRequest,
    @Param("key") key: string,
    @Body() body: { enabled: boolean }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.customization.setCapability(
      this.context(request),
      key,
      Boolean(body.enabled)
    );
    return { ok: true, data: { updated: true } };
  }

  @Post("roles")
  @RequirePermission("customization.manage")
  async createRole(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.customization.createCustomRole(
        this.context(request),
        body.name
      )
    };
  }

  @Put("roles/:id/permissions")
  @RequirePermission("customization.manage")
  async setRolePermissions(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      permissions: Array<{
        code: string;
        scope: "own" | "team" | "branch" | "all";
      }>;
    }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.customization.setCustomRolePermissions(
      this.context(request),
      id,
      body.permissions ?? []
    );
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
