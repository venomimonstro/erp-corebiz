import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { DomainEventModule } from "../../platform/events/domain-event.module";
import { FinanceModule } from "../finance/finance.module";
import { ProcurementController } from "./procurement.controller";
import { ProcurementService } from "./procurement.service";

@Module({
  imports: [DomainEventModule, InventoryModule, FinanceModule],
  controllers: [ProcurementController],
  providers: [ProcurementService],
  exports: [ProcurementService]
})
export class ProcurementModule {}
