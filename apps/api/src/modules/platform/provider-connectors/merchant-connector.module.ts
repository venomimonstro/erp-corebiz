import {Module} from "@nestjs/common";
import {AuthorizationModule} from "../authorization/authorization.module";
import {MerchantConnectorController} from "./merchant-connector.controller";
import {MerchantConnectorService} from "./merchant-connector.service";
import {AtolReceiptsService} from "./atol-receipts.service";
import {RussianPostController} from "./russian-post.controller";
import {RussianPostService} from "./russian-post.service";
@Module({
  imports:[AuthorizationModule],
  controllers:[MerchantConnectorController,RussianPostController],
  providers:[MerchantConnectorService,AtolReceiptsService,RussianPostService]
})
export class MerchantConnectorModule{}
