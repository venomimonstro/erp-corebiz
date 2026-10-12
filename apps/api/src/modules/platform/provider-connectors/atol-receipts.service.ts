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
  lines:Array<{description:string;quantity_milli:string;line_total_minor:string}>;
}):Record<string,unknown>{
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)||
     input.email.length>64)
    throw new ConflictException("Email покупателя не подходит для ФФД 1.2");
  if(input.lines.length===0||input.lines.length>100)
    throw new ConflictException("Количество позиций для АТОЛ вне допустимого диапазона");
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
      payment_method:"full_prepayment",
      payment_object:line.description.toLowerCase().startsWith("доставка:")?4:1,
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
    external_id:"corebiz_"+input.id+"_prepayment",
    timestamp,
    receipt:{
      client:{email:input.email},
      company:{
        email:input.company.email,sno:input.company.sno,
        inn:input.company.inn,payment_address:input.company.paymentAddress
      },
      items,
      payments:[{type:1,sum:Number(minorToMoney(summed.toString()))}],
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
  async list(ctx:TenantContext,siteId:string){
    await this.permit(ctx);
    if(!uuid(siteId))throw new BadRequestException("Неверный сайт");
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        "SELECT id,payment_intent_id,operation,state,environment,provider_uuid,fn_number,"+
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
  async verify(ctx:TenantContext,siteId:string,documentId:string,reportedUuid?:string){
    await this.permit(ctx);
    if(!uuid(siteId)||!uuid(documentId)||
       (reportedUuid!==undefined&&!uuid(reportedUuid)))
      throw new BadRequestException("Некорректный идентификатор чека");
    const result=await this.db.withTenantTransaction(ctx,async client=>
      client.query<{
        id:string;payment_intent_id:string;external_id:string;
        provider_uuid:string|null;state:string;environment:ProviderEnvironment;
        encrypted_credentials:string;amount_minor:string
      }>(
        "SELECT d.id,d.payment_intent_id,d.external_id,d.provider_uuid,d.state,"+
        "d.environment,c.encrypted_credentials,i.amount_minor::text "+
        "FROM commerce_fiscal_document d "+
        "JOIN commerce_provider_connection c ON c.tenant_id=d.tenant_id AND c.id=d.connector_id "+
        "JOIN commerce_payment_intent i ON i.tenant_id=d.tenant_id AND i.id=d.payment_intent_id "+
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
        "AND (provider_uuid IS NULL OR provider_uuid=$4)",
        [ctx.tenantId,siteId,documentId,receiptUuid,status.state,
          status.fnNumber??null,status.documentNumber??null,
          status.fiscalSign??null,status.receiptUrl??null]);
      if(!update.rowCount)throw new ConflictException("Документ изменён, повторите сверку");
      if(status.state==="DONE"){
        await client.query(
          "UPDATE commerce_payment_intent SET fiscal_status='SUCCEEDED',updated_at=now() "+
          "WHERE tenant_id=$1 AND id=$2 AND fiscal_provider='ATOL_ONLINE' "+
          "AND status='SUCCEEDED' AND finance_payment_id IS NOT NULL",
          [ctx.tenantId,row.payment_intent_id]);
      }
    });
    return {documentId,state:status.state,
      ...(status.state==="DONE"?{
        fnNumber:status.fnNumber,documentNumber:status.documentNumber,
        fiscalSign:status.fiscalSign,receiptUrl:status.receiptUrl
      }:{})};
  }
}
