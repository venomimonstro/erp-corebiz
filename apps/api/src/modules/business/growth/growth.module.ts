import { Module } from "@nestjs/common";
import { AttributionController } from "./attribution.controller";
import { AttributionService } from "./attribution.service";
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
    ProfitabilityController
  ],
  providers: [
    TrackerService,
    MarketingService,
    AttributionService,
    ProfitabilityService,
    IntegrationCryptoService
  ],
  exports: [
    TrackerService,
    MarketingService,
    AttributionService,
    ProfitabilityService
  ]
})
export class GrowthModule {}
