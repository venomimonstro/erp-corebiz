import { Module } from "@nestjs/common";
import { GoLiveController } from "./go-live.controller";
import { GoLiveService } from "./go-live.service";

@Module({
  controllers: [GoLiveController],
  providers: [GoLiveService],
  exports: [GoLiveService]
})
export class GoLiveModule {}
