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
import { BookingService } from "./booking.service";

@Controller("service")
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @Get("catalog")
  @RequirePermission("service.read")
  async services(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.booking.services(this.context(request)) };
  }

  @Post("catalog")
  @RequirePermission("service.write")
  async createService(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.createService(this.context(request), body)
    };
  }

  @Post("catalog/:id/requirements")
  @RequirePermission("service.write")
  async addRequirement(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.booking.addRequirement(this.context(request), id, body);
    return { ok: true, data: { updated: true } };
  }

  @Get("availability")
  @RequirePermission("service.read")
  async availability(
    @Req() request: AuthenticatedRequest,
    @Query("serviceId") serviceId: string,
    @Query("from") from: string,
    @Query("to") to: string,
    @Query("resourceType") resourceType?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.availability(this.context(request), {
        serviceId,
        from,
        to,
        resourceType
      })
    };
  }

  @Get("package-plans")
  @RequirePermission("service.read")
  async packagePlans(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.packagePlans(this.context(request))
    };
  }

  @Post("package-plans")
  @RequirePermission("service.write")
  async createPackagePlan(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.createPackagePlan(this.context(request), body)
    };
  }

  @Get("packages")
  @RequirePermission("service.read")
  async packages(
    @Req() request: AuthenticatedRequest,
    @Query("partyId") partyId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.packages(this.context(request), partyId)
    };
  }

  @Post("packages")
  @RequirePermission("service.write")
  async issuePackage(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.issuePackage(this.context(request), body)
    };
  }

  @Get("assets")
  @RequirePermission("service.read")
  async assets(
    @Req() request: AuthenticatedRequest,
    @Query("partyId") partyId?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.assets(this.context(request), partyId)
    };
  }

  @Post("assets")
  @RequirePermission("service.write")
  async createAsset(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.createAsset(this.context(request), body)
    };
  }

  @Get("assets/:id/history")
  @RequirePermission("service.read")
  async assetHistory(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.assetHistory(this.context(request), id)
    };
  }

  @Patch("assets/:id/usage")
  @RequirePermission("service.write")
  async updateAssetUsage(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.updateAssetUsage(
        this.context(request),
        id,
        body
      )
    };
  }

  @Get("bookings")
  @RequirePermission("service.read")
  async bookings(
    @Req() request: AuthenticatedRequest,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.bookings(this.context(request), from, to)
    };
  }

  @Get("bookings/:id")
  @RequirePermission("service.read")
  async bookingDetails(@Req() request: AuthenticatedRequest, @Param("id") id: string): Promise<ApiSuccess<unknown>> {
    return { ok: true, data: await this.booking.bookingDetails(this.context(request), id) };
  }

  @Post("bookings")
  @RequirePermission("service.write")
  async createBooking(
    @Req() request: AuthenticatedRequest,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.createBooking(this.context(request), body)
    };
  }

  @Patch("bookings/:id/reschedule")
  @RequirePermission("service.write")
  async reschedule(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: any
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.reschedule(this.context(request), id, body)
    };
  }

  @Patch("bookings/:id/status")
  @RequirePermission("service.write")
  async status(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: {
      status: "ARRIVED" | "IN_SERVICE" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
      version: number;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.booking.setStatus(
        this.context(request),
        id,
        body.status,
        body.version
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
