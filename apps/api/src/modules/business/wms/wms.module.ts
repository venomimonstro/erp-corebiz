import {Module} from "@nestjs/common";
import {InventoryModule} from "../inventory/inventory.module";
import {Wms3plBillingController} from "./wms-3pl-billing.controller";
import {Wms3plBillingService} from "./wms-3pl-billing.service";
import {Wms3plPortalController} from "./wms-3pl-portal.controller";
import {Wms3plPortalService} from "./wms-3pl-portal.service";
import {Wms3plRequestsController} from "./wms-3pl-requests.controller";
import {Wms3plRequestsService} from "./wms-3pl-requests.service";
import {WmsController} from "./wms.controller";
import {WmsService} from "./wms.service";

@Module({
  imports:[InventoryModule],
  controllers:[
    WmsController,
    Wms3plBillingController,
    Wms3plPortalController,
    Wms3plRequestsController
  ],
  providers:[
    WmsService,
    Wms3plBillingService,
    Wms3plPortalService,
    Wms3plRequestsService
  ],
  exports:[
    WmsService,
    Wms3plBillingService,
    Wms3plPortalService,
    Wms3plRequestsService
  ]
})
export class WmsModule{}
