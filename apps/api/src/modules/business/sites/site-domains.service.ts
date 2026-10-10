import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { domainToASCII } from "node:url";
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
      const domain=await client.query<{
        site_id:string;
        status:string;
        hostname:string;
        site_name:string;
        tracker_site_id:string|null;
        created_by_membership_id:string;
      }>(
        `SELECT
           d.site_id,d.status,d.hostname,
           s.name AS site_name,s.tracker_site_id,
           s.created_by_membership_id
         FROM site_domain d
         JOIN site s
           ON s.tenant_id=d.tenant_id AND s.id=d.site_id
         WHERE d.tenant_id=$1 AND d.id=$2
         FOR UPDATE OF d,s`,
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

      let trackerSiteId=row.tracker_site_id;

      if(!trackerSiteId){
        const trackerKey="cb_"+randomBytes(24).toString("base64url");
        const tracker=await client.query<{id:string}>(
          `INSERT INTO tracker_site(
             tenant_id,name,tracker_key,allowed_domains,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5)
           RETURNING id`,
          [
            context.tenantId,
            "Сайт: "+row.site_name,
            trackerKey,
            JSON.stringify([row.hostname]),
            row.created_by_membership_id
          ]
        );
        trackerSiteId=tracker.rows[0]!.id;

        await client.query(
          `UPDATE site
           SET tracker_site_id=$3,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.site_id,trackerSiteId]
        );
      }else{
        await client.query(
          `UPDATE tracker_site
           SET allowed_domains=(
             SELECT jsonb_agg(value ORDER BY value)
             FROM (
               SELECT DISTINCT value
               FROM jsonb_array_elements_text(
                 COALESCE(allowed_domains,'[]'::jsonb) || to_jsonb($3::text)
               ) AS d(value)
             ) q
           ),
           status='ACTIVE',
           updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,trackerSiteId,row.hostname]
        );
      }
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
    const payload=result.rows[0]?.payload;
    if(!payload) throw new NotFoundException("Страница не опубликована");

    const site=(payload as any).site ?? {};
    const tracker=site.publicSlug
      ? await this.database.query<{tracker_key:string}>(
          `SELECT * FROM corebiz_public_site_tracker($1)`,
          [String(site.publicSlug)]
        )
      : null;

    return {
      ...payload,
      analytics:{
        trackerKey:tracker?.rows[0]?.tracker_key ?? null
      }
    };
  }

  async publicRoutesByHost(
    hostInput:string
  ):Promise<Array<{pageSlug:string;publishedAt:string;publicSlug:string}>>{
    const host=this.hostname(hostInput);
    const result=await this.database.query<{
      page_slug:string;
      published_at:Date;
      public_slug:string;
    }>(
      `SELECT * FROM corebiz_public_site_routes_by_host($1)`,
      [host]
    );
    if(!result.rowCount) throw new NotFoundException("Сайт не найден");
    return result.rows.map(row=>({
      pageSlug:row.page_slug,
      publishedAt:row.published_at.toISOString(),
      publicSlug:row.public_slug
    }));
  }

  private hostname(value:string):string{
    const input=value.trim().toLowerCase().replace(/\.$/,"");
    if(
      input.length<4 ||
      input.length>253 ||
      input.includes("/") ||
      input.includes(":")
    ){
      throw new BadRequestException("Некорректный домен");
    }

    const raw=domainToASCII(input).toLowerCase().replace(/\.$/,"");
    if(!raw || raw.length>253){
      throw new BadRequestException("Некорректный домен");
    }

    const labels=raw.split(".");
    if(labels.length<2){
      throw new BadRequestException("Некорректный домен");
    }

    for(const label of labels){
      if(
        label.length<1 ||
        label.length>63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      ){
        throw new BadRequestException("Некорректный домен");
      }
    }

    const tld=labels[labels.length-1]!;
    if(tld.length<2 || (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld))){
      throw new BadRequestException("Некорректная доменная зона");
    }

    return raw;
  }
}
