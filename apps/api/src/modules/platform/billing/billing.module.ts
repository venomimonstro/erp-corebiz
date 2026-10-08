import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { SubscriptionGuard } from "./subscription.guard";

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard
    }
  ],
  exports: [BillingService]
})
export class BillingModule {}
