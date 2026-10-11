import {
  BadGatewayException,BadRequestException,ConflictException,Injectable,
  NotFoundException
} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
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
  constructor(private readonly db:DatabaseService){}

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
    credentials:Record<string,unknown>;fromCityCode?:number
  }){
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
      config={groupCode};
    }
    const encrypted=sealMerchantSecret(JSON.stringify(credentials));
    return this.db.withTenantTransaction(ctx,async client=>{
      const site=await client.query(
        "SELECT 1 FROM site WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",
        [siteId,ctx.tenantId]);
      if(!site.rowCount)throw new NotFoundException("Сайт не найден");
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
  async quote(ctx:TenantContext,siteId:string,input:{
    toCityCode:number;weightGrams:number;
    lengthCm:number;widthCm:number;heightCm:number
  }){
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
