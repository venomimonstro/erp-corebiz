import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/platform/health/health.module";
import { TenantContextModule } from "./modules/platform/tenant-context/tenant-context.module";

@Module({
  imports: [TenantContextModule, HealthModule]
})
export class AppModule {}
