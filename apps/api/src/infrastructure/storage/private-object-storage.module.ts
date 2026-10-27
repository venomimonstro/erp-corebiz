import { Module } from "@nestjs/common";
import { PrivateObjectStorageService } from "./private-object-storage.service";

@Module({
  providers: [PrivateObjectStorageService],
  exports: [PrivateObjectStorageService]
})
export class PrivateObjectStorageModule {}
