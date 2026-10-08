import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../../platform/authorization/authorization.module";
import { InventoryModule } from "../inventory/inventory.module";
import { FinanceModule } from "../finance/finance.module";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  imports: [AuthorizationModule, InventoryModule, FinanceModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService]
})
export class SalesModule {}
