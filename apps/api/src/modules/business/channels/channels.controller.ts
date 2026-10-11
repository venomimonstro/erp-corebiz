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
import { ApiCost } from "../../../infrastructure/http/api-cost.decorator";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { Public } from "../../platform/auth/public.decorator";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ChannelsService } from "./channels.service";
import { MarketplaceHubService } from "./marketplace-hub.service";

@Controller("channels")
export class ChannelsController {
  constructor(private readonly channels: ChannelsService, private readonly hub:MarketplaceHubService) {}


  @Get("stock-hub")
  @RequirePermission("channels.read")
  async stockHub(@Req() request:AuthenticatedRequest):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.hub.overview(this.context(request))};
  }

  @Post("stock-hub/listings")
  @RequirePermission("channels.manage")
  async stockHubListing(@Req() request:AuthenticatedRequest,@Body() body:any):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.hub.upsertListing(this.context(request),body)};
  }

  @Post("stock-hub/reconcile")
  @RequirePermission("channels.manage")
  async stockHubReconcile(@Req() request:AuthenticatedRequest):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.hub.queueFullReconcile(this.context(request))};
  }

  @Get("connections")
  @RequirePermission("channels.read")
  async connections(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.connections(this.context(request))
    };
  }

  @Post("connections")
  @RequirePermission("channels.manage")
  async createConnection(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.createConnection(
        this.context(request),
        body
      )
    };
  }

  @Post("connections/ozon")
  @RequirePermission("channels.manage")
  async createOzon(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      name: string;
      clientId: string;
      apiKey: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.createMarketplaceConnection(
        this.context(request),
        {
          provider: "OZON",
          name: body.name,
          clientId: body.clientId,
          apiKey: body.apiKey
        }
      )
    };
  }

  @Post("connections/wildberries")
  @RequirePermission("channels.manage")
  async createWildberries(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      name: string;
      apiToken: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.createMarketplaceConnection(
        this.context(request),
        {
          provider: "WILDBERRIES",
          name: body.name,
          apiToken: body.apiToken
        }
      )
    };
  }

  @Post("connections/yandex-market")
  @RequirePermission("channels.manage")
  async createYandexMarket(
    @Req() request:AuthenticatedRequest,
    @Body() body:{name:string;apiKey:string;businessId:string;hasWarehouseGroups?:boolean}
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.channels.createMarketplaceConnection(
      this.context(request),{
        provider:"YANDEX_MARKET",name:body.name,apiKey:body.apiKey,
        businessId:body.businessId,hasWarehouseGroups:body.hasWarehouseGroups
      })};
  }

  @Post("connections/:id/sync")
  @ApiCost("EXPENSIVE")
  @RequirePermission("channels.manage")
  async sync(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { from?: string; to?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.requestSync(
        this.context(request),
        id,
        body
      )
    };
  }

  @Get("sync-jobs")
  @RequirePermission("channels.read")
  async syncJobs(
    @Req() request: AuthenticatedRequest,
    @Query("connectionId") connectionId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.syncJobs(
        this.context(request),
        connectionId
      )
    };
  }

  @Public()
  @Post("webhook/:connectionId/:secret/orders")
  @ApiCost("WEBHOOK")
  async webhookOrder(
    @Param("connectionId") connectionId: string,
    @Param("secret") secret: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.ingestOrder(
        connectionId,
        secret,
        body
      )
    };
  }

  @Get("inbox")
  @RequirePermission("channels.read")
  async inbox(
    @Req() request: AuthenticatedRequest,
    @Query("status") status?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.inbox(
        this.context(request),
        status
      )
    };
  }

  @Get("inbox/:id")
  @RequirePermission("channels.read")
  async inboxOrder(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.inboxOrder(
        this.context(request),
        id
      )
    };
  }

  @Post("connections/:id/mappings")
  @RequirePermission("channels.manage")
  async mapping(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.channels.mapOffer(
      this.context(request),
      id,
      body
    );
    return { ok: true, data: { updated: true } };
  }

  @Post("inbox/:id/import")
  @ApiCost("HEAVY")
  @RequirePermission("channels.manage")
  async importOrder(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.channels.importOrder(
        this.context(request),
        id
      )
    };
  }

  @Patch("inbox/:id/ignore")
  @RequirePermission("channels.manage")
  async ignore(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ ignored: true }>> {
    await this.channels.ignore(this.context(request), id);
    return { ok: true, data: { ignored: true } };
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
