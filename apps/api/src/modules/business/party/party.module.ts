import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../../platform/authorization/authorization.module";
import { PartyController } from "./party.controller";
import { PartyService } from "./party.service";

@Module({
  imports: [AuthorizationModule],
  controllers: [PartyController],
  providers: [PartyService],
  exports: [PartyService]
})
export class PartyModule {}
