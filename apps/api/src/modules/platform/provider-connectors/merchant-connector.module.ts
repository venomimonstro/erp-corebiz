import {Module} from "@nestjs/common";
import {MerchantConnectorController} from "./merchant-connector.controller";
import {MerchantConnectorService} from "./merchant-connector.service";
@Module({
  controllers:[MerchantConnectorController],
  providers:[MerchantConnectorService]
})
export class MerchantConnectorModule{}
