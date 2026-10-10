import { Module } from "@nestjs/common";
import { SalesModule } from "../sales/sales.module";
import { RuntimePressureModule } from "../../platform/runtime-pressure/runtime-pressure.module";
import { ChannelCryptoService } from "./channel-crypto.service";
import { ChannelsController } from "./channels.controller";
import { ChannelsService } from "./channels.service";

@Module({
  imports: [SalesModule, RuntimePressureModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelCryptoService],
  exports: [ChannelsService]
})
export class ChannelsModule {}
