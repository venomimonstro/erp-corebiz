import { Module } from "@nestjs/common";
import { SiteBuilderController } from "./site-builder.controller";
import { SiteBuilderService } from "./site-builder.service";

@Module({
  controllers: [SiteBuilderController],
  providers: [SiteBuilderService],
  exports: [SiteBuilderService]
})
export class SiteBuilderModule {}
