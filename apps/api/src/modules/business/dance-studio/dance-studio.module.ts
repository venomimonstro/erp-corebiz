import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../../platform/authorization/authorization.module";
import { InventoryModule } from "../inventory/inventory.module";
import { DanceEconomicsService } from "./dance-economics.service";
import { DanceStudioController } from "./dance-studio.controller";
import {DanceOperationsService} from "./dance-operations.service";
import {DanceCustomerPortalService} from "./dance-customer-portal.service";
import {DanceTrainerPortalService} from "./dance-trainer-portal.service";
import {DanceBudgetService} from "./dance-budget.service";
import { DanceStudioService } from "./dance-studio.service";

@Module({
  imports:[AuthorizationModule,InventoryModule],
  controllers:[DanceStudioController],
  providers:[DanceStudioService,DanceEconomicsService,DanceOperationsService,DanceCustomerPortalService,DanceTrainerPortalService,DanceBudgetService],
  exports:[DanceStudioService,DanceEconomicsService]
})
export class DanceStudioModule {}
