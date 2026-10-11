import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { ApiCost } from "../../../infrastructure/http/api-cost.decorator";
import { CommercePaymentsService } from "./commerce-payments.service";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments:CommercePaymentsService){}
  private ctx(req:AuthenticatedRequest):TenantContext {
    const a=req.auth!;
    return {tenantId:a.tenantId,userId:a.userId,membershipId:a.membershipId};
  }

  @Get("reconciliation/status")
  @RequirePermission("billing.manage")
  async reconciliationStatus(
    @Req() req:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.reconciliationStatus(this.ctx(req))};
  }

  @Post("saas/start")
  @RequirePermission("billing.manage")
  @ApiCost("EXPENSIVE")
  async startSaas(@Req() req:AuthenticatedRequest,@Body() body:{planCode:string}):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.beginSaas(this.ctx(req),body?.planCode)};
  }

  @Get("saas/:id/status")
  @RequirePermission("billing.manage")
  async saasStatus(@Req() req:AuthenticatedRequest,@Param("id") id:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.saasStatus(this.ctx(req),id)};
  }

  @Post("stores/:siteId/merchant")
  @RequirePermission("sites.manage")
  @ApiCost("EXPENSIVE")
  async configure(
    @Req() req:AuthenticatedRequest,@Param("siteId") siteId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.configureSeller(this.ctx(req),siteId,body)};
  }

  @Get("stores/:siteId/merchant")
  @RequirePermission("sites.read")
  async merchant(@Req() req:AuthenticatedRequest,@Param("siteId") siteId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.sellerStatus(this.ctx(req),siteId)};
  }

  @Post("stores/:siteId/delivery")
  @RequirePermission("sites.manage")
  async saveDelivery(
    @Req() req:AuthenticatedRequest,@Param("siteId") siteId:string,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.saveDelivery(this.ctx(req),siteId,body)};
  }

  @Post("stores/orders/:orderId/full-refund")
  @RequirePermission("finance.write")
  @ApiCost("EXPENSIVE")
  async refund(
    @Req() req:AuthenticatedRequest,@Param("orderId") orderId:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.fullRefund(this.ctx(req),orderId)};
  }

  @Get("refunds/:refundId/status")
  @RequirePermission("finance.read")
  async refundStatus(
    @Req() req:AuthenticatedRequest,@Param("refundId") refundId:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.refundStatus(this.ctx(req),refundId)};
  }

  @Public()
  @Get("storefront/:slug/delivery")
  @ApiCost("SEARCH")
  async deliveries(@Param("slug") slug:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.publicDelivery(slug)};
  }

  @Public()
  @Post("storefront/carts/:cartKey/start")
  @ApiCost("PUBLIC_CHECKOUT")
  async storePayment(@Param("cartKey") key:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.beginStore(key)};
  }

  @Public()
  @Get("storefront/carts/:cartKey/status")
  @ApiCost("PUBLIC_CART")
  async storePaymentStatus(@Param("cartKey") key:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.payments.storeStatus(key)};
  }

  @Public()
  @Post("webhooks/yookassa")
  @ApiCost("WEBHOOK")
  async webhook(@Body() body:unknown):Promise<{accepted:true}>{
    await this.payments.webhook(body);
    return {accepted:true};
  }
}
