import {
  MiddlewareConsumer,
  Module,
  NestModule
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { RedisModule } from "./infrastructure/cache/redis.module";
import { ApiRateLimitGuard } from "./infrastructure/http/api-rate-limit.guard";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { CatalogModule } from "./modules/business/catalog/catalog.module";
import { ChannelsModule } from "./modules/business/channels/channels.module";
import { CrmModule } from "./modules/business/crm/crm.module";
import { DashboardModule } from "./modules/business/dashboard/dashboard.module";
import { FinanceModule } from "./modules/business/finance/finance.module";
import { GrowthModule } from "./modules/business/growth/growth.module";
import { InventoryModule } from "./modules/business/inventory/inventory.module";
import { MigrationModule } from "./modules/business/migration/migration.module";
import { OrganizationModule } from "./modules/business/organization/organization.module";
import { PartyModule } from "./modules/business/party/party.module";
import { ProcurementModule } from "./modules/business/procurement/procurement.module";
import { SalesModule } from "./modules/business/sales/sales.module";
import { ServiceOpsModule } from "./modules/business/service-ops/service-ops.module";
import { SupportModule } from "./modules/business/support/support.module";
import { WorkflowModule } from "./modules/business/workflow/workflow.module";
import { TasksModule } from "./modules/business/tasks/tasks.module";
import { AuthModule } from "./modules/platform/auth/auth.module";
import { BillingModule } from "./modules/platform/billing/billing.module";
import { CustomizationModule } from "./modules/platform/customization/customization.module";
import { SessionContextMiddleware } from "./modules/platform/auth/session-context.middleware";
import { AuthorizationModule } from "./modules/platform/authorization/authorization.module";
import { HealthModule } from "./modules/platform/health/health.module";
import { TenantContextModule } from "./modules/platform/tenant-context/tenant-context.module";
import { TenantsModule } from "./modules/platform/tenants/tenants.module";

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    TenantContextModule,
    AuthModule,
    BillingModule,
    CustomizationModule,
    AuthorizationModule,
    TenantsModule,
    OrganizationModule,
    PartyModule,
    CrmModule,
    DashboardModule,
    TasksModule,
    CatalogModule,
    ChannelsModule,
    SalesModule,
    ServiceOpsModule,
    FinanceModule,
    GrowthModule,
    InventoryModule,
    MigrationModule,
    ProcurementModule,
    SupportModule,
    WorkflowModule,
    HealthModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ApiRateLimitGuard
    }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionContextMiddleware).forRoutes("*");
  }
}
