import {
  MiddlewareConsumer,
  Module,
  NestModule
} from "@nestjs/common";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { CrmModule } from "./modules/business/crm/crm.module";
import { PartyModule } from "./modules/business/party/party.module";
import { TasksModule } from "./modules/business/tasks/tasks.module";
import { AuthModule } from "./modules/platform/auth/auth.module";
import { SessionContextMiddleware } from "./modules/platform/auth/session-context.middleware";
import { AuthorizationModule } from "./modules/platform/authorization/authorization.module";
import { HealthModule } from "./modules/platform/health/health.module";
import { TenantContextModule } from "./modules/platform/tenant-context/tenant-context.module";
import { TenantsModule } from "./modules/platform/tenants/tenants.module";

@Module({
  imports: [
    DatabaseModule,
    TenantContextModule,
    AuthModule,
    AuthorizationModule,
    TenantsModule,
    PartyModule,
    CrmModule,
    TasksModule,
    HealthModule
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionContextMiddleware).forRoutes("*");
  }
}
