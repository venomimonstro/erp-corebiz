import { Module } from "@nestjs/common";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { HealthModule } from "./modules/platform/health/health.module";
import { TenantContextModule } from "./modules/platform/tenant-context/tenant-context.module";

@Module({
  imports: [DatabaseModule, TenantContextModule, HealthModule]
})
export class AppModule {}
