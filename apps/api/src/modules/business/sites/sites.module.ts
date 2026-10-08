import { Module } from "@nestjs/common";
import { CrmModule } from "../crm/crm.module";
import { PartyModule } from "../party/party.module";
import { ServiceOpsModule } from "../service-ops/service-ops.module";
import { SiteFormsController } from "./site-forms.controller";
import { SiteFormsService } from "./site-forms.service";
import { SitesController } from "./sites.controller";
import { SitesService } from "./sites.service";

@Module({
  imports:[CrmModule,PartyModule,ServiceOpsModule],
  controllers:[SitesController,SiteFormsController],
  providers:[SitesService,SiteFormsService],
  exports:[SitesService,SiteFormsService]
})
export class SitesModule{}
