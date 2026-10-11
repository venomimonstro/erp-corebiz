import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { AutomotiveController } from "./automotive.controller";
import { AutomotiveService } from "./automotive.service";

@Module({
  imports:[InventoryModule],
  controllers:[AutomotiveController],
  providers:[AutomotiveService],
  exports:[AutomotiveService]
})
export class AutomotiveModule {}
