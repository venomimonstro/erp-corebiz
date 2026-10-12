import {
  BadRequestException, ConflictException, Injectable, OnModuleInit,
  OnModuleDestroy, NotFoundException, ServiceUnavailableException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { FinanceService } from "../../business/finance/finance.service";
import {
  YooKassaGateway, type MerchantCredentials, type ProviderPayment,
  minorToMoney, moneyToMinor, openMerchantSecret, sealMerchantSecret,
  providerIdempotencyKey
} from "./yookassa.gateway";

type Purpose = "SAAS"|"STOREFRONT";
type Intent = {
  id:string; tenant_id:string; purpose:Purpose; site_id:string|null;
  sales_order_id:string|null; plan_id:string|null; amount_minor:string;
  status:string; currency:string; provider_payment_id:string|null;
  provider_idempotency_key:string; confirmation_url:string|null;
  customer_email:string;fiscal_provider?:"YOOKASSA"|"ATOL_ONLINE";
};
type SellerConfig = {
  shop_id:string; encrypted_secret:string; vat_code:number;
  tax_system_code:number|null; enabled:boolean; fiscal_enabled:boolean;
  fiscal_provider?:"YOOKASSA"|"ATOL_ONLINE";
};
const SYSTEM_ID="00000000-0000-0000-0000-000000000000";
const isEmail=(value:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length<=320;
const isUuid=(value:unknown):value is string=>
  typeof value==="string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);

@Injectable()
export class CommercePaymentsService implements OnModuleInit, OnModuleDestroy {
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recoveryActive=false;

  onModuleInit():void {
    if(process.env.COREBIZ_PAYMENT_RECONCILE_ENABLED!=="true")return;
    const every=Number(process.env.COREBIZ_PAYMENT_RECONCILE_INTERVAL_MS??"60000");
    if(!Number.isSafeInteger(every)||every<30000||every>300000)
      throw new Error("INVALID_PAYMENT_RECONCILE_INTERVAL");
    this.recoveryTimer=setInterval(()=>{
      void this.reconcileDueBatch().catch(()=>{
        // Do not log provider credentials, response bodies or buyer PII.
        console.error("[commerce-payment-reconcile] batch failed; will retry");
      });
    },every);
    this.recoveryTimer.unref();
    void this.reconcileDueBatch().catch(()=>{
      console.error("[commerce-payment-reconcile] initial batch failed; will retry");
    });
  }
  onModuleDestroy():void {
    if(this.recoveryTimer)clearInterval(this.recoveryTimer);
  }

  async reconciliationStatus(context:TenantContext){
    return this.database.withTenantTransaction(context,async client=>{
      const r=await client.query<{
        state:string;count:string;oldest_due:Date|null
      }>(
        `SELECT state,count(*)::text AS count,min(next_attempt_at) AS oldest_due
         FROM commerce_reconcile_task WHERE tenant_id=$1
         GROUP BY state ORDER BY state`,[context.tenantId]);
      return {
        jobs:r.rows.map(x=>({
          state:x.state,count:Number(x.count),
          oldestDue:x.oldest_due?.toISOString()??null
        })),
        enabled:process.env.COREBIZ_PAYMENT_RECONCILE_ENABLED==="true"
      };
    });
  }

  async reconcileDueBatch():Promise<number>{
    if(this.recoveryActive)return 0;
    this.recoveryActive=true;
    try{
      const jobs=await this.database.query<{
        tenant_id:string;task_id:string;intent_id:string|null;
        refund_id:string|null;lease_id:string
      }>(
        "SELECT * FROM corebiz_claim_commerce_reconciliation($1)",[5]
      );
      for(const job of jobs.rows){
        const context=this.context(job.tenant_id);
        try{
          if(job.intent_id){
            const intent=await this.database.withTenantTransaction(context,
              async client=>{
                const r=await client.query<Intent>(
                  "SELECT * FROM commerce_payment_intent WHERE tenant_id=$1 AND id=$2",
                  [job.tenant_id,job.intent_id]);
                return r.rows[0]??null;
              });
            if(intent?.provider_payment_id)await this.reconcileIntent(intent);
          }else if(job.refund_id){
            const refund=await this.database.withTenantTransaction(context,
              async client=>{
                const r=await client.query<{provider_refund_id:string|null}>(
                  "SELECT provider_refund_id FROM commerce_refund WHERE tenant_id=$1 AND id=$2",
                  [job.tenant_id,job.refund_id]);
                return r.rows[0]??null;
              });
            if(refund?.provider_refund_id)
              await this.reconcileRefund(job.tenant_id,refund.provider_refund_id);
          }
          await this.database.withTenantTransaction(context,async client=>{
            const state=job.intent_id
              ?await client.query<{status:string;fiscal_status:string;fiscal_provider?:string}>(
                "SELECT status,fiscal_status,fiscal_provider FROM commerce_payment_intent WHERE tenant_id=$1 AND id=$2",
                [job.tenant_id,job.intent_id])
              :await client.query<{status:string;fiscal_status:string;fiscal_provider?:string}>(
                "SELECT status,fiscal_status,NULL::text AS fiscal_provider FROM commerce_refund WHERE tenant_id=$1 AND id=$2",
                [job.tenant_id,job.refund_id]);
            const row=state.rows[0];
            const done=!row || ["CANCELED","FAILED"].includes(row.status) ||
              (row.status==="SUCCEEDED" &&
                (row.fiscal_provider==="ATOL_ONLINE"||row.fiscal_status!=="PENDING"));
            await client.query(
              `UPDATE commerce_reconcile_task
               SET state=$4,lease_id=NULL,lease_until=NULL,
                   next_attempt_at=CASE WHEN $4='DONE' THEN now()
                                      ELSE now()+interval '5 minutes' END,
                   last_error_code=NULL,updated_at=now()
               WHERE tenant_id=$1 AND id=$2 AND lease_id=$3`,
              [job.tenant_id,job.task_id,job.lease_id,done?"DONE":"DUE"]);
          });
        }catch{
          // Runtime error is summarized, not interpolated: PSP errors may
          // contain bank IDs, access tokens, emails and phone numbers.
          await this.database.withTenantTransaction(context,async client=>{
            await client.query(
              `UPDATE commerce_reconcile_task
               SET state=CASE WHEN attempts>=60 THEN 'EXHAUSTED' ELSE 'DUE' END,
                 lease_id=NULL,lease_until=NULL,
                 next_attempt_at=now()+(
                   LEAST(21600,30*power(2,LEAST(attempts,10)))::text
                   ||' seconds')::interval,
                 last_error_code='PROVIDER_OR_LEDGER_ERROR',updated_at=now()
               WHERE tenant_id=$1 AND id=$2 AND lease_id=$3`,
              [job.tenant_id,job.task_id,job.lease_id]);
          });
        }
      }
      return jobs.rowCount??jobs.rows.length;
    }finally{this.recoveryActive=false;}
  }

  private readonly gateway=new YooKassaGateway();
  constructor(
    private readonly database:DatabaseService,
    private readonly finance:FinanceService
  ) {}

  private context(tenantId:string):TenantContext {
    return {tenantId,userId:SYSTEM_ID,membershipId:SYSTEM_ID};
  }
  private platform():MerchantCredentials {
    const shopId=process.env.COREBIZ_SAAS_YOOKASSA_SHOP_ID??"";
    const secret=process.env.COREBIZ_SAAS_YOOKASSA_SECRET??"";
    if(!shopId||!secret) throw new ServiceUnavailableException(
      "Оплата CoreBiz не настроена"
    );
    return {shopId,secret};
  }
  private seller(config:SellerConfig,forNewPayment=true):MerchantCredentials {
    if(forNewPayment && (!config.enabled||!config.fiscal_enabled)) throw new ConflictException(
      "Для магазина не включены эквайринг и передача данных для чека"
    );
    return {shopId:config.shop_id,secret:openMerchantSecret(config.encrypted_secret)};
  }
  private returnUrl(path:string):string {
    const base=(process.env.COREBIZ_PAYMENT_RETURN_ORIGIN??"").replace(/\/$/,"");
    let origin:URL;
    try{origin=new URL(base)}catch{
      throw new ServiceUnavailableException("Адрес возврата из оплаты не настроен");
    }
    if((origin.protocol!=="https:" &&
        !(process.env.NODE_ENV!=="production" && origin.hostname==="localhost")) ||
       origin.username || origin.password || origin.pathname!=="/" ||
       origin.search || origin.hash) {
      throw new ServiceUnavailableException("Требуется доверенный HTTPS-адрес возврата");
    }
    return base+path;
  }
  private readonlyUuid(input:unknown):string{
    if(!isUuid(input))throw new BadRequestException("Некорректный идентификатор");
    return input;
  }

  async configureSeller(context:TenantContext,siteId:string,input:{
    shopId:string;secret?:string;vatCode:number;taxSystemCode?:number|null;
    fiscalEnabled:boolean;enabled:boolean;
    fiscalProvider?:"YOOKASSA"|"ATOL_ONLINE";
  }):Promise<{configured:true}> {
    this.readonlyUuid(siteId);
    if(!input || typeof input.shopId!=="string" ||
       !/^\d{3,30}$/.test(input.shopId) ||
       !Number.isInteger(input.vatCode) || input.vatCode<1 || input.vatCode>12 ||
       (input.taxSystemCode!==undefined && input.taxSystemCode!==null &&
         (!Number.isInteger(input.taxSystemCode) ||
           input.taxSystemCode<1 || input.taxSystemCode>6)) ||
       typeof input.fiscalEnabled!=="boolean" ||
       typeof input.enabled!=="boolean" ||
       (input.fiscalProvider!==undefined &&
         !["YOOKASSA","ATOL_ONLINE"].includes(input.fiscalProvider)) ||
       (input.secret!==undefined && (typeof input.secret!=="string" ||
        input.secret.length<8 || input.secret.length>300))) {
      throw new BadRequestException("Некорректные настройки эквайринга");
    }
    await this.database.withTenantTransaction(context,async client=>{
      const site=await client.query(
        "SELECT 1 FROM site WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",
        [siteId,context.tenantId]);
      if(!site.rowCount)throw new NotFoundException("Сайт не найден");
      // Rotating merchant credentials during an in-flight provider payment
      // would make authenticated status verification impossible.
      if(input.secret){
        const active=await client.query(
          `SELECT 1 FROM commerce_payment_intent
           WHERE tenant_id=$1 AND site_id=$2 AND status IN ('NEW','PENDING')
           LIMIT 1`,[context.tenantId,siteId]);
        if(active.rowCount)throw new ConflictException(
          "Дождитесь завершения незакрытых оплат перед сменой секретного ключа"
        );
      }
      const old=await client.query<{encrypted_secret:string;shop_id:string;fiscal_provider:string}>(
        "SELECT encrypted_secret,shop_id,fiscal_provider FROM commerce_merchant_config WHERE tenant_id=$1 AND site_id=$2 FOR UPDATE",
        [context.tenantId,siteId]);
      if(!input.secret && !old.rows[0])throw new BadRequestException("Укажите секретный ключ");
      const selectedProvider=input.fiscalProvider??
        (old.rows[0]?.fiscal_provider??"YOOKASSA");
      if(selectedProvider==="ATOL_ONLINE" && input.enabled){
        if(process.env.COREBIZ_ATOL_RECEIPTS_ENABLED!=="true")
          throw new ConflictException("Сначала включите проверенный контур чеков АТОЛ");
        const verified=await client.query<{environment:string}>(
          `SELECT environment FROM commerce_provider_connection
           WHERE tenant_id=$1 AND site_id=$2 AND provider='ATOL_ONLINE'
             AND enabled AND state='VERIFIED'
             LIMIT 1`,[context.tenantId,siteId]);
        const env=verified.rows[0]?.environment;
        if(!env||
           (process.env.NODE_ENV==="production"&&env!=="PRODUCTION")||
           (env==="PRODUCTION"&&
             process.env.COREBIZ_ATOL_PRODUCTION_RECEIPTS_ENABLED!=="true"))
          throw new ConflictException(
            "Нужна подтверждённая касса АТОЛ: рабочий контур в production, тестовый только на staging"
          );
      }
      if(old.rows[0]&&old.rows[0].fiscal_provider!==selectedProvider){
        const stillActive=await client.query(
          `SELECT 1 FROM commerce_payment_intent i
           WHERE i.tenant_id=$1 AND i.site_id=$2
             AND (i.status IN ('NEW','PENDING')
               OR (i.status='SUCCEEDED' AND
                 (i.fiscal_status<>'SUCCEEDED'
                   OR (i.fiscal_provider='ATOL_ONLINE' AND NOT EXISTS (
                     SELECT 1 FROM commerce_fiscal_document d
                     WHERE d.tenant_id=i.tenant_id
                       AND d.payment_intent_id=i.id
                       AND d.operation IN ('sell_full_payment','sell_refund')
                       AND d.state='DONE'
                   ))))
             )
           LIMIT 1`,[context.tenantId,siteId]);
        if(stillActive.rowCount)throw new ConflictException(
          "Нельзя менять источник чека, пока есть открытые предоплаты, невыданные заказы или возвраты"
        );
      }
      const encrypted=input.secret?sealMerchantSecret(input.secret):old.rows[0]!.encrypted_secret;
      if(!input.secret && old.rows[0]!.shop_id!==input.shopId){
        throw new BadRequestException("При смене магазина укажите новый секретный ключ");
      }
      await client.query(
        `INSERT INTO commerce_merchant_config(
           tenant_id,site_id,shop_id,encrypted_secret,vat_code,tax_system_code,
           fiscal_enabled,enabled,fiscal_provider
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id,site_id) DO UPDATE SET
           shop_id=EXCLUDED.shop_id,encrypted_secret=EXCLUDED.encrypted_secret,
           vat_code=EXCLUDED.vat_code,tax_system_code=EXCLUDED.tax_system_code,
           fiscal_enabled=EXCLUDED.fiscal_enabled,enabled=EXCLUDED.enabled,
           fiscal_provider=EXCLUDED.fiscal_provider,
           updated_at=now()`,
        [context.tenantId,siteId,input.shopId,encrypted,input.vatCode,
          input.taxSystemCode??null,input.fiscalEnabled,input.enabled,selectedProvider]);
    });
    return {configured:true};
  }
  async sellerStatus(context:TenantContext,siteId:string){
    this.readonlyUuid(siteId);
    return this.database.withTenantTransaction(context,async client=>{
      const row=await client.query<{
        shop_id:string;vat_code:number;tax_system_code:number|null;
        fiscal_enabled:boolean;enabled:boolean;
        fiscal_provider:string;
      }>(
        `SELECT shop_id,vat_code,tax_system_code,fiscal_enabled,enabled,fiscal_provider
         FROM commerce_merchant_config WHERE tenant_id=$1 AND site_id=$2`,
        [context.tenantId,siteId]);
      return {configured:!!row.rows[0],...(row.rows[0]??{})};
    });
  }
  async saveDelivery(context:TenantContext,siteId:string,input:{
    code:string;title:string;mode:"PICKUP"|"LOCAL_COURIER";
    feeMinor:string;description?:string;active?:boolean;
  }){
    this.readonlyUuid(siteId);
    if(!input || typeof input.code!=="string" ||
      !/^[A-Z0-9_-]{1,60}$/.test(input.code) ||
      typeof input.title!=="string" || input.title.length<1 ||
      input.title.length>140 || !["PICKUP","LOCAL_COURIER"].includes(input.mode) ||
      typeof input.feeMinor!=="string" ||
      !/^\d{1,10}$/.test(input.feeMinor) ||
      BigInt(input.feeMinor)>100000000n ||
      (input.description!==undefined &&
        (typeof input.description!=="string" || input.description.length>300)) ||
      (input.active!==undefined && typeof input.active!=="boolean") ||
      (input.mode==="PICKUP" && input.feeMinor!=="0")) {
      throw new BadRequestException("Некорректный способ доставки");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const site=await client.query(
        "SELECT 1 FROM site WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,siteId]);
      if(!site.rowCount)throw new NotFoundException("Сайт не найден");
      const r=await client.query<{id:string}>(
        `INSERT INTO commerce_delivery_method(
          tenant_id,site_id,code,title,mode,fee_minor,description,active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(tenant_id,site_id,code) DO UPDATE SET
          title=EXCLUDED.title,mode=EXCLUDED.mode,
          fee_minor=EXCLUDED.fee_minor,description=EXCLUDED.description,
          active=EXCLUDED.active,updated_at=now()
        RETURNING id`,
        [context.tenantId,siteId,input.code,input.title.trim(),input.mode,
          input.feeMinor,input.description??null,input.active??true]);
      return {id:r.rows[0]!.id};
    });
  }
  async publicDelivery(siteCode:string) {
    if(typeof siteCode!=="string" || !/^[a-z0-9-]{1,100}$/.test(siteCode)){
      throw new BadRequestException("Некорректный код магазина");
    }
    const sf=await this.database.query<{site_id:string;tenant_id:string;currency:string}>(
      "SELECT * FROM corebiz_resolve_public_storefront($1)",[siteCode]);
    const row=sf.rows[0];if(!row)throw new NotFoundException("Магазин не найден");
    return this.database.withTenantTransaction(this.context(row.tenant_id),async client=>{
      const methods=await client.query(
        `SELECT id,code,title,mode,fee_minor::text AS fee_minor,description
         FROM commerce_delivery_method
         WHERE tenant_id=$1 AND site_id=$2 AND active
         ORDER BY fee_minor,id LIMIT 25`,[row.tenant_id,row.site_id]);
      return {methods:methods.rows,currency:row.currency};
    });
  }

  private async sellerConfig(tenantId:string,siteId:string):Promise<SellerConfig>{
    const config=await this.database.withTenantTransaction(this.context(tenantId),
      async client=>client.query<SellerConfig>(
        "SELECT shop_id,encrypted_secret,vat_code,tax_system_code,enabled,fiscal_enabled,fiscal_provider FROM commerce_merchant_config WHERE tenant_id=$1 AND site_id=$2",
        [tenantId,siteId]));
    if(!config.rows[0]) throw new ServiceUnavailableException(
      "Продавец не подключил эквайринг"
    );
    return config.rows[0];
  }
  private async snapshotReceipt(
    tenantId:string,orderId:string,vatCode:number,customerEmail:string,
    taxSystemCode:number|null
  ):Promise<Record<string,unknown>>{
    const items=await this.database.withTenantTransaction(this.context(tenantId),
      async client=>client.query<{
        description:string;quantity_milli:string;line_total_minor:string;
      }>(
        `SELECT description,quantity_milli::text,line_total_minor::text
         FROM sales_order_line WHERE tenant_id=$1 AND order_id=$2
         ORDER BY id LIMIT 101`,[tenantId,orderId]));
    if(!items.rows.length || items.rows.length>100) throw new ConflictException(
      "Для чека требуется от 1 до 100 позиций"
    );
    const receiptItems=items.rows.map(row=>{
      const quantity=BigInt(row.quantity_milli);
      const total=BigInt(row.line_total_minor);
      if(quantity<=0n || quantity%1000n!==0n ||
        total%(quantity/1000n)!==0n) throw new ConflictException(
          "Невозможно точно сформировать чек по количеству и цене позиции"
        );
      const unit=total/(quantity/1000n);
      return {
        description:row.description.slice(0,128),
        quantity:Number(quantity/1000n),
        amount:{value:minorToMoney(unit.toString()),currency:"RUB"},
        vat_code:vatCode,payment_mode:"full_prepayment",
        payment_subject:row.description.toLowerCase().startsWith("доставка:")
          ?"service":"commodity"
      };
    });
    return {
      customer:{email:customerEmail},
      items:receiptItems,
      ...(taxSystemCode?{tax_system_code:taxSystemCode}:{})
    };
  }
  private receiptForSaas(email:string,price:string,code:string){
    const vat=Number(process.env.COREBIZ_SAAS_FISCAL_VAT_CODE??"");
    if(!Number.isInteger(vat)||vat<1||vat>12 ||
       process.env.COREBIZ_SAAS_FISCAL_ENABLED!=="true"){
      throw new ServiceUnavailableException("Не настроена фискализация SaaS");
    }
    const tax=Number(process.env.COREBIZ_SAAS_TAX_SYSTEM_CODE??"0");
    if(tax && (!Number.isInteger(tax)||tax<1||tax>6)){
      throw new ServiceUnavailableException("Некорректная система налогообложения SaaS");
    }
    return {customer:{email},items:[{
      description:("Подписка CoreBiz "+code).slice(0,128),
      quantity:1,
      amount:{value:minorToMoney(price),currency:"RUB"},
      vat_code:vat,payment_mode:"full_payment",payment_subject:"service"
    }],...(tax?{tax_system_code:tax}:{})};
  }
  async beginSaas(context:TenantContext,planCode:string){
    if(typeof planCode!=="string" || !/^[A-Z0-9_-]{1,80}$/i.test(planCode)){
      throw new BadRequestException("Некорректный тариф");
    }
    const cred=this.platform();
    const row=await this.database.withTenantTransaction(context,async client=>{
      // Serialize checkout attempts for one tenant before looking for an
      // existing intent. Together with the partial unique index this prevents
      // concurrent unpaid subscription charges.
      await client.query(
        "SELECT tenant_id FROM tenant_subscription WHERE tenant_id=$1 FOR UPDATE",
        [context.tenantId]);
      const plan=await client.query<{id:string;code:string;monthly_price_minor:string}>(
        `SELECT id,code,monthly_price_minor::text FROM billing_plan
         WHERE code=$1 AND status='ACTIVE' AND currency='RUB'`,
        [planCode.toUpperCase()]);
      if(!plan.rows[0]||BigInt(plan.rows[0].monthly_price_minor)<=0n){
        throw new BadRequestException("Платный тариф недоступен");
      }
      const user=await client.query<{email:string}>(
        "SELECT email FROM app_user WHERE id=$1",[context.userId]);
      if(!user.rows[0] || !isEmail(user.rows[0].email)){
        throw new BadRequestException("Для оплаты укажите корректный email");
      }
      const existing=await client.query<Intent>(
        `SELECT * FROM commerce_payment_intent
         WHERE tenant_id=$1 AND purpose='SAAS' AND plan_id=$2
           AND status IN ('NEW','PENDING')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [context.tenantId,plan.rows[0].id]);
      if(existing.rows[0])return {intent:existing.rows[0],code:plan.rows[0].code};
      const id=randomUUID();
      const result=await client.query<Intent>(
        `INSERT INTO commerce_payment_intent(
          id,tenant_id,purpose,plan_id,amount_minor,provider_idempotency_key,
          customer_email
        ) VALUES ($1,$2,'SAAS',$3,$4,$5,$6) RETURNING *`,
        [id,context.tenantId,plan.rows[0].id,plan.rows[0].monthly_price_minor,
          providerIdempotencyKey("corebiz-saas-"+id),user.rows[0].email]);
      return {intent:result.rows[0]!,code:plan.rows[0].code};
    });
    return this.createProviderPayment(row.intent,cred,
      this.receiptForSaas(row.intent.customer_email,row.intent.amount_minor,row.code),
      "CoreBiz "+row.code,this.returnUrl("/app/settings/billing"));
  }
  async beginStore(cartKey:string){
    if(typeof cartKey!=="string" || !/^cart_[A-Za-z0-9_-]{20,100}$/.test(cartKey)){
      throw new BadRequestException("Некорректный ключ корзины");
    }
    const resolved=await this.database.query<{
      cart_id:string;tenant_id:string;site_id:string;
    }>("SELECT * FROM corebiz_resolve_public_cart($1)",[cartKey]);
    const cart=resolved.rows[0];if(!cart)throw new NotFoundException("Корзина не найдена");
    const claim=await this.database.withTenantTransaction(this.context(cart.tenant_id),
      async client=>{
        const order=await client.query<{
          order_id:string;amount_minor:string;payment_status:string;
          email:string|null;site_slug:string;
        }>(
          `SELECT c.sales_order_id AS order_id,o.total_minor::text AS amount_minor,
             o.payment_status,customer.email,s.public_slug AS site_slug
           FROM storefront_cart c
           JOIN sales_order o ON o.tenant_id=c.tenant_id AND o.id=c.sales_order_id
           JOIN site s ON s.tenant_id=c.tenant_id AND s.id=c.site_id
           LEFT JOIN LATERAL (
             SELECT pc.value AS email FROM party_contact pc
             WHERE pc.tenant_id=o.tenant_id AND pc.party_id=o.party_id
               AND pc.type='EMAIL'
             ORDER BY pc.is_primary DESC,pc.created_at DESC LIMIT 1
           ) customer ON true
           JOIN commerce_order_delivery d
             ON d.tenant_id=c.tenant_id AND d.sales_order_id=o.id
           WHERE c.tenant_id=$1 AND c.id=$2 AND c.status='CHECKED_OUT'
             AND o.order_status IN ('CONFIRMED','COMPLETED')
           FOR UPDATE OF c`,
          [cart.tenant_id,cart.cart_id]);
        const o=order.rows[0];
        if(!o)throw new ConflictException(
          "Сначала оформите заказ и выберите способ доставки");
        if(o.payment_status==="PAID")throw new ConflictException("Заказ уже оплачен");
        if(!o.email||!isEmail(o.email)){
          throw new BadRequestException("Для онлайн-оплаты требуется email для чека");
        }
        const existing=await client.query<Intent>(
          `SELECT * FROM commerce_payment_intent
           WHERE tenant_id=$1 AND sales_order_id=$2
             AND status IN ('NEW','PENDING','SUCCEEDED')
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [cart.tenant_id,o.order_id]);
        if(existing.rows[0])return {intent:existing.rows[0],siteSlug:o.site_slug};
        const merchant=await client.query<{
          fiscal_provider:"YOOKASSA"|"ATOL_ONLINE";
        }>(
          `SELECT fiscal_provider FROM commerce_merchant_config
           WHERE tenant_id=$1 AND site_id=$2 AND enabled AND fiscal_enabled
           FOR SHARE`,[cart.tenant_id,cart.site_id]);
        if(!merchant.rows[0])throw new ConflictException(
          "Эквайринг и фискализация магазина не настроены"
        );
        const fiscalProvider=merchant.rows[0].fiscal_provider;
        if(fiscalProvider==="ATOL_ONLINE"){
          if(process.env.COREBIZ_ATOL_RECEIPTS_ENABLED!=="true")
            throw new ConflictException("Кассовый провайдер АТОЛ не готов");
          const readiness=await client.query<{environment:string}>(
            `SELECT environment FROM commerce_provider_connection
             WHERE tenant_id=$1 AND site_id=$2 AND provider='ATOL_ONLINE'
               AND state='VERIFIED' AND enabled LIMIT 1`,
            [cart.tenant_id,cart.site_id]);
          const env=readiness.rows[0]?.environment;
          if(!env||
             (process.env.NODE_ENV==="production"&&env!=="PRODUCTION")||
             (env==="PRODUCTION"&&
               process.env.COREBIZ_ATOL_PRODUCTION_RECEIPTS_ENABLED!=="true"))
            throw new ConflictException(
              "Рабочую оплату нельзя принимать с тестовым или неподтверждённым АТОЛ"
            );
        }
        const id=randomUUID();
        const inserted=await client.query<Intent>(
          `INSERT INTO commerce_payment_intent(
             id,tenant_id,purpose,site_id,sales_order_id,amount_minor,
             provider_idempotency_key,customer_email,fiscal_provider
           ) VALUES ($1,$2,'STOREFRONT',$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id,cart.tenant_id,cart.site_id,o.order_id,o.amount_minor,
            providerIdempotencyKey("corebiz-store-"+id),o.email,fiscalProvider]);
        return {intent:inserted.rows[0]!,siteSlug:o.site_slug};
      });
    const intent=claim.intent;
    if(intent.status==="SUCCEEDED")return {status:"SUCCEEDED",intentId:intent.id};
    const cfg=await this.sellerConfig(cart.tenant_id,cart.site_id);
    const creds=this.seller(cfg);
    const receipt=await this.snapshotReceipt(cart.tenant_id,intent.sales_order_id!,
      cfg.vat_code,intent.customer_email,cfg.tax_system_code);
    return this.createProviderPayment(intent,creds,
      intent.fiscal_provider==="ATOL_ONLINE"?undefined:receipt,
      "Заказ CoreBiz "+intent.sales_order_id,
      this.returnUrl("/s/"+encodeURIComponent(claim.siteSlug)));
  }
  private async createProviderPayment(
    intent:Intent,cred:MerchantCredentials,receipt:Record<string,unknown>|undefined,
    description:string,returnUrl:string
  ){
    if(intent.status==="SUCCEEDED")return {intentId:intent.id,status:"SUCCEEDED"};
    if(intent.provider_payment_id && intent.confirmation_url){
      return {intentId:intent.id,status:intent.status,
        confirmationUrl:intent.confirmation_url};
    }
    const response=await this.gateway.create(cred,intent.provider_idempotency_key,{
      amount:{value:minorToMoney(intent.amount_minor),currency:"RUB"},
      capture:true,
      confirmation:{type:"redirect",return_url:returnUrl},
      description:description.slice(0,128),
      ...(receipt?{receipt}:{}),
      metadata:{corebiz_intent_id:intent.id,corebiz_purpose:intent.purpose}
    });
    this.verifyAmount(intent,response);
    const link=response.confirmation?.confirmation_url;
    let trustedLink=false;
    if(link){
      try{
        const url=new URL(link);
        trustedLink=url.protocol==="https:" && !url.username && !url.password &&
          ["yookassa.ru","yoomoney.ru"].some(host=>
            url.hostname===host||url.hostname.endsWith("."+host));
      }catch{trustedLink=false;}
    }
    // Persist the PSP ID even when its redirect is unavailable. The payment
    // may have been captured and must remain reconcilable after a crash.
    await this.database.withTenantTransaction(this.context(intent.tenant_id),async client=>{
      await client.query(
        `UPDATE commerce_payment_intent
         SET provider_payment_id=$3,confirmation_url=$4,status='PENDING',
           fiscal_status='PENDING',updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status IN ('NEW','PENDING')
           AND (provider_payment_id IS NULL OR provider_payment_id=$3)`,
        [intent.tenant_id,intent.id,response.id,trustedLink?link:null]);
      await client.query(
        `INSERT INTO commerce_reconcile_task(tenant_id,intent_id)
         VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [intent.tenant_id,intent.id]);
    });
    if(response.status==="succeeded" && response.paid===true){
      await this.reconcileIntent({...intent,provider_payment_id:response.id});
      return {intentId:intent.id,status:"SUCCEEDED"};
    }
    if(!trustedLink){
      throw new ServiceUnavailableException(
        "Провайдер создал платёж, но не вернул безопасную ссылку: статус можно сверить позже"
      );
    }
    return {intentId:intent.id,status:"PENDING",confirmationUrl:link};
  }
  private verifyAmount(intent:Intent,response:ProviderPayment){
    if(response.amount.currency!==intent.currency ||
      moneyToMinor(response.amount.value)!==intent.amount_minor ||
      response.metadata?.corebiz_intent_id!==intent.id ||
      response.metadata?.corebiz_purpose!==intent.purpose) {
      throw new ConflictException("Данные оплаты не совпадают с заказом");
    }
  }
  async webhook(body:unknown){
    const data=body as {event?:unknown;object?:{id?:unknown}};
    if(!data || typeof data!=="object" ||
       !["payment.succeeded","payment.canceled","refund.succeeded"].includes(String(data.event)) ||
       !data.object || typeof data.object.id!=="string" ||
       !/^[a-zA-Z0-9_-]{8,100}$/.test(data.object.id)){
      throw new BadRequestException("Неподдерживаемое уведомление");
    }
    const providerId=data.object.id;
    if(data.event==="refund.succeeded"){
      const match=await this.database.query<{tenant_id:string}>(
        "SELECT * FROM corebiz_resolve_refund_tenant($1)",[providerId]);
      if(match.rows[0])await this.reconcileRefund(match.rows[0].tenant_id,providerId);
      return {accepted:true};
    }
    const matches=await this.database.query<{tenant_id:string}>(
      "SELECT * FROM corebiz_resolve_payment_tenant($1)",[providerId]);
    if(!matches.rows[0])return {accepted:true};
    const context=this.context(matches.rows[0].tenant_id);
    const intent=await this.database.withTenantTransaction(context,async client=>{
      const r=await client.query<Intent>(
        "SELECT * FROM commerce_payment_intent WHERE tenant_id=$1 AND provider_payment_id=$2",
        [context.tenantId,providerId]);
      return r.rows[0]??null;
    });
    if(!intent)return {accepted:true};
    await this.reconcileIntent(intent);
    return {accepted:true};
  }
  async storeStatus(cartKey:string){
    if(typeof cartKey!=="string"||!/^cart_[A-Za-z0-9_-]{20,100}$/.test(cartKey)){
      throw new BadRequestException("Неверный ключ корзины");
    }
    const row=await this.database.query<{cart_id:string;tenant_id:string}>(
      "SELECT * FROM corebiz_resolve_public_cart($1)",[cartKey]);
    if(!row.rows[0])throw new NotFoundException("Корзина не найдена");
    const intent=await this.database.withTenantTransaction(this.context(row.rows[0].tenant_id),
      async client=>{
        const r=await client.query<Intent>(
          `SELECT i.* FROM commerce_payment_intent i
           JOIN storefront_cart c
             ON c.tenant_id=i.tenant_id AND c.sales_order_id=i.sales_order_id
           WHERE c.tenant_id=$1 AND c.id=$2 AND i.purpose='STOREFRONT'
           ORDER BY i.created_at DESC LIMIT 1`,
          [row.rows[0].tenant_id,row.rows[0].cart_id]);
        return r.rows[0]??null;
      });
    if(!intent)return {status:"NOT_STARTED"};
    if(intent.status==="PENDING" && intent.provider_payment_id){
      await this.reconcileIntent(intent);
    }
    const state=await this.database.withTenantTransaction(this.context(intent.tenant_id),
      async client=>client.query<{status:string;fiscal_status:string}>(
        "SELECT status,fiscal_status FROM commerce_payment_intent WHERE tenant_id=$1 AND id=$2",
        [intent.tenant_id,intent.id]));
    return {status:state.rows[0]?.status??intent.status,
      fiscalStatus:state.rows[0]?.fiscal_status??"NOT_CONFIRMED"};
  }
  async saasStatus(context:TenantContext,intentId:string){
    this.readonlyUuid(intentId);
    const res=await this.database.withTenantTransaction(context,async client=>
      client.query<Intent>(
        "SELECT * FROM commerce_payment_intent WHERE tenant_id=$1 AND id=$2 AND purpose='SAAS'",
        [context.tenantId,intentId]));
    const intent=res.rows[0];if(!intent)throw new NotFoundException("Платёж не найден");
    if(intent.status==="PENDING" && intent.provider_payment_id)
      await this.reconcileIntent(intent);
    return this.database.withTenantTransaction(context,async client=>{
      const r=await client.query<{status:string;fiscal_status:string}>(
        "SELECT status,fiscal_status FROM commerce_payment_intent WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,intentId]);
      return r.rows[0]??null;
    });
  }
  async fullRefund(context:TenantContext,orderId:string){
    this.readonlyUuid(orderId);
    const claim=await this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{
        intent_id:string;site_id:string;amount_minor:string;
        provider_payment_id:string;status:string;
      }>(
        `SELECT i.id AS intent_id,i.site_id,i.amount_minor::text,
           i.provider_payment_id,i.status
         FROM commerce_payment_intent i
         WHERE i.tenant_id=$1 AND i.sales_order_id=$2
           AND i.purpose='STOREFRONT' AND i.status='SUCCEEDED'
         FOR UPDATE`,
        [context.tenantId,orderId]);
      const intent=result.rows[0];
      if(!intent?.provider_payment_id)throw new ConflictException(
        "Заказ не оплачен подтверждённым онлайн-платежом"
      );
      const existing=await client.query<{
        id:string;provider_refund_id:string|null;status:string;idempotency_key:string;
      }>(
        "SELECT * FROM commerce_refund WHERE tenant_id=$1 AND intent_id=$2 AND status IN ('NEW','PENDING','SUCCEEDED') FOR UPDATE",
        [context.tenantId,intent.intent_id]);
      if(existing.rows[0])return {intent,refund:existing.rows[0]};
      const id=randomUUID();
      const created=await client.query<{
        id:string;provider_refund_id:string|null;status:string;idempotency_key:string;
      }>(
        `INSERT INTO commerce_refund(
          id,tenant_id,intent_id,sales_order_id,amount_minor,idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id,context.tenantId,intent.intent_id,orderId,
          intent.amount_minor,providerIdempotencyKey("corebiz-refund-"+id)]);
      return {intent,refund:created.rows[0]!};
    });
    if(claim.refund.status==="SUCCEEDED")return {
      refundId:claim.refund.id,status:"SUCCEEDED"
    };
    const credentials=this.seller(
      await this.sellerConfig(context.tenantId,claim.intent.site_id),false
    );
    let refundId=claim.refund.provider_refund_id;
    if(!refundId){
      const reply=await this.gateway.createRefund(
        credentials,claim.refund.idempotency_key,
        claim.intent.provider_payment_id,claim.intent.amount_minor
      );
      if(reply.payment_id!==claim.intent.provider_payment_id ||
         reply.amount.currency!=="RUB" ||
         moneyToMinor(reply.amount.value)!==claim.intent.amount_minor){
        throw new ConflictException("Возврат не совпадает с первоначальным платежом");
      }
      refundId=reply.id;
      await this.database.withTenantTransaction(context,async client=>{
        await client.query(
          `UPDATE commerce_refund
           SET provider_refund_id=$3,status='PENDING',updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status IN ('NEW','PENDING')
             AND (provider_refund_id IS NULL OR provider_refund_id=$3)`,
          [context.tenantId,claim.refund.id,refundId]);
        await client.query(
          `INSERT INTO commerce_reconcile_task(tenant_id,refund_id)
           VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [context.tenantId,claim.refund.id]);
      });
    }
    // All ledger mutations happen only after a verified GET from YooKassa.
    await this.reconcileRefund(context.tenantId,refundId);
    const state=await this.database.withTenantTransaction(context,async client=>
      client.query<{status:string;fiscal_status:string}>(
        "SELECT status,fiscal_status FROM commerce_refund WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,claim.refund.id]));
    return {refundId:claim.refund.id,status:state.rows[0]?.status??"PENDING",
      fiscalStatus:state.rows[0]?.fiscal_status??"PENDING"};
  }
  async refundStatus(context:TenantContext,refundId:string){
    this.readonlyUuid(refundId);
    const result=await this.database.withTenantTransaction(context,async client=>
      client.query<{id:string;provider_refund_id:string|null;status:string;fiscal_status:string}>(
        "SELECT id,provider_refund_id,status,fiscal_status FROM commerce_refund WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,refundId]));
    const row=result.rows[0];if(!row)throw new NotFoundException("Возврат не найден");
    if(row.provider_refund_id&&(row.status==="PENDING"||
       (row.status==="SUCCEEDED"&&row.fiscal_status==="PENDING")))
      await this.reconcileRefund(context.tenantId,row.provider_refund_id);
    const fresh=await this.database.withTenantTransaction(context,async client=>
      client.query<{status:string;fiscal_status:string}>(
        "SELECT status,fiscal_status FROM commerce_refund WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,refundId]));
    return fresh.rows[0];
  }
  private async reconcileRefund(tenantId:string,providerRefundId:string){
    const context=this.context(tenantId);
    const result=await this.database.withTenantTransaction(context,async client=>
      client.query<{
        id:string;intent_id:string;status:string;site_id:string;amount_minor:string;
        sales_order_id:string;provider_payment_id:string;
        fiscal_provider:"YOOKASSA"|"ATOL_ONLINE";
      }>(
        `SELECT r.id,r.intent_id,r.status,i.site_id,r.amount_minor::text,
           r.sales_order_id,i.provider_payment_id,i.fiscal_provider
         FROM commerce_refund r
         JOIN commerce_payment_intent i ON i.tenant_id=r.tenant_id AND i.id=r.intent_id
         WHERE r.tenant_id=$1 AND r.provider_refund_id=$2`,
        [tenantId,providerRefundId]));
    const refund=result.rows[0];if(!refund)return;
    const creds=this.seller(await this.sellerConfig(tenantId,refund.site_id),false);
    const verified=await this.gateway.getRefund(creds,providerRefundId);
    if(verified.id!==providerRefundId ||
      verified.payment_id!==refund.provider_payment_id ||
      verified.amount.currency!=="RUB" ||
      moneyToMinor(verified.amount.value)!==refund.amount_minor){
      throw new ConflictException("Данные возврата не соответствуют исходному платежу");
    }
    if(verified.status==="canceled"){
      await this.database.withTenantTransaction(context,async client=>
        client.query(
          `UPDATE commerce_refund SET status='CANCELED',updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status IN ('NEW','PENDING')`,
          [tenantId,refund.id]));
      return;
    }
    if(verified.status!=="succeeded")return;
    if(refund.status==="SUCCEEDED"){
      // A successful bank refund must not produce a second ledger entry
      // when a late fiscal receipt finally becomes available.
      if(refund.fiscal_provider!=="ATOL_ONLINE"){
        await this.database.withTenantTransaction(context,async client=>
          client.query(
            `UPDATE commerce_refund SET
              fiscal_status=CASE
                WHEN $3='succeeded' THEN 'SUCCEEDED'
                WHEN $3='failed' THEN 'FAILED'
                ELSE fiscal_status END,
              updated_at=now()
             WHERE tenant_id=$1 AND id=$2 AND status='SUCCEEDED'`,
            [tenantId,refund.id,verified.receipt_registration??""]));
      }
      return;
    }
    const operator=await this.database.withTenantTransaction(context,async client=>{
      const r=await client.query<{user_id:string;id:string}>(
        `SELECT m.user_id,m.id FROM storefront_config sc
         JOIN tenant_membership m ON m.tenant_id=sc.tenant_id
           AND m.id=sc.responsible_membership_id AND m.status='ACTIVE'
         WHERE sc.tenant_id=$1 AND sc.site_id=$2`,
        [tenantId,refund.site_id]);
      return r.rows[0]??null;
    });
    if(!operator)throw new ConflictException("Не найден сотрудник для проведения возврата");
    const posted=await this.finance.refundSalesPayment(
      {tenantId,userId:operator.user_id,membershipId:operator.id},
      {orderId:refund.sales_order_id,amountMinor:refund.amount_minor,
        idempotencyKey:"yookassa-refund:"+refund.id,
        note:"Проверенный возврат YooKassa "+verified.id}
    );
    await this.database.withTenantTransaction(context,async client=>
      client.query(
        `UPDATE commerce_refund
         SET status='SUCCEEDED',finance_payment_id=$3,fiscal_status=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status IN ('NEW','PENDING','SUCCEEDED')`,
        [tenantId,refund.id,posted.paymentId,
          refund.fiscal_provider==="ATOL_ONLINE"?"PENDING":
          verified.receipt_registration==="succeeded"?"SUCCEEDED":
          verified.receipt_registration==="failed"?"FAILED":"PENDING"]));
  }

  private async reconcileIntent(intent:Intent):Promise<void>{
    if(!intent.provider_payment_id)return;
    const creds=intent.purpose==="SAAS"
      ?this.platform()
      :this.seller(await this.sellerConfig(intent.tenant_id,intent.site_id!),false);
    // Never trust the payload of an unauthenticated callback. The provider API
    // authenticates the lookup and metadata, amount and currency are compared.
    const payment=await this.gateway.get(creds,intent.provider_payment_id);
    if(payment.id!==intent.provider_payment_id)return;
    this.verifyAmount(intent,payment);
    if(intent.status==="SUCCEEDED"){
      if(payment.status==="succeeded"&&payment.paid===true &&
         intent.fiscal_provider!=="ATOL_ONLINE"){
        await this.database.withTenantTransaction(this.context(intent.tenant_id),
          async client=>client.query(
            `UPDATE commerce_payment_intent SET
              fiscal_status=CASE
                WHEN $3='succeeded' THEN 'SUCCEEDED'
                WHEN $3='failed' THEN 'FAILED'
                ELSE fiscal_status END,last_checked_at=now(),updated_at=now()
             WHERE tenant_id=$1 AND id=$2 AND status='SUCCEEDED'`,
            [intent.tenant_id,intent.id,payment.receipt_registration??""]));
      }
      return;
    }
    if(payment.status==="pending"||payment.status==="waiting_for_capture")return;
    const context=this.context(intent.tenant_id);
    if(payment.status==="canceled"){
      await this.database.withTenantTransaction(context,async client=>
        client.query(
          `UPDATE commerce_payment_intent SET status='CANCELED',updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status IN ('NEW','PENDING')`,
          [intent.tenant_id,intent.id]));
      return;
    }
    if(payment.status!=="succeeded"||payment.paid!==true)return;
    if(intent.purpose==="STOREFRONT"){
      // FinanceService provides the existing immutable cash ledger,
      // debt reconciliation, attribution, events and idempotent retries.
      const operator=await this.database.withTenantTransaction(context,async client=>{
        const r=await client.query<{user_id:string;id:string}>(
          `SELECT m.user_id,m.id FROM storefront_config sc
           JOIN tenant_membership m ON m.tenant_id=sc.tenant_id
             AND m.id=sc.responsible_membership_id AND m.status='ACTIVE'
           WHERE sc.tenant_id=$1 AND sc.site_id=$2`,
          [intent.tenant_id,intent.site_id]);
        return r.rows[0]??null;
      });
      if(!operator)throw new ConflictException("Ответственный магазина недоступен");
      const posted=await this.finance.receiveSalesPayment(
        {tenantId:intent.tenant_id,userId:operator.user_id,membershipId:operator.id},
        {orderId:intent.sales_order_id!,amountMinor:intent.amount_minor,
          idempotencyKey:"yookassa:"+intent.id,note:"YooKassa "+payment.id});
      await this.database.withTenantTransaction(context,async client=>{
        await client.query(
          `UPDATE commerce_payment_intent
           SET status='SUCCEEDED',finance_payment_id=$3,
             fiscal_status=$4,last_checked_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status IN ('NEW','PENDING','SUCCEEDED')`,
          [intent.tenant_id,intent.id,posted.paymentId,
            intent.fiscal_provider==="ATOL_ONLINE"?"PENDING":
            payment.receipt_registration==="succeeded"?"SUCCEEDED":
            payment.receipt_registration==="failed"?"FAILED":"PENDING"]);
      });
    }else{
      await this.database.withTenantTransaction(context,async client=>{
        const locked=await client.query<{status:string}>(
          `SELECT status FROM commerce_payment_intent
           WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[intent.tenant_id,intent.id]);
        if(locked.rows[0]?.status==="SUCCEEDED")return;
        if(!["NEW","PENDING"].includes(locked.rows[0]?.status??""))return;
        await client.query(
          `UPDATE tenant_subscription
           SET plan_id=$2,status='ACTIVE',provider='YOOKASSA',
             provider_reference=$3,last_payment_at=now(),last_payment_minor=$4,
             current_period_start=now(),
             current_period_end=GREATEST(current_period_end,now())+interval '1 month',
             grace_until=NULL,cancel_at_period_end=false,updated_at=now()
           WHERE tenant_id=$1`,
          [intent.tenant_id,intent.plan_id,payment.id,intent.amount_minor]);
        await client.query(
          `INSERT INTO billing_event(tenant_id,event_type,subscription_status,
              amount_minor,currency,provider,provider_reference,idempotency_key)
           VALUES($1,'payment_confirmed','ACTIVE',$2,'RUB','YOOKASSA',$3,$4)
           ON CONFLICT DO NOTHING`,
          [intent.tenant_id,intent.amount_minor,payment.id,"yookassa:"+intent.id]);
        await client.query(
          `UPDATE commerce_payment_intent SET status='SUCCEEDED',
            fiscal_status=$3,last_checked_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [intent.tenant_id,intent.id,
            payment.receipt_registration==="succeeded"?"SUCCEEDED":
            payment.receipt_registration==="failed"?"FAILED":"PENDING"]);
      });
    }
  }
}
