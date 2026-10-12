import {
  BadGatewayException,BadRequestException,ConflictException,
  Injectable,NotFoundException
} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../authorization/authorization.service";
import {openMerchantSecret,sealMerchantSecret} from "../payments/yookassa.gateway";
import {
  RussianPostGateway,validRussianPostCredentials,
  type RussianPostCredentials
} from "./russian-post.gateway";

const isUuid=(value:unknown):value is string=>
  typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
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
}
