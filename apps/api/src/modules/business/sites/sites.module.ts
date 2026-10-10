import { Module } from "@nestjs/common";
import { CrmModule } from "../crm/crm.module";
import { DanceStudioModule } from "../dance-studio/dance-studio.module";
import { PartyModule } from "../party/party.module";
import { OmsModule } from "../oms/oms.module";
import { SalesModule } from "../sales/sales.module";
import { ServiceOpsModule } from "../service-ops/service-ops.module";
import { SiteDomainsController } from "./site-domains.controller";
import { SiteDomainsService } from "./site-domains.service";
import { SiteFormsController } from "./site-forms.controller";
import { SiteFormsService } from "./site-forms.service";
import { SitesController } from "./sites.controller";
import { SitesService } from "./sites.service";
import { StorefrontController } from "./storefront.controller";
import { StorefrontService } from "./storefront.service";

@Module({
  imports:[CrmModule,DanceStudioModule,PartyModule,SalesModule,ServiceOpsModule,OmsModule],
  controllers:[
    SitesController,
    SiteFormsController,
    StorefrontController,
    SiteDomainsController
  ],
  providers:[
    SitesService,
    SiteFormsService,
    StorefrontService,
    SiteDomainsService
  ],
  exports:[
    SitesService,
    SiteFormsService,
    StorefrontService,
    SiteDomainsService
  ]
})
export class SitesModule{}
