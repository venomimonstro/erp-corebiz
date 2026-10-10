import { Module } from "@nestjs/common";
import { RuntimePressureController } from "./runtime-pressure.controller";
import { RuntimePressureService } from "./runtime-pressure.service";

@Module({
  controllers: [RuntimePressureController],
  providers: [RuntimePressureService],
  exports: [RuntimePressureService]
})
export class RuntimePressureModule {}
