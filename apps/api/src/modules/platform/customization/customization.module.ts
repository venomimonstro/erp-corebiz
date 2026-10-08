import { Module } from "@nestjs/common";
import { CustomizationController } from "./customization.controller";
import { CustomizationService } from "./customization.service";

@Module({
  controllers: [CustomizationController],
  providers: [CustomizationService],
  exports: [CustomizationService]
})
export class CustomizationModule {}
