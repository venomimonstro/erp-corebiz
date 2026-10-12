import {
  BadGatewayException,BadRequestException,ConflictException,Injectable,
  NotFoundException
} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {createHash} from "node:crypto";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../authorization/authorization.service";
import {openMerchantSecret,sealMerchantSecret} from "../payments/yookassa.gateway";
import {
  AtolOnlineGateway,CdekGateway,type ProviderEnvironment,
  type AtolCredentials,type CdekCredentials
} from "./merchant-gateways";

type Provider="CDEK"|"ATOL_ONLINE";
type Connection={
  id:string;tenant_id:string;site_id:string;provider:Provider;
  environment:ProviderEnvironment;encrypted_credentials:string;
  public_config:Record<string,unknown>;state:string;enabled:boolean;
};
const validUuid=(x:unknown):x is string=>
  typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(x);

@Injectable()
export class MerchantConnectorService{
  private readonly cdek=new CdekGateway();
  private readonly atol=new AtolOnlineGateway();
  constructor(
    private readonly db:DatabaseService,
    private readonly auth:AuthorizationService
  ){}

  private async requireAll(ctx:TenantContext,permission:"sites.read"|"sites.manage"){
    const scope=await this.auth.resolveScope(ctx,permission);
    if(scope!=="all")
      throw new BadRequestException(
        "Для внешних договоров, ключей и отправлений требуется доступ ко всем сайтам компании"
      );
  }

  private validateProvider(input:unknown):Provider{
    if(input!=="CDEK"&&input!=="ATOL_ONLINE")
      throw new BadRequestException("Пока доступны СДЭК v2 и АТОЛ Онлайн v5");
    return input;
  }
  private validateSite(id:unknown):string{
    if(!validUuid(id))throw new BadRequestException("Некорректный сайт");
    return id;
  }
  async list(ctx:TenantContext,siteId:string){
    await this.requireAll(ctx,"sites.read");
    this.validateSite(siteId);
    return this.db.withTenantTransaction(ctx,async client=>{
      const s=await client.query(
        "SELECT 1 FROM site WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",
        [siteId,ctx.tenantId]);
      if(!s.rowCount)throw new NotFoundException("Сайт не найден");
      const result=await client.query(
        `SELECT id,provider,environment,state,enabled,public_config,
           verified_at,last_error_code,created_at,updated_at
         FROM commerce_provider_connection WHERE tenant_id=$1 AND site_id=$2
         ORDER BY provider`,[ctx.tenantId,siteId]);
      return result.rows;
    });
  }
  async configure(ctx:TenantContext,siteId:string,body:{
    provider:Provider;environment:ProviderEnvironment;
    credentials:Record<string,unknown>;fromCityCode?:number;
    fiscalCompany?:{
      inn:string;email:string;sno:string;paymentAddress:string;
      vatType:string
    }
  }){
    await this.requireAll(ctx,"sites.manage");
    this.validateSite(siteId);
    const provider=this.validateProvider(body?.provider);
    if(!["SANDBOX","PRODUCTION"].includes(body?.environment))
      throw new BadRequestException("Выберите тестовый или рабочий контур");
    if(!body.credentials||typeof body.credentials!=="object" ||
       Array.isArray(body.credentials))
      throw new BadRequestException("Укажите реквизиты подключения");
    let credentials:CdekCredentials|AtolCredentials;
    let config:Record<string,unknown>={};
    if(provider==="CDEK"){
      const {clientId,clientSecret}=body.credentials;
      if(typeof clientId!=="string"||typeof clientSecret!=="string"||
         clientId.length<3||clientId.length>256||
         clientSecret.length<8||clientSecret.length>256)
        throw new BadRequestException("Некорректный Client ID/Secret СДЭК");
      if(!Number.isInteger(body.fromCityCode)||
         (body.fromCityCode??0)<1||Number(body.fromCityCode)>99999999)
        throw new BadRequestException("Требуется код города отправления СДЭК");
      credentials={clientId,clientSecret};
      config={fromCityCode:body.fromCityCode};
    }else{
      const {login,password,groupCode}=body.credentials;
      if(typeof login!=="string"||typeof password!=="string"||
         typeof groupCode!=="string"||login.length<2||login.length>140||
         password.length<6||password.length>256||
         !/^[A-Za-z0-9_-]{2,140}$/.test(groupCode))
        throw new BadRequestException("Некорректные реквизиты группы АТОЛ");
      credentials={login,password,groupCode};
      const fiscal=body.fiscalCompany;
      const choices=["none","vat0","vat5","vat7","vat10","vat20","vat22"];
      if(fiscal!==undefined){
        if(!fiscal||typeof fiscal!=="object"||
          typeof fiscal.inn!=="string"||
          !/^\d{10}(\d{2})?$/.test(fiscal.inn)||
          typeof fiscal.email!=="string"||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fiscal.email)||
          fiscal.email.length>64||
          typeof fiscal.sno!=="string"||
          !["osn","usn_income","usn_income_outcome","esn","patent"].includes(fiscal.sno)||
          typeof fiscal.paymentAddress!=="string"||
          fiscal.paymentAddress.trim().length<5||
          fiscal.paymentAddress.length>256||
          !choices.includes(fiscal.vatType))
          throw new BadRequestException(
            "Для выдачи чеков нужны корректные ИНН, email, СНО, место расчёта и ставка НДС"
          );
      }
      config={groupCode,...(fiscal?{fiscalCompany:fiscal}:{})};
    }
    const encrypted=sealMerchantSecret(JSON.stringify(credentials));
    return this.db.withTenantTransaction(ctx,async client=>{
      const site=await client.query(
        "SELECT 1 FROM site WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",
        [siteId,ctx.tenantId]);
      if(!site.rowCount)throw new NotFoundException("Сайт не найден");
      if(provider==="ATOL_ONLINE"){
        const open=await client.query(
          `SELECT 1 FROM commerce_payment_intent
           WHERE tenant_id=$1 AND site_id=$2 AND fiscal_provider='ATOL_ONLINE'
             AND (status IN ('NEW','PENDING') OR
               (status='SUCCEEDED' AND fiscal_status<>'SUCCEEDED'))
           LIMIT 1`,[ctx.tenantId,siteId]);
        if(open.rowCount)throw new ConflictException(
          "Нельзя менять реквизиты АТОЛ до завершения всех фискальных документов"
        );
      }
      const result=await client.query<{id:string}>(
        `INSERT INTO commerce_provider_connection(
          tenant_id,site_id,provider,environment,encrypted_credentials,
          public_config,state,enabled,verified_at
        ) VALUES($1,$2,$3,$4,$5,$6,'CONFIGURED_UNVERIFIED',false,NULL)
        ON CONFLICT (tenant_id,site_id,provider) DO UPDATE SET
          environment=EXCLUDED.environment,
          encrypted_credentials=EXCLUDED.encrypted_credentials,
          public_config=EXCLUDED.public_config,state='CONFIGURED_UNVERIFIED',
          enabled=false,verified_at=NULL,last_error_code=NULL,updated_at=now()
        RETURNING id`,
        [ctx.tenantId,siteId,provider,body.environment,encrypted,
          JSON.stringify(config)]);
      return {connectionId:result.rows[0]!.id,
        state:"CONFIGURED_UNVERIFIED",enabled:false};
    });
  }
  private async connection(ctx:TenantContext,siteId:string,provider:Provider){
    return this.db.withTenantTransaction(ctx,async client=>{
      const result=await client.query<Connection>(
        `SELECT * FROM commerce_provider_connection
         WHERE tenant_id=$1 AND site_id=$2 AND provider=$3`,
        [ctx.tenantId,siteId,provider]);
      return result.rows[0]??null;
    });
  }
  async verify(ctx:TenantContext,siteId:string,providerInput:unknown){
    await this.requireAll(ctx,"sites.manage");
    this.validateSite(siteId);const provider=this.validateProvider(providerInput);
    const conn=await this.connection(ctx,siteId,provider);
    if(!conn)throw new NotFoundException("Сначала сохраните реквизиты");
    const secret=JSON.parse(openMerchantSecret(conn.encrypted_credentials)) as
      CdekCredentials & AtolCredentials;
    try{
      if(provider==="CDEK")await this.cdek.token(secret,conn.environment);
      else await this.atol.verify(secret,conn.environment);
      const committed=await this.db.withTenantTransaction(ctx,async client=>
        client.query(
          `UPDATE commerce_provider_connection
           SET state='VERIFIED',enabled=true,verified_at=now(),
             last_error_code=NULL,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND encrypted_credentials=$3
           RETURNING id`,
          [ctx.tenantId,conn.id,conn.encrypted_credentials]));
      if(!committed.rowCount)throw new ConflictException(
        "Реквизиты изменились во время проверки; повторите подтверждение"
      );
      return {provider,environment:conn.environment,state:"VERIFIED",
        note:provider==="ATOL_ONLINE"
          ?"Авторизация АТОЛ подтверждена; настоящие фискальные чеки ещё не испытаны."
          :"СДЭК авторизовал API-ключ. Расчёт и создание реальных отправлений проверяются отдельно."};
    }catch{
      await this.db.withTenantTransaction(ctx,async client=>
        client.query(
          `UPDATE commerce_provider_connection
           SET state='DEGRADED',enabled=false,last_error_code='AUTH_OR_PROVIDER',
             updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND encrypted_credentials=$3`,
          [ctx.tenantId,conn.id,conn.encrypted_credentials]));
      throw new BadGatewayException(
        "Провайдер не подтвердил подключение. Проверьте тестовый/боевой контур и ключи."
      );
    }
  }
  async shipments(ctx:TenantContext,siteId:string){
    await this.requireAll(ctx,"sites.read");
    this.validateSite(siteId);
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        `SELECT s.id,s.sales_order_id,o.business_number,s.state,
           s.provider_order_uuid,s.provider_number,s.tariff_code,
           s.snapshot_amount_minor::text AS amount_minor,s.last_error_code,
           s.created_at,s.updated_at
         FROM commerce_shipment s
         JOIN sales_order o ON o.tenant_id=s.tenant_id AND o.id=s.sales_order_id
         WHERE s.tenant_id=$1 AND s.site_id=$2
         ORDER BY s.created_at DESC LIMIT 100`,[ctx.tenantId,siteId]);
      return r.rows;
    });
  }
  async bookShipment(ctx:TenantContext,siteId:string,body:{
    orderId:string;quoteId:string;
    recipientName:string;recipientPhone:string;
    lengthCm:number;widthCm:number;heightCm:number
  }){
    await this.requireAll(ctx,"sites.manage");
    this.validateSite(siteId);
    if(!validUuid(body?.orderId)||!validUuid(body?.quoteId))
      throw new BadRequestException("Некорректный заказ или тариф");
    const recipientName=typeof body?.recipientName==="string"
      ?body.recipientName.trim():"";
    const recipientPhone=typeof body?.recipientPhone==="string"
      ?body.recipientPhone.replace(/[()\s-]/g,""):"";
    if(!recipientName||recipientName.length<2||recipientName.length>160||
       !recipientPhone||!/^\+?[0-9]{10,15}$/.test(recipientPhone)||
       ![body.lengthCm,body.widthCm,body.heightCm].every(x=>
         Number.isInteger(x)&&x>=1&&x<=300)){
      throw new BadRequestException("Проверьте получателя и габариты посылки");
    }
    const connection=await this.connection(ctx,siteId,"CDEK");
    if(!connection||connection.state!=="VERIFIED"||!connection.enabled)
      throw new ConflictException("Доступ СДЭК не подтверждён");
    const fingerprint=createHash("sha256").update(JSON.stringify({
      siteId,orderId:body.orderId,quoteId:body.quoteId,
      recipientName,recipientPhone,
      dims:[body.lengthCm,body.widthCm,body.heightCm]
    })).digest("hex");
    const prepared=await this.db.withTenantTransaction(ctx,async client=>{
      // Lock the actual order; failed transactions cannot leave a
      // booking claim while a second concurrent request proceeds.
      const order=await client.query<{id:string;delivery_address:string|null}>(
        `SELECT o.id,d.address AS delivery_address FROM sales_order o
         JOIN storefront_cart c ON c.tenant_id=o.tenant_id
           AND c.sales_order_id=o.id AND c.site_id=$3
         JOIN commerce_order_delivery d ON d.tenant_id=o.tenant_id
           AND d.sales_order_id=o.id AND d.site_id=$3
           AND d.mode='LOCAL_COURIER'
         WHERE o.tenant_id=$1 AND o.id=$2
           AND o.payment_status='PAID'
           AND o.order_status IN ('CONFIRMED','COMPLETED')
           AND o.fulfillment_status IN ('RESERVED','READY')
           AND EXISTS(
             SELECT 1 FROM commerce_payment_intent pi
             WHERE pi.tenant_id=o.tenant_id AND pi.sales_order_id=o.id
               AND pi.purpose='STOREFRONT' AND pi.status='SUCCEEDED'
               AND pi.finance_payment_id IS NOT NULL
               AND pi.fiscal_status='SUCCEEDED'
           )
         FOR UPDATE OF o`,
        [ctx.tenantId,body.orderId,siteId]);
      if(!order.rowCount)throw new ConflictException(
        "Для накладной необходимы подтверждённая оплата YooKassa, чек, резерв и курьерская доставка"
      );
      const deliveryAddress=order.rows[0]?.delivery_address?.trim()??"";
      if(deliveryAddress.length<5||deliveryAddress.length>500)
        throw new ConflictException(
          "Нельзя оформить курьера без адреса из подтверждённого заказа"
        );
      const quote=await client.query<{
        tariff_code:number;from_city_code:number;to_city_code:number;
        package_weight_grams:number;amount_minor:string;
      }>(
        `SELECT q.tariff_code,q.from_city_code,q.to_city_code,
           q.package_weight_grams,q.amount_minor::text
         FROM commerce_shipping_quote q
         JOIN commerce_provider_connection cp
           ON cp.tenant_id=q.tenant_id AND cp.id=q.connection_id
         WHERE q.tenant_id=$1 AND q.id=$2
           AND q.site_id=$3 AND q.connection_id=$4 AND q.expires_at>now()
           AND q.created_at>=cp.verified_at
           AND cp.state='VERIFIED' AND cp.enabled`,
        [ctx.tenantId,body.quoteId,siteId,connection.id]);
      const q=quote.rows[0];if(!q)throw new ConflictException(
        "Тариф истёк или относится к другому магазину"
      );
      const lines=await client.query<{
        description:string;quantity_milli:string;line_total_minor:string;
        sku_code:string;
      }>(
        `SELECT l.description,l.quantity_milli::text,l.line_total_minor::text,
           s.code AS sku_code
         FROM sales_order_line l JOIN sku s
           ON s.tenant_id=l.tenant_id AND s.id=l.sku_id
         WHERE l.tenant_id=$1 AND l.order_id=$2
         ORDER BY l.id`,
        [ctx.tenantId,body.orderId]);
      if(!lines.rows.length||lines.rows.length>126)
        throw new ConflictException("Для отправления СДЭК нужны 1–126 товарных SKU");
      const items=lines.rows.map(x=>{
        const qty=BigInt(x.quantity_milli);
        const total=BigInt(x.line_total_minor);
        if(qty<=0n||qty%1000n!==0n||
           qty/1000n>10000n||
           total%(qty/1000n)!==0n)
          throw new ConflictException(
            "СДЭК требует целое количество товаров и точную цену за единицу"
          );
        const unitMinor=total/(qty/1000n);
        const cost=(unitMinor/100n).toString()+"."+
          (unitMinor%100n).toString().padStart(2,"0");
        if(cost.length>13)
          throw new ConflictException("Стоимость позиции СДЭК слишком большая");
        return {name:x.description.slice(0,255),
          wareKey:x.sku_code.slice(0,80),cost,amount:Number(qty/1000n)};
      });
      const old=await client.query<{id:string;payload_digest:string;state:string}>(
        `SELECT id,payload_digest,state FROM commerce_shipment
         WHERE tenant_id=$1 AND sales_order_id=$2 FOR UPDATE`,
        [ctx.tenantId,body.orderId]);
      if(old.rows[0]){
        if(old.rows[0].payload_digest!==fingerprint)
          throw new ConflictException("Для заказа уже есть другая накладная");
        return {id:old.rows[0].id,retry:false,quote:q,items,deliveryAddress};
      }
      const r=await client.query<{id:string}>(
        `INSERT INTO commerce_shipment(
          tenant_id,site_id,sales_order_id,connection_id,quote_id,
          payload_digest,state,recipient_name,recipient_phone,
          tariff_code,snapshot_amount_minor
         ) VALUES($1,$2,$3,$4,$5,$6,'SENDING',$7,$8,$9,$10)
         RETURNING id`,
        [ctx.tenantId,siteId,body.orderId,connection.id,body.quoteId,
          fingerprint,recipientName,recipientPhone,q.tariff_code,q.amount_minor]);
      return {id:r.rows[0]!.id,retry:true,quote:q,items,deliveryAddress};
    });
    if(!prepared.retry)return {
      shipmentId:prepared.id,state:"ALREADY_EXISTS",
      note:"Новая накладная не создавалась. Сверьте существующий заказ СДЭК."
    };
    // Network side effect is deliberately ONCE, after the claim was committed.
    // On a timeout the provider may have created a consignment:
    // marking UNKNOWN is safer than an unsafe automatic retry.
    try{
      const secret=JSON.parse(openMerchantSecret(connection.encrypted_credentials)) as CdekCredentials;
      const response=await this.cdek.createOrder(secret,connection.environment,{
        orderNumber:body.orderId,
        tariffCode:prepared.quote.tariff_code,
        fromCityCode:prepared.quote.from_city_code,
        toCityCode:prepared.quote.to_city_code,
        recipientName,recipientPhone,
        deliveryAddress:prepared.deliveryAddress,
        weightGrams:prepared.quote.package_weight_grams,
        lengthCm:body.lengthCm,widthCm:body.widthCm,heightCm:body.heightCm,
        items:prepared.items
      });
      await this.db.withTenantTransaction(ctx,async client=>client.query(
        `UPDATE commerce_shipment
         SET state='SUBMITTED',provider_order_uuid=$3,
           submitted_at=now(),updated_at=now(),last_error_code=NULL
         WHERE tenant_id=$1 AND id=$2 AND state='SENDING'`,
        [ctx.tenantId,prepared.id,response.uuid]));
      return {shipmentId:prepared.id,state:"SUBMITTED",
        providerOrderUuid:response.uuid};
    }catch{
      await this.db.withTenantTransaction(ctx,async client=>client.query(
        `UPDATE commerce_shipment
         SET state='UNKNOWN',last_error_code='PROVIDER_RESPONSE_AMBIGUOUS',
           updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND state='SENDING'`,
        [ctx.tenantId,prepared.id]));
      return {shipmentId:prepared.id,state:"UNKNOWN",
        note:"СДЭК мог создать накладную. Повтор запрещён до ручной сверки."};
    }
  }
  async verifyShipment(ctx:TenantContext,siteId:string,
    shipmentId:string,providerUuid?:string){
    await this.requireAll(ctx,"sites.manage");
    this.validateSite(siteId);
    if(!validUuid(shipmentId)||
       (providerUuid!==undefined&&!validUuid(providerUuid)))
      throw new BadRequestException("Некорректный UUID отправления");
    const r=await this.db.withTenantTransaction(ctx,async client=>
      client.query<{
        id:string;sales_order_id:string;provider_order_uuid:string|null;
        state:string
      }>(
        `SELECT id,sales_order_id,provider_order_uuid,state
         FROM commerce_shipment WHERE tenant_id=$1 AND site_id=$2 AND id=$3`,
        [ctx.tenantId,siteId,shipmentId]));
    const row=r.rows[0];if(!row)throw new NotFoundException("Отправление не найдено");
    const uuid=row.provider_order_uuid??providerUuid;
    if(!uuid)throw new ConflictException(
      "После неизвестного результата укажите UUID из кабинета СДЭК"
    );
    if(row.provider_order_uuid&&row.provider_order_uuid!==uuid)
      throw new ConflictException("UUID отправления нельзя менять");
    const connection=await this.connection(ctx,siteId,"CDEK");
    if(!connection)throw new NotFoundException("Подключение СДЭК недоступно");
    const secret=JSON.parse(openMerchantSecret(connection.encrypted_credentials)) as CdekCredentials;
    const status=await this.cdek.orderStatus(secret,connection.environment,uuid);
    if(status.clientOrderNumber!==row.sales_order_id)
      throw new ConflictException("СДЭК вернул накладную другого заказа");
    const states:Record<string,string>={
      CREATED:"ACCEPTED",ACCEPTED:"ACCEPTED",RECEIVED_AT_SHIPMENT_WAREHOUSE:"IN_TRANSIT",
      SENT_TO_TRANSIT_CITY:"IN_TRANSIT",DELIVERED:"DELIVERED",
      NOT_DELIVERED:"IN_TRANSIT",CANCELLED:"CANCELLED",REJECTED:"REJECTED"
    };
    const next=states[status.state]??"SUBMITTED";
    await this.db.withTenantTransaction(ctx,async client=>client.query(
      `UPDATE commerce_shipment
       SET provider_order_uuid=$4,provider_number=$5,state=$6,
         verified_at=now(),updated_at=now(),last_error_code=NULL
       WHERE tenant_id=$1 AND site_id=$2 AND id=$3
         AND (provider_order_uuid IS NULL OR provider_order_uuid=$4)`,
      [ctx.tenantId,siteId,shipmentId,uuid,status.cdekNumber,next]));
    // Carrier proof never makes payment PAID and does not post stock.
    return {shipmentId,state:next,trackingNumber:status.cdekNumber,
      providerOrderUuid:uuid};
  }

  async quote(ctx:TenantContext,siteId:string,input:{
    toCityCode:number;weightGrams:number;
    lengthCm:number;widthCm:number;heightCm:number
  }){
    await this.requireAll(ctx,"sites.manage");
    this.validateSite(siteId);
    for(const key of ["toCityCode","weightGrams","lengthCm","widthCm","heightCm"] as const){
      const value=input?.[key];
      if(!Number.isInteger(value)||value<1||value>100000)
        throw new BadRequestException("Некорректные параметры доставки: "+key);
    }
    const conn=await this.connection(ctx,siteId,"CDEK");
    if(!conn||conn.state!=="VERIFIED"||!conn.enabled)
      throw new ConflictException("Подтвердите реквизиты СДЭК");
    const from=Number(conn.public_config?.fromCityCode);
    if(!Number.isInteger(from)||from<1)
      throw new ConflictException("Нет города отправления");
    const credentials=JSON.parse(openMerchantSecret(conn.encrypted_credentials)) as CdekCredentials;
    const rates=await this.cdek.rates(credentials,conn.environment,{
      fromCityCode:from,toCityCode:input.toCityCode,
      weightGrams:input.weightGrams,
      lengthCm:input.lengthCm,widthCm:input.widthCm,heightCm:input.heightCm
    });
    return this.db.withTenantTransaction(ctx,async client=>{
      const results=[];
      for(const rate of rates){
        const r=await client.query<{id:string;expires_at:Date}>(
          `INSERT INTO commerce_shipping_quote(
            tenant_id,site_id,connection_id,provider,from_city_code,
            to_city_code,package_weight_grams,tariff_code,amount_minor,
            expires_at
           ) VALUES ($1,$2,$3,'CDEK',$4,$5,$6,$7,$8,now()+interval '15 minutes')
           RETURNING id,expires_at`,
          [ctx.tenantId,siteId,conn.id,from,input.toCityCode,input.weightGrams,
            rate.tariffCode,rate.deliverySumMinor]);
        results.push({quoteId:r.rows[0]!.id,provider:"CDEK",
          tariffCode:rate.tariffCode,amountMinor:rate.deliverySumMinor,
          periodMin:rate.periodMin,periodMax:rate.periodMax,
          expiresAt:r.rows[0]!.expires_at.toISOString()});
      }
      return results;
    });
  }
}
