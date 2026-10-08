import {
  MiddlewareConsumer,
  Module,
  NestModule
} from "@nestjs/common";
import { RedisModule } from "./infrastructure/cache/redis.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { CatalogModule } from "./modules/business/catalog/catalog.module";
import { CrmModule } from "./modules/business/crm/crm.module";
import { FinanceModule } from "./modules/business/finance/finance.module";
import { InventoryModule } from "./modules/business/inventory/inventory.module";
import { OrganizationModule } from "./modules/business/organization/organization.module";
import { PartyModule } from "./modules/business/party/party.module";
import { ProcurementModule } from "./modules/business/procurement/procurement.module";
import { SalesModule } from "./modules/business/sales/sales.module";
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
    RedisModule,
    TenantContextModule,
    AuthModule,
    AuthorizationModule,
    TenantsModule,
    OrganizationModule,
    PartyModule,
    CrmModule,
    TasksModule,
    CatalogModule,
    SalesModule,
    FinanceModule,
    InventoryModule,
    ProcurementModule,
    HealthModule
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionContextMiddleware).forRoutes("*");
  }
}
