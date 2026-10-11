import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { CommerceDecisionsController } from "./commerce-decisions.controller";
import { CommerceDecisionsService } from "./commerce-decisions.service";
import { DashboardService } from "./dashboard.service";

@Module({
  controllers: [DashboardController, CommerceDecisionsController],
  providers: [DashboardService, CommerceDecisionsService],
  exports: [DashboardService]
})
export class DashboardModule {}
