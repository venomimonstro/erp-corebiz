import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { OmsController } from "./oms.controller";
import { OmsService } from "./oms.service";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";

@Module({
  imports: [InventoryModule],
  controllers: [OmsController, ReturnsController],
  providers: [OmsService, ReturnsService],
  exports: [OmsService, ReturnsService]
})
export class OmsModule {}
