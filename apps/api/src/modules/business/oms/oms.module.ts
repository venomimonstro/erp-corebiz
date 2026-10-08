import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { OmsController } from "./oms.controller";
import { OmsService } from "./oms.service";

@Module({
  imports: [InventoryModule],
  controllers: [OmsController],
  providers: [OmsService],
  exports: [OmsService]
})
export class OmsModule {}
