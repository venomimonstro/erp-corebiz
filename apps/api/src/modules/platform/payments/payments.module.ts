import { Module } from "@nestjs/common";
import { FinanceModule } from "../../business/finance/finance.module";
import { PaymentsController } from "./payments.controller";
import { CommercePaymentsService } from "./commerce-payments.service";

@Module({
  imports:[FinanceModule],
  controllers:[PaymentsController],
  providers:[CommercePaymentsService],
  exports:[CommercePaymentsService]
})
export class PaymentsModule {}
