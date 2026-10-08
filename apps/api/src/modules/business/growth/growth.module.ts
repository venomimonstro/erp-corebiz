import { Module } from "@nestjs/common";
import { AttributionController } from "./attribution.controller";
import { AttributionService } from "./attribution.service";
import { ConversionBridgeController } from "./conversion-bridge.controller";
import { ConversionBridgeService } from "./conversion-bridge.service";
import { IntegrationCryptoService } from "./integration-crypto.service";
import { MarketingController } from "./marketing.controller";
import { MarketingService } from "./marketing.service";
import { ProfitabilityController } from "./profitability.controller";
import { ProfitabilityService } from "./profitability.service";
import { TrackerController } from "./tracker.controller";
import { TrackerService } from "./tracker.service";

@Module({
  controllers: [
    TrackerController,
    MarketingController,
    AttributionController,
    ProfitabilityController,
    ConversionBridgeController
  ],
  providers: [
    TrackerService,
    MarketingService,
    AttributionService,
    ProfitabilityService,
    ConversionBridgeService,
    IntegrationCryptoService
  ],
  exports: [
    TrackerService,
    MarketingService,
    AttributionService,
    ProfitabilityService,
    ConversionBridgeService
  ]
})
export class GrowthModule {}
