import {
  Controller,
  Get,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { GlobalSearchService } from "./global-search.service";

@Controller("search")
export class GlobalSearchController {
  constructor(private readonly searchService: GlobalSearchService) {}

  @Get()
  async search(
    @Req() request: AuthenticatedRequest,
    @Query("q") query: string
  ): Promise<ApiSuccess<unknown>> {
    const auth = request.auth!;
    const context: TenantContext = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };

    return {
      ok: true,
      data: await this.searchService.search(context, query)
    };
  }
}
