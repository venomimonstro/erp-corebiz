import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { getEnv } from "../../../infrastructure/config/env";

@Injectable()
export class TrackerService {
  constructor(private readonly database: DatabaseService) {}

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
    input: {
      name: string;
      allowedDomains?: string[];
    }
  ): Promise<{ id: string; trackerKey: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название сайта");
    }

    const domains = this.normalizeDomains(input.allowedDomains ?? []);
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

      return {
        id: result.rows[0]!.id,
        trackerKey
      };
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

      if (!result.rowCount) throw new NotFoundException("Tracker-site не найден");
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
    requestMeta: {
      origin?: string;
      ip?: string;
      userAgent?: string;
    }
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    if (input.analyticsConsent === "DENIED") {
      return { accepted: false };
    }

    this.assertKey(input.trackerKey, "trackerKey", 256);
    this.assertKey(input.visitorId, "visitorId", 256);
    this.assertKey(input.sessionId, "sessionId", 256);
    this.assertKey(input.eventId, "eventId", 256);

    const eventName = input.eventName?.trim();
    if (!eventName || eventName.length > 120) {
      throw new BadRequestException("Некорректное имя события");
    }

    const occurredAt = input.occurredAt
      ? new Date(input.occurredAt)
      : new Date();

    if (Number.isNaN(occurredAt.getTime())) {
      throw new BadRequestException("Некорректное время события");
    }

    const skew = Math.abs(Date.now() - occurredAt.getTime());
    if (skew > 7 * 86400000) {
      throw new BadRequestException("Время события вне допустимого диапазона");
    }

    const properties = input.properties ?? {};
    if (JSON.stringify(properties).length > 12000) {
      throw new BadRequestException("Слишком большой payload события");
    }

    const lookup = await this.database.query<{
      site_id: string;
      tenant_id: string;
      allowed_domains: unknown;
      status: string;
    }>(
      "SELECT * FROM corebiz_tracker_site_lookup($1)",
      [input.trackerKey]
    );

    const site = lookup.rows[0];
    if (!site || site.status !== "ACTIVE") {
      throw new NotFoundException("Tracker-site не найден");
    }

    const allowedDomains = Array.isArray(site.allowed_domains)
      ? site.allowed_domains.map(String)
      : [];

    this.assertOriginAllowed(
      allowedDomains,
      requestMeta.origin,
      input.pageUrl
    );

    const visitorHash = this.hmac(site.site_id + "|" + input.visitorId);
    const sessionHash = this.hmac(site.site_id + "|" + input.sessionId);
    const ipHash = requestMeta.ip
      ? this.hmac("ip|" + requestMeta.ip)
      : null;
    const userAgentHash = requestMeta.userAgent
      ? this.hmac("ua|" + requestMeta.userAgent)
      : null;

    return this.database.withTransaction(async (client) => {
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true)",
        [site.tenant_id]
      );

      const existing = await client.query(
        "SELECT 1 FROM marketing_event WHERE tenant_id=$1 AND event_key=$2",
        [site.tenant_id, input.eventId]
      );

      if (existing.rowCount) {
        return { accepted: true, duplicate: true };
      }

      const visitorResult = await client.query<{ id: string }>(
        "INSERT INTO marketing_visitor(" +
        "tenant_id,visitor_key_hash,analytics_consent,ads_consent,last_seen_at" +
        ") VALUES ($1,$2,$3,$4,now()) " +
        "ON CONFLICT (tenant_id,visitor_key_hash) DO UPDATE SET " +
        "analytics_consent=EXCLUDED.analytics_consent," +
        "ads_consent=EXCLUDED.ads_consent,last_seen_at=now() " +
        "RETURNING id",
        [
          site.tenant_id,
          visitorHash,
          input.analyticsConsent === "GRANTED" ? "GRANTED" : "UNKNOWN",
          input.adsConsent ?? "UNKNOWN"
        ]
      );

      const visitorId = visitorResult.rows[0]!.id;

      const sessionResult = await client.query<{ id: string }>(
        "INSERT INTO marketing_session(" +
        "tenant_id,visitor_id,session_key_hash,landing_url,referrer_url," +
        "source,medium,campaign,content,term,yclid,gclid,vk_click_id," +
        "ip_hash,user_agent_hash,last_event_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now()) " +
        "ON CONFLICT (tenant_id,session_key_hash) DO UPDATE SET " +
        "last_event_at=now() RETURNING id",
        [
          site.tenant_id,
          visitorId,
          sessionHash,
          this.limit(input.pageUrl, 4000),
          this.limit(input.referrerUrl, 4000),
          this.limit(input.source, 300),
          this.limit(input.medium, 300),
          this.limit(input.campaign, 500),
          this.limit(input.content, 500),
          this.limit(input.term, 500),
          this.limit(input.yclid, 500),
          this.limit(input.gclid, 500),
          this.limit(input.vkClickId, 500),
          ipHash,
          userAgentHash
        ]
      );

      const sessionId = sessionResult.rows[0]!.id;

      await client.query(
        "INSERT INTO marketing_event(" +
        "tenant_id,visitor_id,session_id,event_key,event_name,occurred_at," +
        "page_url,title,properties" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          site.tenant_id,
          visitorId,
          sessionId,
          input.eventId,
          eventName,
          occurredAt,
          this.limit(input.pageUrl, 4000),
          this.limit(input.title, 1000),
          JSON.stringify(properties)
        ]
      );

      return { accepted: true };
    });
  }

  snippet(trackerKey: string): string {
    const key = JSON.stringify(trackerKey);

    return [
      "(function(){",
      "var key=" + key + ";",
      "var endpoint='/api/v1/tracker/collect';",
      "var vid=localStorage.getItem('cb_vid')||crypto.randomUUID();",
      "localStorage.setItem('cb_vid',vid);",
      "var sid=sessionStorage.getItem('cb_sid')||crypto.randomUUID();",
      "sessionStorage.setItem('cb_sid',sid);",
      "window.corebizTrack=function(name,props){",
      "if(window.corebizAnalyticsConsent==='DENIED')return;",
      "var u=new URL(location.href);",
      "fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},",
      "body:JSON.stringify({trackerKey:key,visitorId:vid,sessionId:sid,",
      "eventId:crypto.randomUUID(),eventName:name,pageUrl:location.href,",
      "title:document.title,referrerUrl:document.referrer||'',",
      "source:u.searchParams.get('utm_source')||'',medium:u.searchParams.get('utm_medium')||'',",
      "campaign:u.searchParams.get('utm_campaign')||'',content:u.searchParams.get('utm_content')||'',",
      "term:u.searchParams.get('utm_term')||'',yclid:u.searchParams.get('yclid')||'',",
      "gclid:u.searchParams.get('gclid')||'',vkClickId:u.searchParams.get('vk_click_id')||'',",
      "analyticsConsent:window.corebizAnalyticsConsent||'UNKNOWN',properties:props||{}})});",
      "};",
      "window.corebizTrack('page_view');",
      "})();"
    ].join("");
  }

  private normalizeDomains(domains: string[]): string[] {
    return Array.from(
      new Set(
        domains
          .map((domain) => domain.trim().toLowerCase())
          .filter(Boolean)
          .map((domain) => domain.replace(/^https?:\/\//, "").replace(/\/$/, ""))
      )
    ).slice(0, 50);
  }

  private assertOriginAllowed(
    allowed: string[],
    origin?: string,
    pageUrl?: string
  ): void {
    if (!allowed.length) return;

    const candidates: string[] = [];

    for (const value of [origin, pageUrl]) {
      if (!value) continue;
      try {
        candidates.push(new URL(value).host.toLowerCase());
      } catch {
        // Invalid optional URL simply does not become a candidate.
      }
    }

    if (!candidates.some((host) => allowed.includes(host))) {
      throw new ForbiddenException("Домен не разрешён для этого tracker-site");
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
    if (!value) return null;
    return value.slice(0, max);
  }
}
