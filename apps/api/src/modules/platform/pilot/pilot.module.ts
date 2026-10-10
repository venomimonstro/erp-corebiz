import { Module } from "@nestjs/common";
import { GoLiveModule } from "../go-live/go-live.module";
import { PilotController } from "./pilot.controller";
import { PilotService } from "./pilot.service";

@Module({
  imports: [GoLiveModule],
  controllers: [PilotController],
  providers: [PilotService],
  exports: [PilotService]
})
export class PilotModule {}
