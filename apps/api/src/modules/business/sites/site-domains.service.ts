import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class SiteDomainsService{
  constructor(private readonly database:DatabaseService){}

  async list(context:TenantContext,siteId:string):Promise<Array<Record<string,unknown>>>{
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT id,hostname,status,is_primary,verified_at,activated_at,created_at
         FROM site_domain
         WHERE tenant_id=$1 AND site_id=$2
         ORDER BY is_primary DESC,created_at`,
        [context.tenantId,siteId]
      );
      return result.rows;
    });
  }

  async create(
    context:TenantContext,
    siteId:string,
    hostnameInput:string
  ):Promise<{id:string;hostname:string;verificationHost:string;verificationValue:string}>{
    const hostname=this.hostname(hostnameInput);
    const token=randomBytes(24).toString("base64url");

    return this.database.withTenantTransaction(context,async client=>{
      const site=await client.query(
        `SELECT 1 FROM site WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,siteId]
      );
      if(!site.rowCount) throw new NotFoundException("Сайт не найден");

      try{
        const result=await client.query<{id:string}>(
          `INSERT INTO site_domain(
             tenant_id,site_id,hostname,verification_token,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5)
           RETURNING id`,
          [context.tenantId,siteId,hostname,token,context.membershipId]
        );
        return {
          id:result.rows[0]!.id,
          hostname,
          verificationHost:"_corebiz."+hostname,
          verificationValue:"corebiz-site-verification="+token
        };
      }catch(error){
        if(error&&typeof error==="object"&&"code" in error&&error.code==="23505"){
          throw new ConflictException("Домен уже подключён");
        }
        throw error;
      }
    });
  }

  async verificationInstructions(
    context:TenantContext,
    domainId:string
  ):Promise<Record<string,unknown>>{
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{
        hostname:string;verification_token:string;status:string;
      }>(
        `SELECT hostname,verification_token,status
         FROM site_domain WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,domainId]
      );
      const row=result.rows[0];
      if(!row) throw new NotFoundException("Домен не найден");
      return {
        hostname:row.hostname,
        status:row.status,
        verificationHost:"_corebiz."+row.hostname,
        verificationValue:"corebiz-site-verification="+row.verification_token
      };
    });
  }

  async verify(context:TenantContext,domainId:string):Promise<{verified:boolean}>{
    const row=await this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{
        hostname:string;verification_token:string;status:string;
      }>(
        `SELECT hostname,verification_token,status
         FROM site_domain WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,domainId]
      );
      return result.rows[0]??null;
    });
    if(!row) throw new NotFoundException("Домен не найден");
    if(["VERIFIED","ACTIVE"].includes(row.status)) return {verified:true};

    let records:string[][]=[];
    try{
      records=await resolveTxt("_corebiz."+row.hostname);
    }catch{
      return {verified:false};
    }

    const expected="corebiz-site-verification="+row.verification_token;
    const verified=records
      .map(parts=>parts.join(""))
      .some(value=>value.trim()===expected);

    if(!verified) return {verified:false};

    await this.database.withTenantTransaction(context,async client=>{
      await client.query(
        `UPDATE site_domain
         SET status='VERIFIED',verified_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='PENDING'`,
        [context.tenantId,domainId]
      );
    });

    return {verified:true};
  }

  async activate(
    context:TenantContext,
    domainId:string,
    makePrimary=true
  ):Promise<void>{
    await this.database.withTenantTransaction(context,async client=>{
      const domain=await client.query<{site_id:string;status:string}>(
        `SELECT site_id,status
         FROM site_domain
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,domainId]
      );
      const row=domain.rows[0];
      if(!row) throw new NotFoundException("Домен не найден");
      if(!["VERIFIED","ACTIVE"].includes(row.status)){
        throw new BadRequestException("Сначала подтвердите DNS TXT запись");
      }

      if(makePrimary){
        await client.query(
          `UPDATE site_domain
           SET is_primary=false,updated_at=now()
           WHERE tenant_id=$1 AND site_id=$2 AND id<>$3`,
          [context.tenantId,row.site_id,domainId]
        );
      }

      await client.query(
        `UPDATE site_domain
         SET status='ACTIVE',
             is_primary=$3,
             activated_at=COALESCE(activated_at,now()),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,domainId,makePrimary]
      );
    });
  }

  async publicByHost(hostInput:string,pageSlug?:string):Promise<Record<string,unknown>>{
    const host=this.hostname(hostInput);
    const path=!pageSlug||pageSlug.trim()==="/"
      ?"/"
      :"/"+pageSlug.trim().replace(/^\/+|\/+$/g,"");

    const result=await this.database.query<{payload:Record<string,unknown>|null}>(
      `SELECT corebiz_public_site_page_by_host($1,$2) AS payload`,
      [host,path]
    );
    if(!result.rows[0]?.payload) throw new NotFoundException("Страница не опубликована");
    return result.rows[0].payload;
  }

  private hostname(value:string):string{
    const raw=value.trim().toLowerCase().replace(/\.$/,"");
    if(raw.length<4||raw.length>253||raw.includes("/")||raw.includes(":")){
      throw new BadRequestException("Некорректный домен");
    }
    if(!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)){
      throw new BadRequestException("Некорректный домен");
    }
    return raw;
  }
}
