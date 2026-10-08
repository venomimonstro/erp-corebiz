import {Module} from "@nestjs/common";
import {InventoryModule} from "../inventory/inventory.module";
import {Wms3plBillingController} from "./wms-3pl-billing.controller";
import {Wms3plBillingService} from "./wms-3pl-billing.service";
import {WmsController} from "./wms.controller";
import {WmsService} from "./wms.service";

@Module({
  imports:[InventoryModule],
  controllers:[WmsController,Wms3plBillingController],
  providers:[WmsService,Wms3plBillingService],
  exports:[WmsService,Wms3plBillingService]
})
export class WmsModule{}
