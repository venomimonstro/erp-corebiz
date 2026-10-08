import { Module } from "@nestjs/common";
import { DomainEventModule } from "../../platform/events/domain-event.module";
import { GrowthModule } from "../growth/growth.module";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";

@Module({
  imports: [DomainEventModule, GrowthModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService]
})
export class FinanceModule {}
