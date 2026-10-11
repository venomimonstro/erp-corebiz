import { Module } from "@nestjs/common";
import { AutomotiveController } from "./automotive.controller";
import { AutomotiveService } from "./automotive.service";

@Module({
  controllers:[AutomotiveController],
  providers:[AutomotiveService],
  exports:[AutomotiveService]
})
export class AutomotiveModule {}
