import {
  MiddlewareConsumer,
  Module,
  NestModule
} from "@nestjs/common";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { AuthModule } from "./modules/platform/auth/auth.module";
import { SessionContextMiddleware } from "./modules/platform/auth/session-context.middleware";
import { HealthModule } from "./modules/platform/health/health.module";
import { TenantContextModule } from "./modules/platform/tenant-context/tenant-context.module";
import { TenantsModule } from "./modules/platform/tenants/tenants.module";

@Module({
  imports: [
    DatabaseModule,
    TenantContextModule,
    AuthModule,
    TenantsModule,
    HealthModule
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionContextMiddleware).forRoutes("*");
  }
}
