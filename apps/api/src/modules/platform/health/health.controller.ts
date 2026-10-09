import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import type { ApiSuccess, HealthStatus } from "@corebiz/contracts";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { ApiMetricsService } from "./api-metrics.service";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly metrics: ApiMetricsService
  ) {}

  @Public()
  @Get()
  getHealth(): ApiSuccess<HealthStatus> {
    return {
      ok: true,
      data: {
        status: "ok",
        service: "api",
        version: process.env.npm_package_version ?? "0.0.1",
        timestamp: new Date().toISOString()
      }
    };
  }

  @Public()
  @Get("ready")
  async ready(): Promise<ApiSuccess<unknown>> {
    const state = await this.health.readiness();
    if (state.status !== "ok") {
      throw new ServiceUnavailableException({
        code: "SERVICE_NOT_READY",
        message: "API dependencies or tenant isolation are not ready",
        readiness: state
      });
    }
    return { ok: true, data: state };
  }

  @Get("diagnostics")
  @RequirePermission("dashboard.owner.read")
  async diagnostics(): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: {
        ...(await this.health.diagnostics()),
        api: this.metrics.snapshot()
      }
    };
  }
}
