import { Module } from "@nestjs/common";
import { CrmModule } from "../crm/crm.module";
import { PartyModule } from "../party/party.module";
import { SalesModule } from "../sales/sales.module";
import { ServiceOpsModule } from "../service-ops/service-ops.module";
import { SiteFormsController } from "./site-forms.controller";
import { SiteFormsService } from "./site-forms.service";
import { SitesController } from "./sites.controller";
import { SitesService } from "./sites.service";
import { StorefrontController } from "./storefront.controller";
import { StorefrontService } from "./storefront.service";

@Module({
  imports:[CrmModule,PartyModule,SalesModule,ServiceOpsModule],
  controllers:[SitesController,SiteFormsController,StorefrontController],
  providers:[SitesService,SiteFormsService,StorefrontService],
  exports:[SitesService,SiteFormsService,StorefrontService]
})
export class SitesModule{}
