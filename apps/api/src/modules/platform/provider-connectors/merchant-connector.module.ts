import {Module} from "@nestjs/common";
import {AuthorizationModule} from "../authorization/authorization.module";
import {MerchantConnectorController} from "./merchant-connector.controller";
import {MerchantConnectorService} from "./merchant-connector.service";
import {AtolReceiptsService} from "./atol-receipts.service";
@Module({
  imports:[AuthorizationModule],
  controllers:[MerchantConnectorController],
  providers:[MerchantConnectorService,AtolReceiptsService]
})
export class MerchantConnectorModule{}
