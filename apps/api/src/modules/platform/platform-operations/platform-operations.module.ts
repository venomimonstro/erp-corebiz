import { Module } from "@nestjs/common";
import { PlatformOperationsController } from "./platform-operations.controller";
import { PlatformOperationsService } from "./platform-operations.service";
import { PrivateObjectStorageModule } from "../../../infrastructure/storage/private-object-storage.module";

@Module({
  imports: [PrivateObjectStorageModule],
  controllers: [PlatformOperationsController],
  providers: [PlatformOperationsService]
})
export class PlatformOperationsModule {}
