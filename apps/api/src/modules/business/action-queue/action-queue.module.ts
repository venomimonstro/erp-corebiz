import { Module } from "@nestjs/common";
import { GoLiveModule } from "../../platform/go-live/go-live.module";
import { ActionQueueController } from "./action-queue.controller";
import { ActionQueueService } from "./action-queue.service";

@Module({
  imports: [GoLiveModule],
  controllers: [ActionQueueController],
  providers: [ActionQueueService],
  exports: [ActionQueueService]
})
export class ActionQueueModule {}
