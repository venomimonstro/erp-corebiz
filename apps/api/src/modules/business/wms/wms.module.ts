import {Module} from "@nestjs/common";
import {WmsController} from "./wms.controller";
import {WmsService} from "./wms.service";

@Module({
  controllers:[WmsController],
  providers:[WmsService],
  exports:[WmsService]
})
export class WmsModule{}
