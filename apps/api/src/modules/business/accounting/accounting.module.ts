import { Module } from "@nestjs/common";
import { AccountingController } from "./accounting.controller";
import { AccountingService } from "./accounting.service";
import { VatController } from "./vat.controller";
import { VatService } from "./vat.service";
import { PayrollController } from "./payroll.controller";
import { PayrollService } from "./payroll.service";
import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";
import { TaxComplianceController } from "./tax-compliance.controller";
import { TaxComplianceService } from "./tax-compliance.service";

@Module({
  controllers:[
    AccountingController,
    VatController,
    PayrollController,
    TaxComplianceController,
    ComplianceController
  ],
  providers:[
    AccountingService,
    VatService,
    PayrollService,
    TaxComplianceService,
    ComplianceService
  ]
})
export class AccountingModule {}
