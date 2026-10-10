import { Module } from "@nestjs/common";
import { DashboardModule } from "../dashboard/dashboard.module";
import { FinanceModule } from "../finance/finance.module";
import { GrowthModule } from "../growth/growth.module";
import { OwnerAssistantController } from "./owner-assistant.controller";
import { OwnerAssistantService } from "./owner-assistant.service";
import { RuntimePressureModule } from "../../platform/runtime-pressure/runtime-pressure.module";

@Module({
  imports: [DashboardModule, FinanceModule, GrowthModule, RuntimePressureModule],
  controllers: [OwnerAssistantController],
  providers: [OwnerAssistantService],
  exports: [OwnerAssistantService]
})
export class OwnerAssistantModule {}
