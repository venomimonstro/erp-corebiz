import { Module } from "@nestjs/common";
import { PlatformOperationsController } from "./platform-operations.controller";
import { PlatformOperationsService } from "./platform-operations.service";

@Module({
  controllers: [PlatformOperationsController],
  providers: [PlatformOperationsService]
})
export class PlatformOperationsModule {}
