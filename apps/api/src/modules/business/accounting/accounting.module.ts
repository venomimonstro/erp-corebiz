import { Module } from "@nestjs/common";
import { AccountingController } from "./accounting.controller";
import { AccountingService } from "./accounting.service";
import { VatController } from "./vat.controller";
import { VatService } from "./vat.service";

@Module({
  controllers:[AccountingController,VatController],
  providers:[AccountingService,VatService]
})
export class AccountingModule {}
