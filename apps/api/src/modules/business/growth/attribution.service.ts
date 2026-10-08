import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { getEnv } from "../../../infrastructure/config/env";

type ConversionInput = {
  partyId?: string | null;
  sourceType: "LEAD" | "SALES_ORDER" | "PAYMENT" | "SERVICE_BOOKING" | "CALL" | "OTHER";
  sourceId: string;
  conversionType: "LEAD" | "ORDER" | "PAYMENT" | "REFUND" | "BOOKING" | "COMPLETED_SERVICE";
  occurredAt?: Date;
  revenueMinor?: bigint;
  currency?: string;
  metadata?: Record<string, unknown>;
};

type AttributionModel =
  | "FIRST_TOUCH"
  | "LAST_TOUCH"
  | "LAST_NON_DIRECT"
  | "LINEAR";

@Injectable()
export class AttributionService {
  constructor(private readonly database: DatabaseService) {}

  async linkVisitor(
    context: TenantContext,
    input: {
      trackerKey: string;
      visitorId: string;
      partyId: string;
      source?: "MANUAL" | "FORM" | "CHECKOUT" | "BOOKING" | "CALL" | "IMPORT" | "API";
      confidence?: number;
    }
  ): Promise<{ linked: true; visitorId: string }> {
    const confidence = input.confidence ?? 1;

    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new BadRequestException("Confidence должен быть от 0 до 1");
    }

    const lookup = await this.database.query<{
      site_id: string;
      tenant_id: string;
    }>(
      "SELECT site_id,tenant_id FROM corebiz_tracker_site_lookup($1)",
      [input.trackerKey.trim()]
    );

    const site = lookup.rows[0];
    if (!site || site.tenant_id !== context.tenantId) {
      throw new NotFoundException("Tracker-site не найден");
    }

    const visitorHash = this.hmac(site.site_id + "|" + input.visitorId.trim());

    return this.database.withTenantTransaction(context, async (client) => {
      const party = await client.query(
        "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId, input.partyId]
      );

      if (!party.rowCount) {
        throw new NotFoundException("Клиент не найден");
      }

      const visitorResult = await client.query<{
        id: string;
      }>(
        "SELECT id FROM marketing_visitor " +
        "WHERE tenant_id=$1 AND visitor_key_hash=$2 FOR UPDATE",
        [context.tenantId, visitorHash]
      );

      const visitor = visitorResult.rows[0];
      if (!visitor) {
        throw new NotFoundException("Посетитель не найден");
      }

      await client.query(
        "INSERT INTO marketing_identity_link(" +
        "tenant_id,visitor_id,party_id,source,confidence,linked_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6) " +
        "ON CONFLICT (tenant_id,visitor_id,party_id) DO UPDATE SET " +
        "source=EXCLUDED.source," +
        "confidence=GREATEST(marketing_identity_link.confidence,EXCLUDED.confidence)," +
        "linked_at=now(),linked_by_membership_id=EXCLUDED.linked_by_membership_id",
        [
          context.tenantId,
          visitor.id,
          input.partyId,
          input.source ?? "MANUAL",
          confidence,
          context.membershipId
        ]
      );

      await client.query(
        "UPDATE marketing_visitor SET party_id=$3,last_seen_at=now() " +
        "WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, visitor.id, input.partyId]
      );

      await client.query(
        "UPDATE marketing_event SET party_id=$3 " +
        "WHERE tenant_id=$1 AND visitor_id=$2 AND party_id IS NULL",
        [context.tenantId, visitor.id, input.partyId]
      );

      await client.query(
        "UPDATE marketing_touchpoint SET party_id=$3 " +
        "WHERE tenant_id=$1 AND visitor_id=$2 AND party_id IS NULL",
        [context.tenantId, visitor.id, input.partyId]
      );

      const conversions = await client.query<{ id: string }>(
        "SELECT id FROM marketing_conversion " +
        "WHERE tenant_id=$1 AND party_id=$2 AND status='ACTIVE' ORDER BY occurred_at",
        [context.tenantId, input.partyId]
      );

      for (const conversion of conversions.rows) {
        await this.recalculateConversion(
          client,
          context.tenantId,
          conversion.id
        );
      }

      return {
        linked: true,
        visitorId: visitor.id
      };
    });
  }

  async recordConversion(
    client: PoolClient,
    context: TenantContext,
    input: ConversionInput
  ): Promise<string> {
    const occurredAt = input.occurredAt ?? new Date();
    const revenueMinor = input.revenueMinor ?? 0n;
    const currency = input.currency?.trim().toUpperCase() || "RUB";

    let visitorId: string | null = null;

    if (input.partyId) {
      const visitor = await client.query<{ visitor_id: string }>(
        "SELECT visitor_id FROM marketing_identity_link " +
        "WHERE tenant_id=$1 AND party_id=$2 AND linked_at <= $3 " +
        "ORDER BY linked_at DESC,confidence DESC LIMIT 1",
        [context.tenantId, input.partyId, occurredAt]
      );

      visitorId = visitor.rows[0]?.visitor_id ?? null;
    }

    const result = await client.query<{ id: string }>(
      "INSERT INTO marketing_conversion(" +
      "tenant_id,party_id,visitor_id,source_type,source_id,conversion_type," +
      "occurred_at,revenue_minor,currency,metadata" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) " +
      "ON CONFLICT (tenant_id,source_type,source_id,conversion_type) DO UPDATE SET " +
      "party_id=EXCLUDED.party_id," +
      "visitor_id=COALESCE(EXCLUDED.visitor_id,marketing_conversion.visitor_id)," +
      "occurred_at=EXCLUDED.occurred_at,revenue_minor=EXCLUDED.revenue_minor," +
      "currency=EXCLUDED.currency,metadata=EXCLUDED.metadata,status='ACTIVE' " +
      "RETURNING id",
      [
        context.tenantId,
        input.partyId ?? null,
        visitorId,
        input.sourceType,
        input.sourceId,
        input.conversionType,
        occurredAt,
        revenueMinor.toString(),
        currency,
        JSON.stringify(input.metadata ?? {})
      ]
    );

    const conversionId = result.rows[0]!.id;

    await this.recalculateConversion(
      client,
      context.tenantId,
      conversionId
    );

    return conversionId;
  }

  async attribution(
    context: TenantContext,
    input: {
      from?: string;
      to?: string;
      model?: AttributionModel;
    }
  ): Promise<{
    model: AttributionModel;
    totalRevenueMinor: string;
    attributedRevenueMinor: string;
    rows: Array<Record<string, unknown>>;
  }> {
    const model = input.model ?? "LAST_NON_DIRECT";
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from
      ? new Date(input.from)
      : new Date(to.getTime() - 30 * 86400000);

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException("Некорректный период");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const total = await client.query<{ revenue: string }>(
        "SELECT COALESCE(sum(revenue_minor),0)::text AS revenue " +
        "FROM marketing_conversion WHERE tenant_id=$1 AND status='ACTIVE' " +
        "AND occurred_at >= $2 AND occurred_at < $3 " +
        "AND conversion_type IN ('PAYMENT','REFUND','COMPLETED_SERVICE')",
        [context.tenantId, from, to]
      );

      const rows = await client.query<{
        source: string;
        medium: string;
        campaign: string;
        conversions: string;
        attributed_revenue_minor: string;
      }>(
        "SELECT COALESCE(t.source,'direct') AS source," +
        "COALESCE(t.medium,'(none)') AS medium," +
        "COALESCE(t.campaign,'(not set)') AS campaign," +
        "count(DISTINCT a.conversion_id)::text AS conversions," +
        "COALESCE(sum(a.attributed_revenue_minor),0)::text AS attributed_revenue_minor " +
        "FROM marketing_attribution_result a " +
        "JOIN marketing_conversion c ON c.tenant_id=a.tenant_id AND c.id=a.conversion_id " +
        "JOIN marketing_touchpoint t ON t.tenant_id=a.tenant_id AND t.id=a.touchpoint_id " +
        "WHERE a.tenant_id=$1 AND a.model=$2 AND c.status='ACTIVE' " +
        "AND c.occurred_at >= $3 AND c.occurred_at < $4 " +
        "GROUP BY COALESCE(t.source,'direct'),COALESCE(t.medium,'(none)')," +
        "COALESCE(t.campaign,'(not set)') " +
        "ORDER BY sum(a.attributed_revenue_minor) DESC",
        [context.tenantId, model, from, to]
      );

      const attributed = rows.rows.reduce(
        (sum, row) => sum + BigInt(row.attributed_revenue_minor),
        0n
      );

      return {
        model,
        totalRevenueMinor: total.rows[0]?.revenue ?? "0",
        attributedRevenueMinor: attributed.toString(),
        rows: rows.rows
      };
    });
  }

  private async recalculateConversion(
    client: PoolClient,
    tenantId: string,
    conversionId: string
  ): Promise<void> {
    const conversionResult = await client.query<{
      party_id: string | null;
      visitor_id: string | null;
      occurred_at: Date;
      revenue_minor: string;
    }>(
      "SELECT party_id,visitor_id,occurred_at,revenue_minor::text " +
      "FROM marketing_conversion WHERE tenant_id=$1 AND id=$2",
      [tenantId, conversionId]
    );

    const conversion = conversionResult.rows[0];
    if (!conversion) return;

    await client.query(
      "DELETE FROM marketing_attribution_result " +
      "WHERE tenant_id=$1 AND conversion_id=$2",
      [tenantId, conversionId]
    );

    const touches = await client.query<{
      id: string;
      is_direct: boolean;
    }>(
      "SELECT id,is_direct FROM marketing_touchpoint " +
      "WHERE tenant_id=$1 AND occurred_at <= $2 " +
      "AND occurred_at >= $2 - interval '90 days' " +
      "AND (($3::uuid IS NOT NULL AND party_id=$3) OR " +
      "($3::uuid IS NULL AND $4::uuid IS NOT NULL AND visitor_id=$4)) " +
      "ORDER BY occurred_at,id",
      [
        tenantId,
        conversion.occurred_at,
        conversion.party_id,
        conversion.visitor_id
      ]
    );

    if (!touches.rowCount) return;

    const all = touches.rows;
    const first = all[0]!;
    const last = all[all.length - 1]!;
    const nonDirect =
      [...all].reverse().find((item) => !item.is_direct) ?? last;
    const revenue = BigInt(conversion.revenue_minor);

    await this.insertAttribution(
      client, tenantId, conversionId, first.id, "FIRST_TOUCH", 1, revenue
    );
    await this.insertAttribution(
      client, tenantId, conversionId, last.id, "LAST_TOUCH", 1, revenue
    );
    await this.insertAttribution(
      client, tenantId, conversionId, nonDirect.id, "LAST_NON_DIRECT", 1, revenue
    );

    const count = BigInt(all.length);
    const base = revenue / count;
    let remainder = revenue - base * count;

    for (const touch of all) {
      let amount = base;

      if (remainder !== 0n) {
        const step = remainder > 0n ? 1n : -1n;
        amount += step;
        remainder -= step;
      }

      await this.insertAttribution(
        client,
        tenantId,
        conversionId,
        touch.id,
        "LINEAR",
        1 / all.length,
        amount
      );
    }
  }

  private async insertAttribution(
    client: PoolClient,
    tenantId: string,
    conversionId: string,
    touchpointId: string,
    model: AttributionModel,
    weight: number,
    amount: bigint
  ): Promise<void> {
    await client.query(
      "INSERT INTO marketing_attribution_result(" +
      "tenant_id,conversion_id,touchpoint_id,model,weight,attributed_revenue_minor" +
      ") VALUES ($1,$2,$3,$4,$5,$6) " +
      "ON CONFLICT (conversion_id,touchpoint_id,model) DO UPDATE SET " +
      "weight=EXCLUDED.weight,attributed_revenue_minor=EXCLUDED.attributed_revenue_minor," +
      "calculated_at=now()",
      [
        tenantId,
        conversionId,
        touchpointId,
        model,
        weight,
        amount.toString()
      ]
    );
  }

  private hmac(value: string): string {
    return createHmac("sha256", getEnv().sessionSecret)
      .update(value)
      .digest("hex");
  }
}
