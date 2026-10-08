import { Controller, Get } from "@nestjs/common";
import type { ApiSuccess, HealthStatus } from "@corebiz/contracts";
import { Public } from "../auth/public.decorator";

@Controller("health")
export class HealthController {
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
}
