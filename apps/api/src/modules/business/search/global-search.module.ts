import { Module } from "@nestjs/common";
import { GlobalSearchController } from "./global-search.controller";
import { GlobalSearchService } from "./global-search.service";
import { RuntimePressureModule } from "../../platform/runtime-pressure/runtime-pressure.module";

@Module({
  imports: [RuntimePressureModule],
  controllers: [GlobalSearchController],
  providers: [GlobalSearchService],
  exports: [GlobalSearchService]
})
export class GlobalSearchModule {}
