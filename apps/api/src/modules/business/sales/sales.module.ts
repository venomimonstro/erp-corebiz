import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../../platform/authorization/authorization.module";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  imports: [AuthorizationModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService]
})
export class SalesModule {}
