import {Module} from "@nestjs/common";
import {AuthorizationModule} from "../../platform/authorization/authorization.module";
import {SalesModule} from "../sales/sales.module";
import {RetailNetworkController} from "./retail-network.controller";
import {RetailNetworkService} from "./retail-network.service";

@Module({
  imports:[AuthorizationModule,SalesModule],
  controllers:[RetailNetworkController],
  providers:[RetailNetworkService]
})
export class RetailNetworkModule{}
