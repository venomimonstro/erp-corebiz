import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../../platform/authorization/authorization.module";
import { CrmController } from "./crm.controller";
import { CrmService } from "./crm.service";

@Module({
  imports: [AuthorizationModule],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService]
})
export class CrmModule {}
