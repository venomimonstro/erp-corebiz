import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { ServiceWorkspaceService } from "./service-workspace.service";

@Controller("service/workspace")
export class ServiceWorkspaceController {
  constructor(private readonly workspace: ServiceWorkspaceService) {}

  @Get("today")
  @RequirePermission("service.read")
  async today(
    @Req() request: AuthenticatedRequest,
    @Query("date") date?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workspace.today(this.context(request), date)
    };
  }

  @Post("bookings/:bookingId/materials")
  @RequirePermission("service.write")
  async addMaterial(
    @Req() request: AuthenticatedRequest,
    @Param("bookingId") bookingId: string,
    @Body() body: {
      warehouseId: string;
      skuId: string;
      quantityMilli: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workspace.addMaterial(
        this.context(request),
        bookingId,
        body
      )
    };
  }

  @Get("bookings/:bookingId/materials")
  @RequirePermission("service.read")
  async materials(
    @Req() request: AuthenticatedRequest,
    @Param("bookingId") bookingId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workspace.materials(
        this.context(request),
        bookingId
      )
    };
  }

  @Post("materials/:lineId/consume")
  @RequirePermission("service.write")
  async consume(
    @Req() request: AuthenticatedRequest,
    @Param("lineId") lineId: string,
    @Body() body: {
      quantityMilli: string;
      idempotencyKey: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workspace.consumeMaterial(
        this.context(request),
        lineId,
        body
      )
    };
  }

  @Get("customers/:partyId/history")
  @RequirePermission("service.read")
  async customerHistory(
    @Req() request: AuthenticatedRequest,
    @Param("partyId") partyId: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workspace.customerHistory(
        this.context(request),
        partyId
      )
    };
  }

  @Get("analytics")
  @RequirePermission("service.read")
  async analytics(
    @Req() request: AuthenticatedRequest,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.workspace.analytics(
        this.context(request),
        from,
        to
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
