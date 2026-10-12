import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import {createHash} from "node:crypto";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../authorization/authorization.service";
import {openMerchantSecret,minorToMoney} from "../payments/yookassa.gateway";
import {AtolOnlineGateway,type AtolCredentials,type ProviderEnvironment} from "./merchant-gateways";

type Company={
  inn:string;email:string;sno:string;paymentAddress:string;vatType:string
};
type Claim={
  documentId:string;state:string;created:boolean;
  encrypted:string;environment:ProviderEnvironment;
  receipt?:Record<string,unknown>;
};
const uuid=(id:unknown):id is string=>
  typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id);

function vatFor(type:string,totalMinor:bigint){
  const percent:Record<string,bigint>={
    none:0n,vat0:0n,vat5:5n,vat7:7n,vat10:10n,vat20:20n,vat22:22n
  };
  if(!(type in percent))throw new BadRequestException("Ставка НДС АТОЛ не поддерживается");
  if(type==="none"||type==="vat0")return {type};
  const n=percent[type]!;
  const cents=(totalMinor*n+(100n+n)/2n)/(100n+n);
  return {type,sum:Number(minorToMoney(cents.toString()))};
}

function buildReceipt(input:{
  id:string;amountMinor:string;email:string;company:Company;
  operation?:"prepayment"|"settlement"|"refund_prepayment"|"refund_settlement";
  refundId?:string;
  lines:Array<{description:string;quantity_milli:string;line_total_minor:string}>;
}):Record<string,unknown>{
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)||
     input.email.length>64)
    throw new ConflictException("Email покупателя не подходит для ФФД 1.2");
  if(input.lines.length===0||input.lines.length>100)
    throw new ConflictException("Количество позиций для АТОЛ вне допустимого диапазона");
  const mode=input.operation??"prepayment";
  let summed=0n;
  const items=input.lines.map(line=>{
    const count=BigInt(line.quantity_milli);
    const cents=BigInt(line.line_total_minor);
    if(count<=0n||count%1000n!==0n||cents<0n||
       count>99999000n||cents%(count/1000n)!==0n)
      throw new ConflictException("Для фискального чека нужны целые единицы товара и точная цена");
    const unit=cents/(count/1000n);
    if(unit>4294967295n||cents>4294967295n)
      throw new ConflictException("Строка превышает максимальную сумму АТОЛ");
    summed+=cents;
    return {
      name:line.description.slice(0,128),
      price:Number(minorToMoney(unit.toString())),
      quantity:Number(count/1000n),
      measure:0,
      sum:Number(minorToMoney(cents.toString())),
      payment_method:mode==="settlement"||mode==="refund_settlement"
        ?"full_payment":"full_prepayment",
      payment_object:mode==="prepayment"||mode==="refund_prepayment"
        ?10:line.description.toLowerCase().startsWith("доставка:")?4:1,
      vat:vatFor(input.company.vatType,cents)
    };
  });
  if(summed!==BigInt(input.amountMinor)||summed<=0n)
    throw new ConflictException("Сумма чека расходится с банковским платежом");
  const timestamp=new Intl.DateTimeFormat("ru-RU",{
    timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"
  }).format(new Date()).replace(", "," ");
  return {
    external_id:mode==="prepayment"?
      "corebiz_"+input.id+"_prepayment":
      mode==="settlement"?"corebiz_"+input.id+"_settlement":
      "corebiz_"+input.id+"_refund_"+input.refundId,
    timestamp,
    receipt:{
      client:{email:input.email},
      company:{
        email:input.company.email,sno:input.company.sno,
        inn:input.company.inn,payment_address:input.company.paymentAddress
      },
      items,
      payments:[{type:mode==="settlement"?2:1,
        sum:Number(minorToMoney(summed.toString()))}],
      total:Number(minorToMoney(summed.toString())),
      internet:true
    }
  };
}

@Injectable()
export class AtolReceiptsService{
  private readonly atol=new AtolOnlineGateway();
  constructor(
    private readonly db:DatabaseService,
    private readonly authorization:AuthorizationService
  ){}
  private async permit(ctx:TenantContext){
    if(await this.authorization.resolveScope(ctx,"sites.manage")!=="all")
      throw new BadRequestException("Проводить фискальные документы может только управляющий компанией");
  }
  private enabled(environment:ProviderEnvironment){
    if(process.env.NODE_ENV==="production"&&environment!=="PRODUCTION")
      throw new ServiceUnavailableException(
        "Боевой платёж нельзя фискализировать тестовой кассой АТОЛ"
      );
    if(process.env.COREBIZ_ATOL_RECEIPTS_ENABLED!=="true")
      throw new ServiceUnavailableException("Отправка фискальных чеков АТОЛ ещё не разрешена");
    if(environment==="PRODUCTION"&&
       process.env.COREBIZ_ATOL_PRODUCTION_RECEIPTS_ENABLED!=="true")
      throw new ServiceUnavailableException(
        "Реальные чеки АТОЛ заблокированы до проверки с фискальным оператором"
      );
  }
  async pending(ctx:TenantContext,siteId:string){
    await this.permit(ctx);
    if(!uuid(siteId))throw new BadRequestException("Неверный сайт");
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        "SELECT i.id AS payment_intent_id,i.sales_order_id,"+
        "o.business_number,i.amount_minor::text AS amount_minor,"+
        "i.fiscal_status,i.updated_at FROM commerce_payment_intent i "+
        "JOIN sales_order o ON o.tenant_id=i.tenant_id AND o.id=i.sales_order_id "+
        "LEFT JOIN commerce_fiscal_document d ON d.tenant_id=i.tenant_id "+
        "AND d.payment_intent_id=i.id AND d.operation='sell' "+
        "WHERE i.tenant_id=$1 AND i.site_id=$2 "+
        "AND i.purpose='STOREFRONT' AND i.fiscal_provider='ATOL_ONLINE' "+
        "AND i.status='SUCCEEDED' AND i.finance_payment_id IS NOT NULL "+
        "AND i.fiscal_status='PENDING' AND d.id IS NULL "+
        "ORDER BY i.updated_at LIMIT 50",
        [ctx.tenantId,siteId]);
      return r.rows;
    });
  }
  async pendingFollowups(ctx:TenantContext,siteId:string){
    await this.permit(ctx);
    if(!uuid(siteId))throw new BadRequestException("Неверный сайт");
    return this.db.withTenantTransaction(ctx,async client=>{
      const rows=await client.query<{
        payment_intent_id:string;business_number:string;
        amount_minor:string;kind:string;delivery_status:string
      }>(
        "SELECT i.id AS payment_intent_id,o.business_number,"+
        "i.amount_minor::text,CASE "+
        " WHEN r.status='SUCCEEDED' AND r.finance_payment_id IS NOT NULL "+
        "AND r.amount_minor=i.amount_minor THEN 'REFUND' "+
        "WHEN d.delivery_status='DELIVERED' THEN 'CLOSING' ELSE 'HANDOVER' END AS kind,"+
        "d.delivery_status "+
        "FROM commerce_payment_intent i "+
        "JOIN sales_order o ON o.tenant_id=i.tenant_id AND o.id=i.sales_order_id "+
        "JOIN commerce_order_delivery d ON d.tenant_id=i.tenant_id "+
        "AND d.sales_order_id=i.sales_order_id "+
        "JOIN commerce_fiscal_document prepayment ON prepayment.tenant_id=i.tenant_id "+
        "AND prepayment.payment_intent_id=i.id AND prepayment.operation='sell' "+
        "AND prepayment.state='DONE' "+
        "LEFT JOIN commerce_refund r ON r.tenant_id=i.tenant_id AND r.intent_id=i.id "+
        "LEFT JOIN commerce_fiscal_document closing ON closing.tenant_id=i.tenant_id "+
        "AND closing.payment_intent_id=i.id AND closing.operation='sell_full_payment' "+
        "LEFT JOIN commerce_shipment ship ON ship.tenant_id=i.tenant_id "+
        "AND ship.sales_order_id=i.sales_order_id "+
        "LEFT JOIN commerce_fiscal_document refunded ON refunded.tenant_id=i.tenant_id "+
        "AND refunded.payment_intent_id=i.id AND refunded.operation='sell_refund' "+
        "WHERE i.tenant_id=$1 AND i.site_id=$2 "+
        "AND i.purpose='STOREFRONT' AND i.status='SUCCEEDED' "+
        "AND i.finance_payment_id IS NOT NULL AND i.fiscal_provider='ATOL_ONLINE' "+
        "AND ( "+
        " (d.delivery_status='DELIVERED' AND closing.id IS NULL "+
        "   AND (r.id IS NULL OR r.status='CANCELED')) "+
        " OR "+
        " (r.status='SUCCEEDED' AND r.finance_payment_id IS NOT NULL "+
        "   AND r.amount_minor=i.amount_minor AND refunded.id IS NULL "+
        "   AND (closing.id IS NULL OR closing.state='DONE') "+
        "   AND (d.delivery_status<>'DELIVERED' OR closing.state='DONE')) "+
        " OR "+
        " (o.fulfillment_status='SHIPPED' "+
        "   AND d.delivery_status IN ('AWAITING_FULFILLMENT','READY','SHIPPED') "+
        "   AND (r.id IS NULL OR r.status='CANCELED') "+
        "   AND closing.id IS NULL "+
        "   AND (ship.id IS NULL OR ship.state='DELIVERED')) "+
        ") ORDER BY i.updated_at LIMIT 100",
        [ctx.tenantId,siteId]
      );
      return rows.rows;
    });
  }

  async list(ctx:TenantContext,siteId:string){
    await this.permit(ctx);
    if(!uuid(siteId))throw new BadRequestException("Неверный сайт");
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        "SELECT id,payment_intent_id,refund_id,operation,state,environment,provider_uuid,fn_number,"+
        "fiscal_document_number,fiscal_document_attribute,receipt_url,last_error_code,"+
        "created_at,verified_at FROM commerce_fiscal_document "+
        "WHERE tenant_id=$1 AND site_id=$2 ORDER BY created_at DESC LIMIT 100",
        [ctx.tenantId,siteId]);
      return r.rows;
    });
  }
  async issue(ctx:TenantContext,siteId:string,paymentId:string,
    nonMarkedConfirmed:boolean){
    await this.permit(ctx);
    if(!uuid(siteId)||!uuid(paymentId))
      throw new BadRequestException("Неверный платёж или сайт");
    if(nonMarkedConfirmed!==true)
      throw new ConflictException(
        "В этой версии АТОЛ разрешены только немаркируемые товары после проверки продавцом"
      );
    const claim:Claim=await this.db.withTenantTransaction(ctx,async client=>{
      const query=await client.query<{
        id:string;amount_minor:string;customer_email:string;
        connection_id:string;encrypted_credentials:string;
        environment:ProviderEnvironment;public_config:Record<string,unknown>
      }>(
        "SELECT i.id,i.amount_minor::text,i.customer_email,"+
        "cp.id AS connection_id,cp.encrypted_credentials,cp.environment,cp.public_config "+
        "FROM commerce_payment_intent i "+
        "JOIN commerce_merchant_config mc ON mc.tenant_id=i.tenant_id AND mc.site_id=i.site_id "+
        "JOIN commerce_provider_connection cp ON cp.tenant_id=i.tenant_id AND cp.site_id=i.site_id "+
        "AND cp.provider='ATOL_ONLINE' AND cp.state='VERIFIED' AND cp.enabled "+
        "WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.id=$3 "+
        "AND i.purpose='STOREFRONT' AND i.status='SUCCEEDED' "+
        "AND i.finance_payment_id IS NOT NULL AND i.fiscal_provider='ATOL_ONLINE' "+
        "AND i.fiscal_status='PENDING' AND mc.fiscal_provider='ATOL_ONLINE' "+
        "AND mc.fiscal_enabled AND mc.enabled "+
        "FOR UPDATE OF i",
        [ctx.tenantId,siteId,paymentId]);
      const paid=query.rows[0];
      if(!paid)throw new ConflictException(
        "Оплата не подтверждена или чек должен выдавать ЮKassa"
      );
      this.enabled(paid.environment);
      const company=(paid.public_config as {fiscalCompany?:Company})?.fiscalCompany;
      if(!company||!/^(\d{10}|\d{12})$/.test(company.inn)||
         !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)||
         !["osn","usn_income","usn_income_outcome","esn","patent"].includes(company.sno)||
         !company.paymentAddress)
        throw new ConflictException("Заполните фискальные реквизиты продавца");
      const old=await client.query<{id:string;state:string}>(
        "SELECT id,state FROM commerce_fiscal_document "+
        "WHERE tenant_id=$1 AND payment_intent_id=$2 AND operation='sell' FOR UPDATE",
        [ctx.tenantId,paymentId]);
      if(old.rows[0]){
        return {
          documentId:old.rows[0].id,state:old.rows[0].state,
          created:false,encrypted:"",environment:paid.environment
        } satisfies Claim;
      }
      const marked=await client.query(
        "SELECT 1 FROM retail_serial_unit u JOIN sales_order_line l "+
        "ON l.tenant_id=u.tenant_id AND l.sku_id=u.sku_id "+
        "JOIN commerce_payment_intent i ON i.tenant_id=l.tenant_id AND i.sales_order_id=l.order_id "+
        "WHERE i.tenant_id=$1 AND i.id=$2 "+
        "AND (u.marking_code_hash IS NOT NULL OR u.marking_product_group IS NOT NULL) LIMIT 1",
        [ctx.tenantId,paymentId]);
      if(marked.rowCount)
        throw new ConflictException("Обнаружен товар с маркировкой: необходим отдельный ФФД/Честный ЗНАК");
      const lines=await client.query<{
        description:string;quantity_milli:string;line_total_minor:string
      }>(
        "SELECT l.description,l.quantity_milli::text,l.line_total_minor::text "+
        "FROM sales_order_line l JOIN commerce_payment_intent i "+
        "ON i.tenant_id=l.tenant_id AND i.sales_order_id=l.order_id "+
        "WHERE i.tenant_id=$1 AND i.id=$2 ORDER BY l.id LIMIT 101",
        [ctx.tenantId,paymentId]);
      const receipt=buildReceipt({
        id:paid.id,amountMinor:paid.amount_minor,email:paid.customer_email,
        company,lines:lines.rows
      });
      const fingerprint=createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
      const inserted=await client.query<{id:string}>(
        "INSERT INTO commerce_fiscal_document("+
        "tenant_id,site_id,payment_intent_id,connector_id,operation,"+
        "environment,external_id,payload_digest,state) "+
        "VALUES($1,$2,$3,$4,'sell',$5,$6,$7,'SENDING') RETURNING id",
        [ctx.tenantId,siteId,paymentId,paid.connection_id,
          paid.environment,"corebiz_"+paid.id+"_prepayment",fingerprint]);
      return {
        documentId:inserted.rows[0]!.id,state:"SENDING",created:true,
        encrypted:paid.encrypted_credentials,environment:paid.environment,receipt
      } satisfies Claim;
    });
    if(!claim.created)return {documentId:claim.documentId,state:claim.state,
      note:"Чек уже зарегистрирован в CoreBiz; повторная отправка запрещена"};
    try{
      const creds=JSON.parse(openMerchantSecret(claim.encrypted)) as AtolCredentials;
      const result=await this.atol.registerSell(creds,claim.environment,claim.receipt!);
      await this.db.withTenantTransaction(ctx,async client=>client.query(
        "UPDATE commerce_fiscal_document SET state='WAIT',provider_uuid=$3,"+
        "submitted_at=now(),updated_at=now(),last_error_code=NULL "+
        "WHERE tenant_id=$1 AND id=$2 AND state='SENDING'",
        [ctx.tenantId,claim.documentId,result.uuid]));
      return {documentId:claim.documentId,state:"WAIT",providerUuid:result.uuid};
    }catch{
      // The POST might have succeeded before the response was lost.
      // Keep the unique claim; NEVER resend it automatically.
      await this.db.withTenantTransaction(ctx,async client=>client.query(
        "UPDATE commerce_fiscal_document SET state='UNKNOWN',"+
        "last_error_code='PROVIDER_RESPONSE_AMBIGUOUS',updated_at=now() "+
        "WHERE tenant_id=$1 AND id=$2 AND state='SENDING'",
        [ctx.tenantId,claim.documentId]));
      return {documentId:claim.documentId,state:"UNKNOWN",
        note:"АТОЛ мог принять чек. Сверьте документ по external_id и UUID у АТОЛ прежде чем действовать"};
    }
  }

  async confirmHandover(ctx:TenantContext,siteId:string,paymentId:string,
    proofReference:string,confirmed:boolean){
    await this.permit(ctx);
    if(await this.authorization.resolveScope(ctx,"sales.write")!=="all")
      throw new BadRequestException("Для подтверждения выдачи нужны права на продажи всей компании");
    if(!uuid(siteId)||!uuid(paymentId)||
       typeof proofReference!=="string" ||
       proofReference.trim().length<8||proofReference.length>128||
       confirmed!==true)
      throw new BadRequestException("Подтвердите фактическую выдачу и укажите ссылку на акт или номер документа");
    const proof=proofReference.trim();
    return this.db.withTenantTransaction(ctx,async client=>{
      const rows=await client.query<{
        sales_order_id:string;fulfillment_status:string;
        delivery_status:string;mode:string
      }>(
        "SELECT i.sales_order_id,o.fulfillment_status,d.delivery_status,d.mode "+
        "FROM commerce_payment_intent i "+
        "JOIN sales_order o ON o.tenant_id=i.tenant_id AND o.id=i.sales_order_id "+
        "JOIN commerce_order_delivery d ON d.tenant_id=i.tenant_id "+
        "AND d.sales_order_id=i.sales_order_id AND d.site_id=i.site_id "+
        "WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.id=$3 "+
        "AND i.purpose='STOREFRONT' AND i.fiscal_provider='ATOL_ONLINE' "+
        "AND i.status='SUCCEEDED' AND i.fiscal_status='SUCCEEDED' "+
        "AND i.finance_payment_id IS NOT NULL AND o.payment_status='PAID' "+
        "FOR UPDATE OF d",
        [ctx.tenantId,siteId,paymentId]);
      const row=rows.rows[0];
      if(!row)throw new ConflictException(
        "Подтверждение выдачи возможно только после оплаты и чека предоплаты"
      );
      if(row.delivery_status==="DELIVERED")
        return {deliveryStatus:"DELIVERED",alreadyConfirmed:true};
      if(row.fulfillment_status!=="SHIPPED")
        throw new ConflictException(
          "Сначала проведите складскую отгрузку; одного резерва недостаточно"
        );
      const initial=await client.query(
        "SELECT 1 FROM commerce_fiscal_document "+
        "WHERE tenant_id=$1 AND payment_intent_id=$2 "+
        "AND operation='sell' AND state='DONE'",
        [ctx.tenantId,paymentId]);
      if(!initial.rowCount)throw new ConflictException(
        "Чек предоплаты АТОЛ не подтверждён"
      );
      const openRefund=await client.query(
        "SELECT 1 FROM commerce_refund WHERE tenant_id=$1 AND intent_id=$2 "+
        "AND status IN ('NEW','PENDING','SUCCEEDED') LIMIT 1",
        [ctx.tenantId,paymentId]);
      if(openRefund.rowCount)throw new ConflictException(
        "При незавершённом или выполненном возврате выдачу подтверждать нельзя"
      );
      const carrier=await client.query<{state:string}>(
        "SELECT state FROM commerce_shipment WHERE tenant_id=$1 "+
        "AND sales_order_id=$2 LIMIT 1",
        [ctx.tenantId,row.sales_order_id]);
      if(carrier.rows[0]&&carrier.rows[0].state!=="DELIVERED")
        throw new ConflictException(
          "Подтвердите вручение в СДЭК и проверьте его внешний статус"
        );
      await client.query(
        "UPDATE commerce_order_delivery SET delivery_status='DELIVERED',"+
        "updated_at=now() WHERE tenant_id=$1 AND sales_order_id=$2 "+
        "AND site_id=$3 AND delivery_status<>'DELIVERED'",
        [ctx.tenantId,row.sales_order_id,siteId]);
      await client.query(
        "INSERT INTO audit_event(tenant_id,actor_user_id,actor_membership_id,"+
        "action,resource_type,resource_id,after_data) "+
        "VALUES($1,$2,$3,'commerce.handover_confirmed',"+
        "'sales_order',$4,$5::jsonb)",
        [ctx.tenantId,ctx.userId,ctx.membershipId,row.sales_order_id,
          JSON.stringify({mode:row.mode,proofReference:proof})]);
      return {deliveryStatus:"DELIVERED",alreadyConfirmed:false};
    });
  }

  async issueClosing(ctx:TenantContext,siteId:string,paymentId:string,
    nonMarkedConfirmed:boolean){
    return this.issueFollowup(ctx,siteId,paymentId,"sell_full_payment",
      nonMarkedConfirmed);
  }

  async issueRefund(ctx:TenantContext,siteId:string,paymentId:string,
    nonMarkedConfirmed:boolean){
    return this.issueFollowup(ctx,siteId,paymentId,"sell_refund",
      nonMarkedConfirmed);
  }

  private async issueFollowup(
    ctx:TenantContext,siteId:string,paymentId:string,
    operation:"sell_full_payment"|"sell_refund",
    nonMarkedConfirmed:boolean
  ){
    await this.permit(ctx);
    if(!uuid(siteId)||!uuid(paymentId))
      throw new BadRequestException("Неверный платёж или сайт");
    if(nonMarkedConfirmed!==true)
      throw new ConflictException(
        "Для чеков в этом контуре нужны подтверждённо немаркируемые, неподакцизные товары"
      );
    const claim:Claim=await this.db.withTenantTransaction(ctx,async client=>{
      const payment=await client.query<{
        id:string;amount_minor:string;customer_email:string;
        connection_id:string;encrypted_credentials:string;
        environment:ProviderEnvironment;public_config:Record<string,unknown>;
        delivery_status:string
      }>(
        "SELECT i.id,i.amount_minor::text,i.customer_email,"+
        "cp.id AS connection_id,cp.encrypted_credentials,cp.environment,"+
        "cp.public_config,d.delivery_status "+
        "FROM commerce_payment_intent i "+
        "JOIN commerce_order_delivery d ON d.tenant_id=i.tenant_id "+
        "AND d.sales_order_id=i.sales_order_id AND d.site_id=i.site_id "+
        "JOIN commerce_merchant_config mc ON mc.tenant_id=i.tenant_id "+
        "AND mc.site_id=i.site_id AND mc.fiscal_provider='ATOL_ONLINE' "+
        "JOIN commerce_provider_connection cp ON cp.tenant_id=i.tenant_id "+
        "AND cp.site_id=i.site_id AND cp.provider='ATOL_ONLINE' "+
        "AND cp.state='VERIFIED' AND cp.enabled "+
        "WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.id=$3 "+
        "AND i.purpose='STOREFRONT' AND i.fiscal_provider='ATOL_ONLINE' "+
        "AND i.status='SUCCEEDED' AND i.finance_payment_id IS NOT NULL "+
        "AND i.fiscal_status='SUCCEEDED' FOR UPDATE OF i",
        [ctx.tenantId,siteId,paymentId]
      );
      const paid=payment.rows[0];
      if(!paid)throw new ConflictException(
        "Сначала дождитесь подтверждённой оплаты и первого чека предоплаты"
      );
      this.enabled(paid.environment);
      const company=(paid.public_config as {fiscalCompany?:Company}).fiscalCompany;
      if(!company||!company.inn||!company.email||!company.paymentAddress)
        throw new ConflictException("Не заполнены фискальные реквизиты продавца");
      const first=await client.query<{state:string;connector_id:string;environment:string}>(
        "SELECT state,connector_id,environment FROM commerce_fiscal_document "+
        "WHERE tenant_id=$1 AND payment_intent_id=$2 AND operation='sell' "+
        "FOR UPDATE",[ctx.tenantId,paymentId]);
      if(first.rows[0]?.state!=="DONE"||
         first.rows[0]?.connector_id!==paid.connection_id||
         first.rows[0]?.environment!==paid.environment)
        throw new ConflictException(
          "Первый чек ещё не подтверждён или касса была заменена"
        );
      const previous=await client.query<{id:string;state:string}>(
        "SELECT id,state FROM commerce_fiscal_document "+
        "WHERE tenant_id=$1 AND payment_intent_id=$2 AND operation=$3 FOR UPDATE",
        [ctx.tenantId,paymentId,operation]);
      if(previous.rows[0])return {
        documentId:previous.rows[0].id,state:previous.rows[0].state,
        created:false,encrypted:"",environment:paid.environment
      } satisfies Claim;
      const closing=await client.query<{id:string;state:string}>(
        "SELECT id,state FROM commerce_fiscal_document "+
        "WHERE tenant_id=$1 AND payment_intent_id=$2 "+
        "AND operation='sell_full_payment' FOR UPDATE",
        [ctx.tenantId,paymentId]);
      const refund=await client.query<{
        id:string;status:string;finance_payment_id:string|null;
        amount_minor:string
      }>(
        "SELECT id,status,finance_payment_id,amount_minor::text "+
        "FROM commerce_refund WHERE tenant_id=$1 AND intent_id=$2 "+
        "FOR UPDATE",[ctx.tenantId,paymentId]);
      const refunded=refund.rows[0];
      if(operation==="sell_full_payment"){
        if(paid.delivery_status!=="DELIVERED")
          throw new ConflictException(
            "Чек полного расчёта возможен только после подтверждённой выдачи товара"
          );
        if(refunded&&["NEW","PENDING","SUCCEEDED"].includes(refunded.status))
          throw new ConflictException("Нельзя закрывать аванс при открытом возврате денег");
      }else{
        if(!refunded||refunded.status!=="SUCCEEDED"||
           !refunded.finance_payment_id||
           refunded.amount_minor!==paid.amount_minor)
          throw new ConflictException(
            "Чек возврата возможен только после полного возврата денег банком и проводки Finance"
          );
        if(closing.rows[0]&&closing.rows[0].state!=="DONE")
          throw new ConflictException(
            "Ожидается результат закрывающего чека: возврат пока невозможен"
          );
        if(paid.delivery_status==="DELIVERED"&&closing.rows[0]?.state!=="DONE")
          throw new ConflictException(
            "После выдачи товара сперва подтвердите чек полного расчёта"
          );
      }
      const marked=await client.query(
        "SELECT 1 FROM retail_serial_unit u JOIN sales_order_line l "+
        "ON l.tenant_id=u.tenant_id AND l.sku_id=u.sku_id "+
        "JOIN commerce_payment_intent i ON i.tenant_id=l.tenant_id "+
        "AND i.sales_order_id=l.order_id "+
        "WHERE i.tenant_id=$1 AND i.id=$2 "+
        "AND (u.marking_code_hash IS NOT NULL OR u.marking_product_group IS NOT NULL) "+
        "LIMIT 1",[ctx.tenantId,paymentId]
      );
      if(marked.rowCount)throw new ConflictException(
        "Для маркированных товаров нужен отдельный ФФД 1.2 с кодами идентификации"
      );
      const lines=await client.query<{
        description:string;quantity_milli:string;line_total_minor:string
      }>(
        "SELECT l.description,l.quantity_milli::text,l.line_total_minor::text "+
        "FROM sales_order_line l JOIN commerce_payment_intent i "+
        "ON i.tenant_id=l.tenant_id AND i.sales_order_id=l.order_id "+
        "WHERE i.tenant_id=$1 AND i.id=$2 ORDER BY l.id LIMIT 101",
        [ctx.tenantId,paymentId]
      );
      const isReturn=operation==="sell_refund";
      const mode=isReturn
        ?(closing.rows[0]?.state==="DONE"?"refund_settlement":"refund_prepayment")
        :"settlement";
      const receipt=buildReceipt({
        id:paid.id,...(refunded?.id?{refundId:refunded.id}:{}),operation:mode,
        amountMinor:paid.amount_minor,email:paid.customer_email,
        company,lines:lines.rows
      });
      const digest=createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
      const external=String(receipt.external_id);
      const stored=await client.query<{id:string}>(
        "INSERT INTO commerce_fiscal_document("+
        "tenant_id,site_id,payment_intent_id,connector_id,operation,"+
        "environment,external_id,payload_digest,state,refund_id) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SENDING',$9) RETURNING id",
        [ctx.tenantId,siteId,paymentId,paid.connection_id,
          operation,paid.environment,external,digest,
          isReturn?refunded?.id:null]
      );
      return {
        documentId:stored.rows[0]!.id,state:"SENDING",created:true,
        encrypted:paid.encrypted_credentials,environment:paid.environment,receipt
      } satisfies Claim;
    });
    if(!claim.created)return {
      documentId:claim.documentId,state:claim.state,
      note:"Операция уже зафиксирована; повторная отправка запрещена"
    };
    try{
      const credentials=JSON.parse(openMerchantSecret(claim.encrypted)) as AtolCredentials;
      const provider=await this.atol.registerSell(
        credentials,claim.environment,claim.receipt!,
        operation==="sell_refund"?"sell_refund":"sell"
      );
      await this.db.withTenantTransaction(ctx,async client=>client.query(
        "UPDATE commerce_fiscal_document SET state='WAIT',provider_uuid=$3,"+
        "submitted_at=now(),updated_at=now(),last_error_code=NULL "+
        "WHERE tenant_id=$1 AND id=$2 AND state='SENDING'",
        [ctx.tenantId,claim.documentId,provider.uuid]
      ));
      return {documentId:claim.documentId,state:"WAIT",providerUuid:provider.uuid};
    }catch{
      await this.db.withTenantTransaction(ctx,async client=>client.query(
        "UPDATE commerce_fiscal_document SET state='UNKNOWN',"+
        "last_error_code='PROVIDER_RESPONSE_AMBIGUOUS',updated_at=now() "+
        "WHERE tenant_id=$1 AND id=$2 AND state='SENDING'",
        [ctx.tenantId,claim.documentId]
      ));
      return {documentId:claim.documentId,state:"UNKNOWN",
        note:"АТОЛ мог принять чек. Повторная отправка запрещена; сверьте его UUID у АТОЛ."};
    }
  }

  async verify(ctx:TenantContext,siteId:string,documentId:string,reportedUuid?:string){
    await this.permit(ctx);
    if(!uuid(siteId)||!uuid(documentId)||
       (reportedUuid!==undefined&&!uuid(reportedUuid)))
      throw new BadRequestException("Некорректный идентификатор чека");
    const result=await this.db.withTenantTransaction(ctx,async client=>
      client.query<{
        id:string;payment_intent_id:string;external_id:string;
        provider_uuid:string|null;state:string;environment:ProviderEnvironment;
        encrypted_credentials:string;amount_minor:string;
        operation:string;refund_id:string|null
      }>(
        "SELECT d.id,d.payment_intent_id,d.external_id,d.provider_uuid,d.state,"+
        "d.environment,d.operation,d.refund_id,c.encrypted_credentials,"+
        "COALESCE(r.amount_minor,i.amount_minor)::text AS amount_minor "+
        "FROM commerce_fiscal_document d "+
        "JOIN commerce_provider_connection c ON c.tenant_id=d.tenant_id AND c.id=d.connector_id "+
        "JOIN commerce_payment_intent i ON i.tenant_id=d.tenant_id AND i.id=d.payment_intent_id "+
        "LEFT JOIN commerce_refund r ON r.tenant_id=d.tenant_id AND r.id=d.refund_id "+
        "WHERE d.tenant_id=$1 AND d.site_id=$2 AND d.id=$3",
        [ctx.tenantId,siteId,documentId]));
    const row=result.rows[0];
    if(!row)throw new NotFoundException("Фискальный документ не найден");
    if(row.state==="DONE")return {documentId,state:"DONE",note:"Чек уже подтверждён"};
    const receiptUuid=row.provider_uuid??reportedUuid;
    if(!receiptUuid)throw new ConflictException(
      "После неопределённого ответа укажите UUID из кабинета АТОЛ"
    );
    if(row.provider_uuid&&row.provider_uuid!==receiptUuid)
      throw new ConflictException("UUID фискального документа неизменяем");
    const creds=JSON.parse(openMerchantSecret(row.encrypted_credentials)) as AtolCredentials;
    const status=await this.atol.report(creds,row.environment,receiptUuid);
    if(status.state==="WAIT"&&!status.externalId)
      return {documentId,state:"WAIT",
        note:"АТОЛ ещё обрабатывает чек. Реквизиты ФН/ФД/ФП не получены"};
    if(status.externalId!==row.external_id)
      throw new ConflictException("Отчёт АТОЛ относится к другому документу");
    if(status.state==="DONE"&&status.amountMinor!==row.amount_minor)
      throw new ConflictException("Сумма фискального документа не совпадает с оплатой");
    await this.db.withTenantTransaction(ctx,async client=>{
      const update=await client.query(
        "UPDATE commerce_fiscal_document SET provider_uuid=$4,state=$5,"+
        "fn_number=$6,fiscal_document_number=$7,fiscal_document_attribute=$8,"+
        "receipt_url=$9,verified_at=CASE WHEN $5='DONE' THEN now() ELSE verified_at END,"+
        "last_error_code=CASE WHEN $5='FAIL' THEN 'PROVIDER_REJECTED' ELSE NULL END,"+
        "updated_at=now() WHERE tenant_id=$1 AND site_id=$2 AND id=$3 "+
        "AND (provider_uuid IS NULL OR provider_uuid=$4) AND state<>'DONE'",
        [ctx.tenantId,siteId,documentId,receiptUuid,status.state,
          status.fnNumber??null,status.documentNumber??null,
          status.fiscalSign??null,status.receiptUrl??null]);
      if(!update.rowCount)throw new ConflictException("Документ изменён, повторите сверку");
      if(status.state==="DONE"){
        if(row.operation==="sell"){
          await client.query(
            "UPDATE commerce_payment_intent SET fiscal_status='SUCCEEDED',updated_at=now() "+
            "WHERE tenant_id=$1 AND id=$2 AND fiscal_provider='ATOL_ONLINE' "+
            "AND status='SUCCEEDED' AND finance_payment_id IS NOT NULL",
            [ctx.tenantId,row.payment_intent_id]);
        }else if(row.operation==="sell_refund"&&row.refund_id){
          await client.query(
            "UPDATE commerce_refund SET fiscal_status='SUCCEEDED',updated_at=now() "+
            "WHERE tenant_id=$1 AND id=$2 AND status='SUCCEEDED' "+
            "AND finance_payment_id IS NOT NULL",
            [ctx.tenantId,row.refund_id]);
        }
      }else if(status.state==="FAIL" &&
         row.operation==="sell_refund"&&row.refund_id){
        await client.query(
          "UPDATE commerce_refund SET fiscal_status='FAILED',updated_at=now() "+
          "WHERE tenant_id=$1 AND id=$2 AND status='SUCCEEDED'",
          [ctx.tenantId,row.refund_id]);
      }
    });
    return {documentId,state:status.state,
      ...(status.state==="DONE"?{
        fnNumber:status.fnNumber,documentNumber:status.documentNumber,
        fiscalSign:status.fiscalSign,receiptUrl:status.receiptUrl
      }:{})};
  }
}
