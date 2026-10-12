import {Body,Controller,Get,Param,Post,Req} from "@nestjs/common";
import type {TenantContext,ApiSuccess} from "@corebiz/contracts";
import type {AuthenticatedRequest} from "../auth/auth.types";
import {RequirePermission} from "../authorization/require-permission.decorator";
import {ApiCost} from "../../../infrastructure/http/api-cost.decorator";
import {MerchantConnectorService} from "./merchant-connector.service";
import {AtolReceiptsService} from "./atol-receipts.service";

@Controller("provider-connectors")
export class MerchantConnectorController{
  constructor(
    private readonly service:MerchantConnectorService,
    private readonly fiscal:AtolReceiptsService
  ){}
  private context(req:AuthenticatedRequest):TenantContext{
    const {tenantId,userId,membershipId}=req.auth!;
    return {tenantId,userId,membershipId};
  }
  @Get("sites/:siteId")
  @RequirePermission("sites.read")
  async list(@Req() req:AuthenticatedRequest,@Param("siteId") id:string)
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.list(this.context(req),id)};
  }
  @Post("sites/:siteId/configure")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async configure(@Req() req:AuthenticatedRequest,@Param("siteId") id:string,
    @Body() body:{
      provider:"CDEK"|"ATOL_ONLINE";
      environment:"SANDBOX"|"PRODUCTION";
      credentials:Record<string,unknown>;fromCityCode?:number;
      fiscalCompany?:{inn:string;email:string;sno:string;paymentAddress:string;vatType:string}
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.configure(this.context(req),id,body)};
  }
  @Post("sites/:siteId/:provider/verify")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async verify(@Req() req:AuthenticatedRequest,
    @Param("siteId") id:string,@Param("provider") provider:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.verify(this.context(req),id,provider)};
  }
  @Get("sites/:siteId/atol/pending-payments")
  @RequirePermission("sites.manage")
  async atolPending(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string)
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.fiscal.pending(this.context(req),siteId)};
  }

  @Get("sites/:siteId/atol/receipts")
  @RequirePermission("sites.manage")
  async atolReceipts(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string)
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.fiscal.list(this.context(req),siteId)};
  }

  @Post("sites/:siteId/atol/payments/:paymentId/receipt")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async issueAtolReceipt(@Req() req:AuthenticatedRequest,
    @Param("siteId") siteId:string,@Param("paymentId") paymentId:string,
    @Body() body:{nonMarkedConfirmed:boolean}):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.fiscal.issue(this.context(req),siteId,
      paymentId,body?.nonMarkedConfirmed)};
  }

  @Post("sites/:siteId/atol/receipts/:documentId/verify")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async verifyAtolReceipt(@Req() req:AuthenticatedRequest,
    @Param("siteId") siteId:string,@Param("documentId") documentId:string,
    @Body() body:{providerUuid?:string}):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.fiscal.verify(this.context(req),
      siteId,documentId,body?.providerUuid)};
  }

  @Get("sites/:siteId/shipments")
  @RequirePermission("sites.read")
  async shipments(@Req() req:AuthenticatedRequest,@Param("siteId") id:string)
  :Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.shipments(this.context(req),id)};
  }

  @Post("sites/:siteId/cdek/shipments")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async bookShipment(@Req() req:AuthenticatedRequest,@Param("siteId") id:string,
    @Body() body:{
      orderId:string;quoteId:string;
      recipientName:string;recipientPhone:string;
      lengthCm:number;widthCm:number;heightCm:number
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.bookShipment(this.context(req),id,body)};
  }

  @Post("sites/:siteId/cdek/shipments/:shipmentId/verify")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async verifyShipment(@Req() req:AuthenticatedRequest,
    @Param("siteId") siteId:string,@Param("shipmentId") shipmentId:string,
    @Body() body:{providerUuid?:string}):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.verifyShipment(
      this.context(req),siteId,shipmentId,body?.providerUuid)};
  }
  
  @Post("sites/:siteId/cdek/quotes")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async quote(@Req() req:AuthenticatedRequest,@Param("siteId") id:string,
    @Body() body:{
      toCityCode:number;weightGrams:number;
      lengthCm:number;widthCm:number;heightCm:number
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.service.quote(this.context(req),id,body)};
  }
}
