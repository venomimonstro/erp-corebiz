import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { CatalogService } from "./catalog.service";

@Controller("catalog/products")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("page")
  @RequirePermission("catalog.read")
  async page(
    @Req() request:AuthenticatedRequest,
    @Query("limit") limit?:string,
    @Query("cursor") cursor?:string,
    @Query("q") query?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.catalog.page(this.context(request),{
      limit:limit===undefined?100:Number(limit),cursor,query
    })};
  }

  @Get()
  @RequirePermission("catalog.read")
  async list(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.catalog.list(this.context(request))
    };
  }

  @Patch(":productId/image")
  @RequirePermission("catalog.write")
  async updateImage(
    @Req() request:AuthenticatedRequest,
    @Param("productId") productId:string,
    @Body() body:{imageUrl?:string|null}
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.catalog.updateImage(this.context(request),productId,body)};
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
      imageUrl?: string;
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
