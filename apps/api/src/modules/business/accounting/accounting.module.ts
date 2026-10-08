import { Module } from "@nestjs/common";
import { AccountingController } from "./accounting.controller";
import { AccountingService } from "./accounting.service";
import { VatController } from "./vat.controller";
import { VatService } from "./vat.service";
import { PayrollController } from "./payroll.controller";
import { PayrollService } from "./payroll.service";

@Module({
  controllers:[AccountingController,VatController,PayrollController],
  providers:[AccountingService,VatService,PayrollService]
})
export class AccountingModule {}
