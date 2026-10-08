import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { CatalogService } from "./catalog.service";

@Controller("catalog/products")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermission("catalog.read")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.catalog.list(this.context(request))
    };
  }

  @Post()
  @RequirePermission("catalog.write")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      name: string;
      kind?: "STOCKABLE" | "NON_STOCK";
      sku?: string;
      barcode?: string;
      salePriceMinor?: string;
      costPriceMinor?: string;
      categoryId?: string;
      description?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.catalog.create(this.context(request), body)
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
