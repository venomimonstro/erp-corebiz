import { Module } from "@nestjs/common";
import { DataManagementController } from "./data-management.controller";
import { DataManagementService } from "./data-management.service";
import { RuntimePressureModule } from "../runtime-pressure/runtime-pressure.module";

@Module({
  imports: [RuntimePressureModule],
  controllers: [DataManagementController],
  providers: [DataManagementService],
  exports: [DataManagementService]
})
export class DataManagementModule {}
