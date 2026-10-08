import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { MigrationService } from "./migration.service";

@Controller("migration")
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  @Post("ingest")
  @RequirePermission("migration.manage")
  async ingest(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      entityType: "PRODUCTS" | "CUSTOMERS";
      filename: string;
      contentBase64: string;
      idempotencyKey: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.migration.ingest(this.context(request), body)
    };
  }

  @Get(":id/preview")
  @RequirePermission("migration.manage")
  async preview(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.migration.preview(this.context(request), id)
    };
  }

  @Post(":id/import")
  @RequirePermission("migration.manage")
  async importBatch(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.migration.importBatch(this.context(request), id)
    };
  }

  @Post("onboarding")
  @RequirePermission("migration.manage")
  async onboarding(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      businessKind?: string;
      companySize?: string;
      salesChannels?: string[];
      capabilities?: string[];
      migrationSource?: string;
      completed?: boolean;
    }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.migration.updateOnboarding(this.context(request), body);
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
