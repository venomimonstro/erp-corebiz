import { Module } from "@nestjs/common";
import { IntegrationCryptoService } from "./integration-crypto.service";
import { MarketingController } from "./marketing.controller";
import { MarketingService } from "./marketing.service";
import { TrackerController } from "./tracker.controller";
import { TrackerService } from "./tracker.service";

@Module({
  controllers: [TrackerController, MarketingController],
  providers: [
    TrackerService,
    IntegrationCryptoService,
    MarketingService
  ],
  exports: [
    TrackerService,
    IntegrationCryptoService,
    MarketingService
  ]
})
export class GrowthModule {}
