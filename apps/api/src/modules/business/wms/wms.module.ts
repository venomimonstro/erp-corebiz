import {Module} from "@nestjs/common";
import {InventoryModule} from "../inventory/inventory.module";
import {WmsController} from "./wms.controller";
import {InventoryModule} from "../inventory/inventory.module";
import {WmsService} from "./wms.service";

@Module({
  imports:[InventoryModule],
  controllers:[WmsController],
  providers:[WmsService],
  exports:[WmsService]
})
export class WmsModule{}
