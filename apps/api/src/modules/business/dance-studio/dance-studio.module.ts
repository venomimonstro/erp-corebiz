import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../../platform/authorization/authorization.module";
import { InventoryModule } from "../inventory/inventory.module";
import { DanceEconomicsService } from "./dance-economics.service";
import { DanceStudioController } from "./dance-studio.controller";
import { DanceStudioService } from "./dance-studio.service";

@Module({
  imports:[AuthorizationModule,InventoryModule],
  controllers:[DanceStudioController],
  providers:[DanceStudioService,DanceEconomicsService],
  exports:[DanceStudioService,DanceEconomicsService]
})
export class DanceStudioModule {}
