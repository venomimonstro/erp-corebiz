import { Module } from "@nestjs/common";
import { SupportController } from "./support.controller";
import { SupportService } from "./support.service";
import { PrivateObjectStorageModule } from "../../../infrastructure/storage/private-object-storage.module";

@Module({
  imports: [PrivateObjectStorageModule],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService]
})
export class SupportModule {}
