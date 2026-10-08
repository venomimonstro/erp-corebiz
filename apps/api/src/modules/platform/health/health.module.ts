import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ApiMetricsInterceptor } from "./api-metrics.interceptor";
import { ApiMetricsService } from "./api-metrics.service";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  controllers: [HealthController],
  providers: [
    ApiMetricsService,
    HealthService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ApiMetricsInterceptor
    }
  ]
})
export class HealthModule {}
