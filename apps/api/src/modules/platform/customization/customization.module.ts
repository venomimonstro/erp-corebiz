import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { CustomizationController } from "./customization.controller";
import { CustomizationService } from "./customization.service";

@Module({
  imports: [AuthorizationModule],
  controllers: [CustomizationController],
  providers: [CustomizationService],
  exports: [CustomizationService]
})
export class CustomizationModule {}
