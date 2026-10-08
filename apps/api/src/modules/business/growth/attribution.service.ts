import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { getEnv } from "../../../infrastructure/config/env";

type AttributionModel =
  | "FIRST_TOUCH"
  | "LAST_TOUCH"
  | "LAST_PAID_TOUCH";

@Injectable()
export class AttributionService {
  constructor(private readonly database: DatabaseService) {}

  async linkVisitor(
    context: TenantContext,
    input: {
      trackerKey: string;
      visitorId: string;
      partyId: string;
      source?: "FORM" | "CRM" | "API" | "IMPORT" | "MANUAL";
      confidence?: number;
      evidence?: Record<string, unknown>;
    }
  ): Promise<{ visitorId: string; partyId: string }> {
    const confidence = input.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new BadRequestException("confidence должен быть от 0 до 1");
    }

    const lookup = await this.database.query<{
      site_id: string;
      tenant_id: string;
    }>(
      "SELECT site_id,tenant_id FROM corebiz_resolve_tracker_site($1)",
      [input.trackerKey.trim()]
    );

    const site = lookup.rows[0];
    if (!site || site.tenant_id !== context.tenantId) {
      throw new NotFoundException("Tracker-site не найден");
    }

    const visitorHash = createHmac(
      "sha256",
      getEnv().sessionSecret
    )
      .update(site.site_id + "|" + input.visitorId.trim())
      .digest("hex");

    return this.database.withTenantTransaction(context, async (client) => {
      const party = await client.query(
        "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId, input.partyId]
      );
      if (!party.rowCount) throw new NotFoundException("Клиент не найден");

      const visitorResult = await client.query<{
        id: string;
        party_id: string | null;
      }>(
        "SELECT id,party_id FROM marketing_visitor " +
        "WHERE tenant_id=$1 AND visitor_key_hash=$2 FOR UPDATE",
        [context.tenantId, visitorHash]
      );

      const visitor = visitorResult.rows[0];
      if (!visitor) throw new NotFoundException("Visitor не найден");

      if (visitor.party_id && visitor.party_id !== input.partyId) {
        throw new ConflictException(
          "Visitor уже связан с другим клиентом"
        );
      }

      await client.query(
        "INSERT INTO marketing_identity_link(" +
        "tenant_id,visitor_id,party_id,source,confidence,evidence,linked_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7) " +
        "ON CONFLICT (tenant_id,visitor_id,party_id) DO UPDATE SET " +
        "source=EXCLUDED.source,confidence=EXCLUDED.confidence," +
        "evidence=EXCLUDED.evidence,linked_by_membership_id=EXCLUDED.linked_by_membership_id," +
        "revoked_at=NULL",
        [
          context.tenantId,
          visitor.id,
          input.partyId,
          input.source ?? "FORM",
          confidence,
          JSON.stringify(input.evidence ?? {}),
          context.membershipId
        ]
      );

      await client.query(
        "UPDATE marketing_visitor SET party_id=$3,last_seen_at=GREATEST(last_seen_at,now()) " +
        "WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, visitor.id, input.partyId]
      );

      await client.query(
        "UPDATE marketing_event SET party_id=$3 " +
        "WHERE tenant_id=$1 AND visitor_id=$2",
        [context.tenantId, visitor.id, input.partyId]
      );

      await this.materializeTouchpoints(
        client,
        context.tenantId,
        visitor.id,
        input.partyId
      );

      await this.recalculateParty(
        client,
        context.tenantId,
        input.partyId
      );

      await client.query(
        "INSERT INTO audit_event(" +
        "tenant_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,after_data" +
        ") VALUES ($1,$2,$3,'growth.visitor_linked','party',$4,$5)",
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          input.partyId,
          JSON.stringify({
            visitorId: visitor.id,
            source: input.source ?? "FORM",
            confidence
          })
        ]
      );

      return {
        visitorId: visitor.id,
        partyId: input.partyId
      };
    });
  }

  async recalculate(
    context: TenantContext,
    partyId?: string
  ): Promise<{ parties: number }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const parties = partyId
        ? [{ party_id: partyId }]
        : (
            await client.query<{ party_id: string }>(
              "SELECT DISTINCT party_id FROM marketing_identity_link " +
              "WHERE tenant_id=$1 AND revoked_at IS NULL",
              [context.tenantId]
            )
          ).rows;

      for (const row of parties) {
        await this.recalculateParty(
          client,
          context.tenantId,
          row.party_id
        );
      }

      return { parties: parties.length };
    });
  }

  async results(
    context: TenantContext,
    model: AttributionModel,
    fromInput?: string,
    toInput?: string
  ): Promise<Record<string, unknown>> {
    if (!["FIRST_TOUCH","LAST_TOUCH","LAST_PAID_TOUCH"].includes(model)) {
      throw new BadRequestException("Неизвестная модель атрибуции");
    }

    const to = toInput ? new Date(toInput) : new Date();
    const from = fromInput
      ? new Date(fromInput)
      : new Date(to.getTime() - 30 * 86400000);

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException("Некорректный период");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const totals = await client.query(
        "SELECT count(*)::int AS conversions," +
        "count(*) FILTER (WHERE touchpoint_id IS NOT NULL)::int AS attributed " +
        "FROM attribution_result WHERE tenant_id=$1 AND model=$2 " +
        "AND conversion_at >= $3 AND conversion_at < $4",
        [context.tenantId, model, from, to]
      );

      const sources = await client.query(
        "SELECT COALESCE(source,'unattributed') AS source," +
        "COALESCE(medium,'none') AS medium,count(*)::int AS conversions " +
        "FROM attribution_result WHERE tenant_id=$1 AND model=$2 " +
        "AND conversion_at >= $3 AND conversion_at < $4 " +
        "GROUP BY source,medium ORDER BY conversions DESC",
        [context.tenantId, model, from, to]
      );

      const campaigns = await client.query(
        "SELECT COALESCE(campaign,'(not set)') AS campaign," +
        "COALESCE(source,'unattributed') AS source,count(*)::int AS conversions " +
        "FROM attribution_result WHERE tenant_id=$1 AND model=$2 " +
        "AND conversion_at >= $3 AND conversion_at < $4 " +
        "GROUP BY campaign,source ORDER BY conversions DESC LIMIT 100",
        [context.tenantId, model, from, to]
      );

      return {
        model,
        period: { from: from.toISOString(), to: to.toISOString() },
        totals: totals.rows[0] ?? { conversions: 0, attributed: 0 },
        sources: sources.rows,
        campaigns: campaigns.rows
      };
    });
  }

  async journey(
    context: TenantContext,
    partyId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const party = await client.query<{ display_name: string }>(
        "SELECT display_name FROM party WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, partyId]
      );
      if (!party.rows[0]) throw new NotFoundException("Клиент не найден");

      const touchpoints = await client.query(
        "SELECT id,occurred_at,source,medium,campaign,landing_url,is_paid " +
        "FROM marketing_touchpoint WHERE tenant_id=$1 AND party_id=$2 " +
        "ORDER BY occurred_at",
        [context.tenantId, partyId]
      );

      const conversions = await client.query(
        "SELECT conversion_type,conversion_id,conversion_at,model," +
        "touchpoint_id,source,medium,campaign " +
        "FROM attribution_result WHERE tenant_id=$1 AND party_id=$2 " +
        "ORDER BY conversion_at,model",
        [context.tenantId, partyId]
      );

      return {
        party: {
          id: partyId,
          name: party.rows[0].display_name
        },
        touchpoints: touchpoints.rows,
        conversions: conversions.rows
      };
    });
  }

  private async materializeTouchpoints(
    client: PoolClient,
    tenantId: string,
    visitorId: string,
    partyId: string
  ): Promise<void> {
    await client.query(
      "INSERT INTO marketing_touchpoint(" +
      "tenant_id,visitor_id,session_id,party_id,occurred_at,source,medium,campaign," +
      "content,term,yclid,gclid,vk_click_id,landing_url,referrer_url,is_paid" +
      ") SELECT s.tenant_id,s.visitor_id,s.id,$3,s.started_at,s.source,s.medium,s.campaign," +
      "s.content,s.term,s.yclid,s.gclid,s.vk_click_id,s.landing_url,s.referrer_url," +
      "CASE WHEN s.yclid IS NOT NULL OR s.gclid IS NOT NULL OR s.vk_click_id IS NOT NULL " +
      "OR lower(COALESCE(s.medium,'')) IN ('cpc','ppc','paid','cpm','display','paid_social') " +
      "THEN true ELSE false END " +
      "FROM marketing_session s WHERE s.tenant_id=$1 AND s.visitor_id=$2 " +
      "ON CONFLICT (tenant_id,session_id) DO UPDATE SET party_id=EXCLUDED.party_id",
      [tenantId, visitorId, partyId]
    );
  }

  private async recalculateParty(
    client: PoolClient,
    tenantId: string,
    partyId: string
  ): Promise<void> {
    const conversions = await client.query<{
      conversion_type: "SALES_ORDER" | "SERVICE_BOOKING";
      conversion_id: string;
      conversion_at: Date;
    }>(
      "SELECT 'SALES_ORDER'::text AS conversion_type,id AS conversion_id,confirmed_at AS conversion_at " +
      "FROM sales_order WHERE tenant_id=$1 AND party_id=$2 AND confirmed_at IS NOT NULL " +
      "UNION ALL " +
      "SELECT 'SERVICE_BOOKING'::text AS conversion_type,id AS conversion_id,completed_at AS conversion_at " +
      "FROM service_booking WHERE tenant_id=$1 AND party_id=$2 AND completed_at IS NOT NULL",
      [tenantId, partyId]
    );

    for (const conversion of conversions.rows) {
      for (const model of [
        "FIRST_TOUCH",
        "LAST_TOUCH",
        "LAST_PAID_TOUCH"
      ] as AttributionModel[]) {
        const touchpoint = await this.pickTouchpoint(
          client,
          tenantId,
          partyId,
          conversion.conversion_at,
          model
        );

        await client.query(
          "INSERT INTO attribution_result(" +
          "tenant_id,party_id,conversion_type,conversion_id,conversion_at,model," +
          "touchpoint_id,source,medium,campaign,credit,lookback_days,computed_at" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,90,now()) " +
          "ON CONFLICT (tenant_id,conversion_type,conversion_id,model) DO UPDATE SET " +
          "party_id=EXCLUDED.party_id,conversion_at=EXCLUDED.conversion_at," +
          "touchpoint_id=EXCLUDED.touchpoint_id,source=EXCLUDED.source," +
          "medium=EXCLUDED.medium,campaign=EXCLUDED.campaign,computed_at=now()",
          [
            tenantId,
            partyId,
            conversion.conversion_type,
            conversion.conversion_id,
            conversion.conversion_at,
            model,
            touchpoint?.id ?? null,
            touchpoint?.source ?? null,
            touchpoint?.medium ?? null,
            touchpoint?.campaign ?? null
          ]
        );
      }
    }
  }

  private async pickTouchpoint(
    client: PoolClient,
    tenantId: string,
    partyId: string,
    conversionAt: Date,
    model: AttributionModel
  ): Promise<{
    id: string;
    source: string | null;
    medium: string | null;
    campaign: string | null;
  } | null> {
    const order = model === "FIRST_TOUCH" ? "ASC" : "DESC";
    const paid = model === "LAST_PAID_TOUCH" ? "AND is_paid=true" : "";

    const result = await client.query<{
      id: string;
      source: string | null;
      medium: string | null;
      campaign: string | null;
    }>(
      "SELECT id,source,medium,campaign FROM marketing_touchpoint " +
      "WHERE tenant_id=$1 AND party_id=$2 AND occurred_at <= $3 " +
      "AND occurred_at >= $3::timestamptz - interval '90 days' " +
      paid +
      " ORDER BY occurred_at " + order + " LIMIT 1",
      [tenantId, partyId, conversionAt]
    );

    return result.rows[0] ?? null;
  }
}
