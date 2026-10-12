import {createHash} from "node:crypto";
import {
  BadGatewayException,BadRequestException,ConflictException,
  Injectable,NotFoundException
} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {RussianPostShipmentGateway,validPostalConsignment,type PostalAddress} from "./russian-post-shipment.gateway";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../authorization/authorization.service";
import {openMerchantSecret,sealMerchantSecret} from "../payments/yookassa.gateway";
import {
  RussianPostGateway,validRussianPostCredentials,
  type RussianPostCredentials
} from "./russian-post.gateway";

const isUuid=(value:unknown):value is string=>
  typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isPostcode=(value:unknown):value is string=>
  typeof value==="string"&&/^[0-9]{6}$/.test(value);

type Connection={
  id:string;site_id:string;encrypted_credentials:string;
  public_config:{fromPostcode?:string};
  state:string;enabled:boolean;verified_at:Date|null;
};

@Injectable()
export class RussianPostService{
  private readonly gateway=new RussianPostGateway();
  private readonly shipmentsGateway=new RussianPostShipmentGateway();
  constructor(
    private readonly db:DatabaseService,
    private readonly authorization:AuthorizationService
  ){}
  private async permit(ctx:TenantContext){
    if(await this.authorization.resolveScope(ctx,"sites.manage")!=="all")
      throw new BadRequestException(
        "Почтовые договоры и отправления доступны только управляющему компанией"
      );
  }
  private assertSite(id:unknown):asserts id is string{
    if(!isUuid(id))throw new BadRequestException("Некорректный ID сайта");
  }
  private async connection(ctx:TenantContext,siteId:string){
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query<Connection>(
        "SELECT id,site_id,encrypted_credentials,public_config,"+
        "state,enabled,verified_at FROM commerce_provider_connection "+
        "WHERE tenant_id=$1 AND site_id=$2 AND provider='POCHTA_RUSSIA'",
        [ctx.tenantId,siteId]);
      return r.rows[0]??null;
    });
  }
  async status(ctx:TenantContext,siteId:string){
    await this.permit(ctx);this.assertSite(siteId);
    const conn=await this.connection(ctx,siteId);
    if(!conn)return {configured:false,provider:"POCHTA_RUSSIA"};
    return {
      configured:true,provider:"POCHTA_RUSSIA",state:conn.state,
      enabled:conn.enabled,fromPostcode:conn.public_config.fromPostcode??null,
      verifiedAt:conn.verified_at?.toISOString()??null
    };
  }
  async configure(ctx:TenantContext,siteId:string,input:{
    accessToken:string;userAuthorizationKey:string;fromPostcode:string
  }){
    await this.permit(ctx);this.assertSite(siteId);
    if(!input||!validRussianPostCredentials(input)||
       !isPostcode(input.fromPostcode))
      throw new BadRequestException(
        "Нужны 6-значный индекс, API-токен приложения и Basic-ключ Почты России"
      );
    const encrypted=sealMerchantSecret(JSON.stringify({
      accessToken:input.accessToken,
      userAuthorizationKey:input.userAuthorizationKey
    }));
    return this.db.withTenantTransaction(ctx,async client=>{
      const site=await client.query(
        "SELECT 1 FROM site WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [ctx.tenantId,siteId]);
      if(!site.rowCount)throw new NotFoundException("Активный сайт не найден");
      const r=await client.query<{id:string}>(
        "INSERT INTO commerce_provider_connection("+
        "tenant_id,site_id,provider,environment,encrypted_credentials,"+
        "public_config,state,enabled,verified_at) "+
        "VALUES($1,$2,'POCHTA_RUSSIA','PRODUCTION',$3,$4,"+
        "'CONFIGURED_UNVERIFIED',false,NULL) "+
        "ON CONFLICT(tenant_id,site_id,provider) DO UPDATE SET "+
        "encrypted_credentials=EXCLUDED.encrypted_credentials,"+
        "public_config=EXCLUDED.public_config,environment='PRODUCTION',"+
        "state='CONFIGURED_UNVERIFIED',enabled=false,verified_at=NULL,"+
        "last_error_code=NULL,updated_at=now() RETURNING id",
        [ctx.tenantId,siteId,encrypted,
          JSON.stringify({fromPostcode:input.fromPostcode})]);
      return {connectionId:r.rows[0]!.id,state:"CONFIGURED_UNVERIFIED"};
    });
  }
  async verify(ctx:TenantContext,siteId:string,toPostcode:string){
    await this.permit(ctx);this.assertSite(siteId);
    if(!isPostcode(toPostcode))
      throw new BadRequestException("Нужен 6-значный индекс проверки");
    const conn=await this.connection(ctx,siteId);
    if(!conn)throw new NotFoundException("Сначала добавьте реквизиты Почты России");
    const origin=conn.public_config.fromPostcode;
    if(!isPostcode(origin))throw new ConflictException("Не указан индекс отправителя");
    const credentials=JSON.parse(
      openMerchantSecret(conn.encrypted_credentials)) as RussianPostCredentials;
    try{
      // Read-only tariff calculation proves the merchant credentials work;
      // no parcel or paid shipment is created.
      await this.gateway.tariff(credentials,{
        fromPostcode:origin,toPostcode,massGrams:1000
      });
      const updated=await this.db.withTenantTransaction(ctx,async client=>
        client.query(
          "UPDATE commerce_provider_connection "+
          "SET state='VERIFIED',enabled=true,verified_at=now(),"+
          "last_error_code=NULL,updated_at=now() "+
          "WHERE tenant_id=$1 AND id=$2 AND "+
          "encrypted_credentials=$3 RETURNING id",
          [ctx.tenantId,conn.id,conn.encrypted_credentials]));
      if(!updated.rowCount)
        throw new ConflictException(
          "Ключи изменились во время проверки. Запустите её повторно."
        );
      return {provider:"POCHTA_RUSSIA",state:"VERIFIED",
        note:"Авторизация и тариф Почты России подтверждены. "+
          "Это не создание посылки и не доказательство её приёмки."};
    }catch(error){
      if(error instanceof ConflictException)throw error;
      await this.db.withTenantTransaction(ctx,async client=>
        client.query(
          "UPDATE commerce_provider_connection SET "+
          "state='DEGRADED',enabled=false,last_error_code='TARIFF_FAILED',"+
          "updated_at=now() "+
          "WHERE tenant_id=$1 AND id=$2 AND encrypted_credentials=$3",
          [ctx.tenantId,conn.id,conn.encrypted_credentials]));
      throw new BadGatewayException(
        "Почта России не подтвердила тариф или API-ключи"
      );
    }
  }
  async quote(ctx:TenantContext,siteId:string,input:{
    toPostcode:string;massGrams:number
  }){
    await this.permit(ctx);this.assertSite(siteId);
    if(!input||!isPostcode(input.toPostcode)||
       !Number.isSafeInteger(input.massGrams)||
       input.massGrams<1||input.massGrams>20000)
      throw new BadRequestException("Укажите индекс получателя и вес 1–20000 г");
    const conn=await this.connection(ctx,siteId);
    if(!conn||conn.state!=="VERIFIED"||!conn.enabled)
      throw new ConflictException("Проверьте подключение к Почте России");
    const from=conn.public_config.fromPostcode;
    if(!isPostcode(from))throw new ConflictException("Отсутствует индекс отправления");
    const credentials=JSON.parse(openMerchantSecret(
      conn.encrypted_credentials)) as RussianPostCredentials;
    const result=await this.gateway.tariff(credentials,{
      fromPostcode:from,toPostcode:input.toPostcode,massGrams:input.massGrams
    });
    const saved=await this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query<{id:string;expires_at:Date}>(
        "INSERT INTO commerce_post_tariff_quote("+
        "tenant_id,site_id,connection_id,from_postcode,to_postcode,mail_type,"+
        "mass_grams,amount_minor,base_rate_minor,vat_minor,expires_at) "+
        "SELECT $1,$2,c.id,$3,$4,'POSTAL_PARCEL',$5,$6,$7,$8,"+
        "now()+interval '15 minutes' "+
        "FROM commerce_provider_connection c "+
        "WHERE c.tenant_id=$1 AND c.site_id=$2 AND c.id=$9 "+
        "AND c.enabled AND c.state='VERIFIED' AND "+
        "c.encrypted_credentials=$10 AND c.provider='POCHTA_RUSSIA' "+
        "RETURNING id,expires_at",
        [ctx.tenantId,siteId,from,input.toPostcode,input.massGrams,
          result.amountMinor,result.rateMinor,result.vatMinor,
          conn.id,conn.encrypted_credentials]);
      if(!r.rowCount)throw new ConflictException(
        "Ключи Почты России изменились. Тариф нужно пересчитать."
      );
      return r.rows[0]!;
    });
    return {
      quoteId:saved.id,expiresAt:saved.expires_at.toISOString(),
      provider:"POCHTA_RUSSIA",fromPostcode:from,
      toPostcode:input.toPostcode,mailType:"POSTAL_PARCEL",
      massGrams:input.massGrams,amountMinor:result.amountMinor,
      rateMinor:result.rateMinor,vatMinor:result.vatMinor,
      periodMin:result.periodMin,periodMax:result.periodMax,
      disclaimer:"Расчёт тарифа не создаёт отправление и не включает "+
        "оплату Почте России. Цена уточняется по договору продавца."
    };
  }

  async shipments(ctx:TenantContext,siteId:string){
    await this.permit(ctx);this.assertSite(siteId);
    const r=await this.db.withTenantTransaction(ctx,client=>
      client.query(
        `SELECT sh.id,sh.sales_order_id,o.business_number,
           sh.state,sh.provider_order_id,sh.barcode,
           sh.snapshot_amount_minor::text AS amount_minor,
           sh.last_error_code,sh.created_at
         FROM commerce_post_shipment sh JOIN sales_order o
           ON o.tenant_id=sh.tenant_id AND o.id=sh.sales_order_id
         WHERE sh.tenant_id=$1 AND sh.site_id=$2
         ORDER BY sh.created_at DESC LIMIT 100`,
        [ctx.tenantId,siteId]));
    return r.rows;
  }

  async book(ctx:TenantContext,siteId:string,input:{
    orderId:string;quoteId:string;recipientName:string;recipientPhone:string;
    destination:PostalAddress
  }){
    await this.permit(ctx);this.assertSite(siteId);
    if(!isUuid(input?.orderId)||!isUuid(input?.quoteId))
      throw new BadRequestException("Некорректный заказ или тариф");
    const name=typeof input.recipientName==="string"?
      input.recipientName.trim():"";
    const phone=typeof input.recipientPhone==="string"?
      input.recipientPhone.replace(/[()\s-]/g,""):"";
    const address=input.destination;
    if(!validPostalConsignment({
      orderNumber:input.orderId,recipientName:name,recipientPhone:phone,
      destination:address,massGrams:1000
    }))throw new BadRequestException("Проверьте ФИО, телефон и почтовый адрес");
    const conn=await this.connection(ctx,siteId);
    if(!conn||conn.state!=="VERIFIED"||!conn.enabled)
      throw new ConflictException("Почтовый договор должен быть подтверждён");
    const fingerprint=createHash("sha256").update(JSON.stringify({
      siteId,orderId:input.orderId,quoteId:input.quoteId,
      recipientName:name,recipientPhone:phone,
      destination:address
    })).digest("hex");
    const prepared=await this.db.withTenantTransaction(ctx,async client=>{
      const order=await client.query<{id:string;address:string}>(
        `SELECT o.id,d.address
         FROM sales_order o
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
         FOR UPDATE OF o`,[ctx.tenantId,input.orderId,siteId]);
      if(!order.rows[0])throw new ConflictException(
        "Необходимы подтверждённый платёж, чек, резерв и курьерский заказ"
      );
      const original=order.rows[0].address?.trim()??"";
      if(original.length<5||original.length>500)
        throw new ConflictException("В заказе отсутствует исходный адрес доставки");
      // Never silently ship to another address typed in the carrier form.
      // Postcode is checked against the quote. Named parts must match the
      // immutable customer-delivery snapshot before the external side effect.
      const canonical=(v:string)=>v.toLocaleLowerCase("ru-RU")
        .replace(/[^\p{L}\p{N}]+/gu,"");
      const current=canonical(original);
      if(![address.place,address.street,address.house].every(part=>
        current.includes(canonical(part))))
        throw new ConflictException(
          "Адрес Почты отличается от адреса покупателя. Исправьте заказ до оплаты."
        );
      const q=await client.query<{to_postcode:string;mass_grams:number;
        amount_minor:string}>(
        `SELECT q.to_postcode,q.mass_grams,q.amount_minor::text
         FROM commerce_post_tariff_quote q
         JOIN commerce_provider_connection cp
           ON cp.tenant_id=q.tenant_id AND cp.id=q.connection_id
         WHERE q.tenant_id=$1 AND q.site_id=$2 AND q.id=$3
           AND q.connection_id=$4 AND q.expires_at>now()
           AND cp.enabled AND cp.state='VERIFIED'
           AND cp.encrypted_credentials=$5
           AND cp.verified_at<=q.created_at`,
        [ctx.tenantId,siteId,input.quoteId,conn.id,
          conn.encrypted_credentials]);
      const quote=q.rows[0];
      if(!quote||quote.to_postcode.trim()!==address.index)
        throw new ConflictException(
          "Тариф истёк или не совпадает с индексом получателя"
        );
      // Match CDEK's sales_order row lock: never issue both carrier
      // consignments for a single checkout, including UNKNOWN bookings.
      const competing=await client.query(
        `SELECT 1 FROM commerce_shipment
         WHERE tenant_id=$1 AND sales_order_id=$2 LIMIT 1`,
        [ctx.tenantId,input.orderId]);
      if(competing.rowCount)throw new ConflictException(
        "Для заказа уже оформлена накладная СДЭК. Вторая отправка запрещена."
      );
      const old=await client.query<{id:string;payload_digest:string}>(
        `SELECT id,payload_digest FROM commerce_post_shipment
         WHERE tenant_id=$1 AND sales_order_id=$2 FOR UPDATE`,
        [ctx.tenantId,input.orderId]);
      if(old.rows[0]){
        if(old.rows[0].payload_digest!==fingerprint)
          throw new ConflictException("У заказа уже есть другое почтовое отправление");
        return {id:old.rows[0].id,send:false,massGrams:quote.mass_grams};
      }
      const created=await client.query<{id:string}>(
        `INSERT INTO commerce_post_shipment(
           tenant_id,site_id,sales_order_id,connection_id,quote_id,
           payload_digest,state,recipient_name,recipient_phone,
           recipient_address,snapshot_amount_minor)
         VALUES($1,$2,$3,$4,$5,$6,'SENDING',$7,$8,$9,$10)
         RETURNING id`,
        [ctx.tenantId,siteId,input.orderId,conn.id,input.quoteId,
          fingerprint,name,phone,original,quote.amount_minor]);
      return {id:created.rows[0]!.id,send:true,massGrams:quote.mass_grams};
    });
    if(!prepared.send)return {
      shipmentId:prepared.id,state:"ALREADY_EXISTS",
      note:"Повторная отправка запрещена. Выполните сверку существующей заявки."
    };
    try{
      const credentials=JSON.parse(
        openMerchantSecret(conn.encrypted_credentials)) as RussianPostCredentials;
      const booked=await this.shipmentsGateway.create(credentials,{
        orderNumber:input.orderId,recipientName:name,recipientPhone:phone,
        destination:address,massGrams:prepared.massGrams
      });
      await this.db.withTenantTransaction(ctx,client=>client.query(
        `UPDATE commerce_post_shipment
         SET state='BACKLOG',provider_order_id=$3,
           updated_at=now(),last_error_code=NULL
         WHERE tenant_id=$1 AND id=$2 AND state='SENDING'`,
        [ctx.tenantId,prepared.id,booked.providerId]));
      return {shipmentId:prepared.id,state:"BACKLOG",
        providerOrderId:booked.providerId,
        note:"Заказ в разделе «Новые» Почты России. ШПИ ещё не присвоен."};
    }catch{
      await this.db.withTenantTransaction(ctx,client=>client.query(
        `UPDATE commerce_post_shipment
         SET state='UNKNOWN',last_error_code='POST_RESULT_AMBIGUOUS',
           updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND state='SENDING'`,
        [ctx.tenantId,prepared.id]));
      return {shipmentId:prepared.id,state:"UNKNOWN",
        note:"Запрос мог быть принят Почтой. Не создавайте заявку повторно; выполните сверку."};
    }
  }

  async reconcileShipment(ctx:TenantContext,siteId:string,shipmentId:string){
    await this.permit(ctx);this.assertSite(siteId);
    if(!isUuid(shipmentId))
      throw new BadRequestException("Некорректный ID отправления");
    const row=await this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query<{id:string;sales_order_id:string;
        provider_order_id:string|null}>(
        `SELECT id,sales_order_id,provider_order_id
         FROM commerce_post_shipment
         WHERE tenant_id=$1 AND site_id=$2 AND id=$3`,
        [ctx.tenantId,siteId,shipmentId]);
      return r.rows[0]??null;
    });
    if(!row)throw new NotFoundException("Почтовое отправление не найдено");
    const conn=await this.connection(ctx,siteId);
    if(!conn)throw new ConflictException("Подключение Почты России не найдено");
    const credentials=JSON.parse(
      openMerchantSecret(conn.encrypted_credentials)) as RussianPostCredentials;
    const checked=row.provider_order_id
      ?await this.shipmentsGateway.read(credentials,row.provider_order_id)
      :await this.shipmentsGateway.findByOrderNumber(credentials,
        row.sales_order_id);
    if(!checked)return {shipmentId,state:"UNKNOWN",
      note:"Заказ пока не найден. Это не доказательство отмены, повтор PUT запрещён."};
    if(checked.orderNumber!==row.sales_order_id||
       row.provider_order_id&&checked.providerId!==row.provider_order_id)
      throw new ConflictException("Почта вернула отправление другого заказа");
    await this.db.withTenantTransaction(ctx,client=>client.query(
      `UPDATE commerce_post_shipment
       SET state='BACKLOG',provider_order_id=$4,barcode=$5,
         verified_at=now(),last_error_code=NULL,updated_at=now()
       WHERE tenant_id=$1 AND site_id=$2 AND id=$3
         AND (provider_order_id IS NULL OR provider_order_id=$4)`,
      [ctx.tenantId,siteId,shipmentId,checked.providerId,checked.barcode]));
    return {shipmentId,state:"BACKLOG",providerOrderId:checked.providerId,
      barcode:checked.barcode,
      note:"Это подтверждение заказа Почты, но не сдачи посылки перевозчику."};
  }
}
