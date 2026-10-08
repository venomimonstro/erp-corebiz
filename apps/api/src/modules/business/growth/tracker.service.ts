import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHmac, randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { RedisService } from "../../../infrastructure/cache/redis.service";
import { getEnv } from "../../../infrastructure/config/env";

@Injectable()
export class TrackerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService
  ) {}

  async listSites(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT id,name,tracker_key,allowed_domains,status,created_at,updated_at " +
        "FROM tracker_site WHERE tenant_id=$1 ORDER BY created_at DESC",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createSite(
    context: TenantContext,
    input: { name: string; allowedDomains?: string[] }
  ): Promise<{ id: string; trackerKey: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название сайта");
    }

    const domains = this.normalizeDomains(input.allowedDomains ?? []);
    if (!domains.length) {
      throw new BadRequestException("Укажите хотя бы один разрешённый домен");
    }

    const trackerKey = "cb_" + randomBytes(24).toString("base64url");

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO tracker_site(" +
        "tenant_id,name,tracker_key,allowed_domains,created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [
          context.tenantId,
          name,
          trackerKey,
          JSON.stringify(domains),
          context.membershipId
        ]
      );

      const site = result.rows[0];
      if (!site) throw new Error("TRACKER_SITE_CREATE_FAILED");

      await client.query(
        "INSERT INTO audit_event(" +
        "tenant_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,after_data" +
        ") VALUES ($1,$2,$3,'growth.tracker_site_created','tracker_site',$4,$5)",
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          site.id,
          JSON.stringify({ name, allowedDomains: domains })
        ]
      );

      return { id: site.id, trackerKey };
    });
  }

  async rotateKey(
    context: TenantContext,
    siteId: string
  ): Promise<{ trackerKey: string }> {
    const trackerKey = "cb_" + randomBytes(24).toString("base64url");

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "UPDATE tracker_site SET tracker_key=$3,updated_at=now() " +
        "WHERE tenant_id=$1 AND id=$2 RETURNING id",
        [context.tenantId, siteId, trackerKey]
      );

      if (!result.rowCount) {
        throw new NotFoundException("Tracker-site не найден");
      }

      await client.query(
        "INSERT INTO audit_event(" +
        "tenant_id,actor_user_id,actor_membership_id,action,resource_type,resource_id" +
        ") VALUES ($1,$2,$3,'growth.tracker_key_rotated','tracker_site',$4)",
        [context.tenantId, context.userId, context.membershipId, siteId]
      );

      return { trackerKey };
    });
  }

  async collect(
    input: {
      trackerKey: string;
      visitorId: string;
      sessionId: string;
      eventId: string;
      eventName: string;
      occurredAt?: string;
      pageUrl?: string;
      title?: string;
      referrerUrl?: string;
      source?: string;
      medium?: string;
      campaign?: string;
      content?: string;
      term?: string;
      yclid?: string;
      gclid?: string;
      vkClickId?: string;
      analyticsConsent?: "UNKNOWN" | "GRANTED" | "DENIED";
      adsConsent?: "UNKNOWN" | "GRANTED" | "DENIED";
      properties?: Record<string, unknown>;
    },
    requestMeta: { origin?: string }
  ): Promise<{ accepted: boolean; duplicate?: boolean; reason?: string }> {
    if (input.analyticsConsent !== "GRANTED") {
      return {
        accepted: false,
        reason: "analytics_consent_required"
      };
    }

    this.assertKey(input.trackerKey, "trackerKey", 256);
    this.assertKey(input.visitorId, "visitorId", 256);
    this.assertKey(input.sessionId, "sessionId", 256);
    this.assertKey(input.eventId, "eventId", 256);

    const eventName = input.eventName?.trim();
    if (!eventName || !/^[a-z][a-z0-9_.-]{1,119}$/.test(eventName)) {
      throw new BadRequestException("Некорректное имя события");
    }

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (
      Number.isNaN(occurredAt.getTime()) ||
      Math.abs(Date.now() - occurredAt.getTime()) > 7 * 86400000
    ) {
      throw new BadRequestException("Время события вне допустимого диапазона");
    }

    const properties = this.sanitizeProperties(input.properties ?? {});

    const lookup = await this.database.query<{
      site_id: string;
      tenant_id: string;
      allowed_domains: unknown;
    }>(
      "SELECT * FROM corebiz_resolve_tracker_site($1)",
      [input.trackerKey.trim()]
    );

    const site = lookup.rows[0];
    if (!site) throw new NotFoundException("Tracker-site не найден");

    const allowedDomains = Array.isArray(site.allowed_domains)
      ? site.allowed_domains.map(String)
      : [];

    const pageHost = this.urlHost(input.pageUrl);
    const originHost = this.urlHost(requestMeta.origin);

    if (
      !allowedDomains.length ||
      ![originHost, pageHost].filter(Boolean).some((host) => allowedDomains.includes(host!))
    ) {
      throw new ForbiddenException("Домен не разрешён для этого tracker-site");
    }

    const visitorHash = this.hmac(site.site_id + "|" + input.visitorId);
    const sessionHash = this.hmac(site.site_id + "|" + input.sessionId);

    const rate = await this.redis.incrementWindow(
      "tracker-rate:" + site.site_id + ":" + visitorHash,
      60
    );
    if (rate > 120) {
      return { accepted: false, reason: "rate_limited" };
    }

    const pageUrl = this.safePageUrl(input.pageUrl, allowedDomains);
    const referrerUrl = this.safeExternalUrl(input.referrerUrl);

    return this.database.withTransaction(async (client) => {
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true)",
        [site.tenant_id]
      );

      const existing = await client.query(
        "SELECT 1 FROM marketing_event WHERE tenant_id=$1 AND event_key=$2",
        [site.tenant_id, input.eventId.trim()]
      );

      if (existing.rowCount) {
        return { accepted: true, duplicate: true };
      }

      const visitorResult = await client.query<{
        id: string;
        party_id: string | null;
      }>(
        "INSERT INTO marketing_visitor(" +
        "tenant_id,visitor_key_hash,analytics_consent,ads_consent,first_seen_at,last_seen_at" +
        ") VALUES ($1,$2,'GRANTED',$3,$4,$4) " +
        "ON CONFLICT (tenant_id,visitor_key_hash) DO UPDATE SET " +
        "analytics_consent='GRANTED',ads_consent=EXCLUDED.ads_consent," +
        "last_seen_at=GREATEST(marketing_visitor.last_seen_at,EXCLUDED.last_seen_at) " +
        "RETURNING id,party_id",
        [
          site.tenant_id,
          visitorHash,
          input.adsConsent === "GRANTED"
            ? "GRANTED"
            : input.adsConsent === "DENIED"
              ? "DENIED"
              : "UNKNOWN",
          occurredAt
        ]
      );

      const visitorId = visitorResult.rows[0]!.id;

      const sessionResult = await client.query<{ id: string }>(
        "INSERT INTO marketing_session(" +
        "tenant_id,visitor_id,session_key_hash,started_at,last_event_at,landing_url,referrer_url," +
        "source,medium,campaign,content,term,yclid,gclid,vk_click_id" +
        ") VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) " +
        "ON CONFLICT (tenant_id,session_key_hash) DO UPDATE SET " +
        "last_event_at=GREATEST(marketing_session.last_event_at,EXCLUDED.last_event_at) " +
        "RETURNING id",
        [
          site.tenant_id,
          visitorId,
          sessionHash,
          occurredAt,
          pageUrl,
          referrerUrl,
          this.limit(input.source, 300),
          this.limit(input.medium, 300),
          this.limit(input.campaign, 500),
          this.limit(input.content, 500),
          this.limit(input.term, 500),
          this.limit(input.yclid, 500),
          this.limit(input.gclid, 500),
          this.limit(input.vkClickId, 500)
        ]
      );

      const sessionId = sessionResult.rows[0]!.id;

      await client.query(
        "INSERT INTO marketing_touchpoint(" +
        "tenant_id,touchpoint_key,visitor_id,session_id,party_id,channel,event_name," +
        "source,medium,campaign,content,term,yclid,gclid,vk_click_id,is_direct,occurred_at" +
        ") SELECT s.tenant_id,'session:'||s.id::text,s.visitor_id,s.id,v.party_id," +
        "'WEB','session_start',s.source,s.medium,s.campaign,s.content,s.term," +
        "s.yclid,s.gclid,s.vk_click_id," +
        "(COALESCE(NULLIF(lower(s.source),''),'direct') IN ('direct','(direct)') " +
        "OR (s.source IS NULL AND s.referrer_url IS NULL)),s.started_at " +
        "FROM marketing_session s JOIN marketing_visitor v " +
        "ON v.tenant_id=s.tenant_id AND v.id=s.visitor_id " +
        "WHERE s.tenant_id=$1 AND s.id=$2 " +
        "ON CONFLICT (tenant_id,touchpoint_key) DO UPDATE SET " +
        "party_id=COALESCE(EXCLUDED.party_id,marketing_touchpoint.party_id)",
        [site.tenant_id, sessionId]
      );

      await client.query(
        "INSERT INTO marketing_event(" +
        "tenant_id,visitor_id,session_id,event_key,event_name,occurred_at,page_url,title,properties,party_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          site.tenant_id,
          visitorId,
          sessionId,
          input.eventId.trim(),
          eventName,
          occurredAt,
          pageUrl,
          this.limit(input.title, 1000),
          JSON.stringify(properties),
          visitorResult.rows[0]!.party_id
        ]
      );

      return { accepted: true };
    });
  }

  async summary(
    context: TenantContext,
    fromInput?: string,
    toInput?: string
  ): Promise<Record<string, unknown>> {
    const to = toInput ? new Date(toInput) : new Date();
    const from = fromInput
      ? new Date(fromInput)
      : new Date(to.getTime() - 30 * 86400000);

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 366 * 86400000
    ) {
      throw new BadRequestException("Некорректный период");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const totals = await client.query(
        "SELECT * FROM corebiz_tracker_summary($1,$2,$3)",
        [context.tenantId, from, to]
      );

      const sources = await client.query(
        "SELECT COALESCE(source,'direct') AS source,COALESCE(medium,'none') AS medium," +
        "count(*)::int AS sessions,count(DISTINCT visitor_id)::int AS visitors " +
        "FROM marketing_session WHERE tenant_id=$1 AND started_at >= $2 AND started_at < $3 " +
        "GROUP BY source,medium ORDER BY sessions DESC LIMIT 50",
        [context.tenantId, from, to]
      );

      const campaigns = await client.query(
        "SELECT COALESCE(campaign,'(not set)') AS campaign,COALESCE(source,'direct') AS source," +
        "count(*)::int AS sessions,count(DISTINCT visitor_id)::int AS visitors " +
        "FROM marketing_session WHERE tenant_id=$1 AND started_at >= $2 AND started_at < $3 " +
        "GROUP BY campaign,source ORDER BY sessions DESC LIMIT 100",
        [context.tenantId, from, to]
      );

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        totals: totals.rows[0] ?? {},
        sources: sources.rows,
        campaigns: campaigns.rows
      };
    });
  }

  snippet(trackerKey: string): string {
    const key = JSON.stringify(trackerKey);

    return [
      "(function(){",
      "var s=document.currentScript;",
      "if(!s)return;",
      "var base=new URL(s.src).origin;",
      "var endpoint=base+'/api/v1/tracker/collect';",
      "var key=" + key + ";",
      "var vid=localStorage.getItem('cb_vid')||crypto.randomUUID();",
      "localStorage.setItem('cb_vid',vid);",
      "var sid=sessionStorage.getItem('cb_sid')||crypto.randomUUID();",
      "sessionStorage.setItem('cb_sid',sid);",
      "window.corebizTrack=function(name,props){",
      "if(window.corebizAnalyticsConsent!=='GRANTED')return;",
      "var u=new URL(location.href);",
      "fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},",
      "body:JSON.stringify({trackerKey:key,visitorId:vid,sessionId:sid,",
      "eventId:crypto.randomUUID(),eventName:name,pageUrl:location.href,",
      "title:document.title,referrerUrl:document.referrer||'',",
      "source:u.searchParams.get('utm_source')||'',medium:u.searchParams.get('utm_medium')||'',",
      "campaign:u.searchParams.get('utm_campaign')||'',content:u.searchParams.get('utm_content')||'',",
      "term:u.searchParams.get('utm_term')||'',yclid:u.searchParams.get('yclid')||'',",
      "gclid:u.searchParams.get('gclid')||'',vkClickId:u.searchParams.get('vk_click_id')||'',",
      "analyticsConsent:'GRANTED',properties:props||{}}),keepalive:true}).catch(function(){});",
      "};",
      "window.corebizTrack('page_view');",
      "})();"
    ].join("");
  }

  private normalizeDomains(domains: string[]): string[] {
    const normalized = domains.map((domain) => {
      const value = domain.trim();
      if (!value) return "";
      try {
        const url = new URL(value.includes("://") ? value : "https://" + value);
        return url.hostname.toLowerCase();
      } catch {
        throw new BadRequestException("Некорректный домен: " + domain);
      }
    });

    return Array.from(new Set(normalized.filter(Boolean))).slice(0, 50);
  }

  private safePageUrl(value: string | undefined, allowed: string[]): string | null {
    if (!value) return null;
    if (value.length > 4000) throw new BadRequestException("URL слишком длинный");

    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("protocol");
      }
      if (!allowed.includes(url.hostname.toLowerCase())) {
        throw new ForbiddenException("pageUrl относится к другому домену");
      }
      url.username = "";
      url.password = "";
      url.hash = "";
      return url.toString();
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException("Некорректный pageUrl");
    }
  }

  private safeExternalUrl(value?: string): string | null {
    if (!value || value.length > 4000) return null;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      url.username = "";
      url.password = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  private urlHost(value?: string): string | null {
    if (!value) return null;
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private hmac(value: string): string {
    return createHmac("sha256", getEnv().sessionSecret)
      .update(value)
      .digest("hex");
  }

  private assertKey(value: string, name: string, max: number): void {
    if (!value?.trim() || value.length > max) {
      throw new BadRequestException("Некорректный " + name);
    }
  }

  private limit(value: string | undefined, max: number): string | null {
    const normalized = value?.trim();
    return normalized ? normalized.slice(0, max) : null;
  }

  private sanitizeProperties(
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (JSON.stringify(properties).length > 12000) {
      throw new BadRequestException("Слишком большой payload события");
    }

    const blocked = new Set([
      "password","passwd","token","authorization","cookie",
      "creditcard","cardnumber","cvv","cvc"
    ]);

    const clean = (value: unknown, depth: number): unknown => {
      if (depth > 4) return null;
      if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => clean(item, depth + 1));
      }
      if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
          if (blocked.has(key.toLowerCase().replace(/[^a-z]/g, ""))) continue;
          result[key.slice(0, 80)] = clean(item, depth + 1);
        }
        return result;
      }
      if (typeof value === "string") return value.slice(0, 500);
      if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return value;
      }
      return String(value).slice(0, 500);
    };

    return clean(properties, 0) as Record<string, unknown>;
  }
}
