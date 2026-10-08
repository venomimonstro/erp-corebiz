import { Module } from "@nestjs/common";
import { SalesModule } from "../sales/sales.module";
import { ChannelCryptoService } from "./channel-crypto.service";
import { ChannelsController } from "./channels.controller";
import { ChannelsService } from "./channels.service";

@Module({
  imports: [SalesModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelCryptoService],
  exports: [ChannelsService]
})
export class ChannelsModule {}
