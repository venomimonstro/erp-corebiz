import { Module } from "@nestjs/common";
import { DomainEventModule } from "../../platform/events/domain-event.module";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";

@Module({
  imports: [DomainEventModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService]
})
export class InventoryModule {}
