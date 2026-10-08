import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type AttributionModel =
  | "FIRST_TOUCH"
  | "LAST_TOUCH"
  | "LAST_PAID_TOUCH";

type CampaignMetric = {
  id: string;
  name: string;
  externalCampaignId: string;
  spendMinor: bigint;
  impressions: bigint;
  clicks: bigint;
  conversions: number;
  customers: Set<string>;
  revenueMinor: bigint;
  collectedMinor: bigint;
  refundsMinor: bigint;
  cogsMinor: bigint;
};

@Injectable()
export class ProfitabilityService {
  constructor(private readonly database: DatabaseService) {}

  async addAlias(
    context: TenantContext,
    campaignId: string,
    input: {
      type?: "UTM_CAMPAIGN" | "MANUAL";
      value: string;
    }
  ): Promise<{ id: string }> {
    const value = input.value.trim();
    if (value.length < 1 || value.length > 500) {
      throw new BadRequestException("Некорректный alias кампании");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const campaign = await client.query(
        "SELECT 1 FROM marketing_campaign WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, campaignId]
      );
      if (!campaign.rowCount) {
        throw new NotFoundException("Кампания не найдена");
      }

      try {
        const result = await client.query<{ id: string }>(
          "INSERT INTO marketing_campaign_alias(" +
          "tenant_id,campaign_id,alias_type,alias_value,created_by_membership_id" +
          ") VALUES ($1,$2,$3,$4,$5) RETURNING id",
          [
            context.tenantId,
            campaignId,
            input.type ?? "UTM_CAMPAIGN",
            value,
            context.membershipId
          ]
        );
        return result.rows[0]!;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        ) {
          throw new ConflictException(
            "Этот alias уже привязан к другой кампании"
          );
        }
        throw error;
      }
    });
  }

  async dashboard(
    context: TenantContext,
    input: {
      model?: AttributionModel;
      from?: string;
      to?: string;
    }
  ): Promise<Record<string, unknown>> {
    const model = input.model ?? "LAST_PAID_TOUCH";
    if (!["FIRST_TOUCH","LAST_TOUCH","LAST_PAID_TOUCH"].includes(model)) {
      throw new BadRequestException("Неизвестная модель атрибуции");
    }

    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from
      ? new Date(input.from)
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
      const campaignRows = await client.query<{
        id: string;
        name: string;
        external_campaign_id: string;
        spend_minor: string;
        impressions: string;
        clicks: string;
      }>(
        "SELECT c.id,c.name,c.external_campaign_id," +
        "COALESCE(sum(s.spend_minor),0)::text AS spend_minor," +
        "COALESCE(sum(s.impressions),0)::text AS impressions," +
        "COALESCE(sum(s.clicks),0)::text AS clicks " +
        "FROM marketing_campaign c LEFT JOIN marketing_daily_stat s " +
        "ON s.tenant_id=c.tenant_id AND s.campaign_id=c.id " +
        "AND s.stat_date >= $2::date AND s.stat_date <= $3::date " +
        "WHERE c.tenant_id=$1 GROUP BY c.id ORDER BY c.name",
        [context.tenantId, from, to]
      );

      const metrics = new Map<string, CampaignMetric>();
      const aliasMap = new Map<string, string>();

      for (const row of campaignRows.rows) {
        metrics.set(row.id, {
          id: row.id,
          name: row.name,
          externalCampaignId: row.external_campaign_id,
          spendMinor: BigInt(row.spend_minor),
          impressions: BigInt(row.impressions),
          clicks: BigInt(row.clicks),
          conversions: 0,
          customers: new Set<string>(),
          revenueMinor: 0n,
          collectedMinor: 0n,
          refundsMinor: 0n,
          cogsMinor: 0n
        });

        aliasMap.set(this.normalizeAlias(row.external_campaign_id), row.id);
        aliasMap.set(this.normalizeAlias(row.name), row.id);
      }

      const aliases = await client.query<{
        campaign_id: string;
        alias_value: string;
      }>(
        "SELECT campaign_id,alias_value FROM marketing_campaign_alias " +
        "WHERE tenant_id=$1",
        [context.tenantId]
      );

      for (const row of aliases.rows) {
        aliasMap.set(this.normalizeAlias(row.alias_value), row.campaign_id);
      }

      const attribution = await client.query<{
        conversion_type: "SALES_ORDER" | "SERVICE_BOOKING";
        conversion_id: string;
        party_id: string;
        campaign: string | null;
      }>(
        "SELECT conversion_type,conversion_id,party_id,campaign " +
        "FROM attribution_result WHERE tenant_id=$1 AND model=$2 " +
        "AND conversion_at >= $3 AND conversion_at < $4",
        [context.tenantId, model, from, to]
      );

      const orderCampaign = new Map<string, string>();
      const bookingCampaign = new Map<string, string>();
      let unmappedConversions = 0;

      for (const row of attribution.rows) {
        const campaignId = row.campaign
          ? aliasMap.get(this.normalizeAlias(row.campaign))
          : undefined;

        if (!campaignId || !metrics.has(campaignId)) {
          unmappedConversions += 1;
          continue;
        }

        if (row.conversion_type === "SALES_ORDER") {
          orderCampaign.set(row.conversion_id, campaignId);
        } else {
          bookingCampaign.set(row.conversion_id, campaignId);
        }

        const metric = metrics.get(campaignId)!;
        metric.conversions += 1;
        metric.customers.add(row.party_id);
      }

      const orderIds = Array.from(orderCampaign.keys());
      if (orderIds.length) {
        const orders = await client.query<{
          id: string;
          party_id: string | null;
          total_minor: string;
          cogs_minor: string;
        }>(
          "SELECT o.id,o.party_id,o.total_minor::text," +
          "COALESCE(sum((l.cost_price_minor_snapshot*l.quantity_milli+500)/1000),0)::text AS cogs_minor " +
          "FROM sales_order o LEFT JOIN sales_order_line l " +
          "ON l.tenant_id=o.tenant_id AND l.order_id=o.id " +
          "WHERE o.tenant_id=$1 AND o.id=ANY($2::uuid[]) " +
          "GROUP BY o.id",
          [context.tenantId, orderIds]
        );

        const payments = await client.query<{
          source_id: string;
          collected_minor: string;
          refunds_minor: string;
        }>(
          "SELECT source_id," +
          "COALESCE(sum(CASE WHEN status='POSTED' AND direction='IN' AND kind='PAYMENT' THEN amount_minor ELSE 0 END),0)::text AS collected_minor," +
          "COALESCE(sum(CASE WHEN status='POSTED' AND direction='OUT' AND kind='REFUND' THEN amount_minor ELSE 0 END),0)::text AS refunds_minor " +
          "FROM payment WHERE tenant_id=$1 AND source_type='SALES_ORDER' " +
          "AND source_id=ANY($2::uuid[]) GROUP BY source_id",
          [context.tenantId, orderIds]
        );

        const paymentMap = new Map(
          payments.rows.map((row) => [row.source_id, row])
        );

        for (const order of orders.rows) {
          const campaignId = orderCampaign.get(order.id);
          if (!campaignId) continue;
          const metric = metrics.get(campaignId)!;
          const payment = paymentMap.get(order.id);

          metric.revenueMinor += BigInt(order.total_minor);
          metric.cogsMinor += BigInt(order.cogs_minor);
          metric.collectedMinor += BigInt(payment?.collected_minor ?? "0");
          metric.refundsMinor += BigInt(payment?.refunds_minor ?? "0");
        }
      }

      const bookingIds = Array.from(bookingCampaign.keys());
      if (bookingIds.length) {
        const bookings = await client.query<{
          id: string;
          party_id: string | null;
          price_minor_snapshot: string;
          resource_cost_minor: string;
          material_cost_minor: string;
        }>(
          "SELECT b.id,b.party_id,b.price_minor_snapshot::text," +
          "COALESCE((SELECT sum((br.cost_per_hour_minor_snapshot*b.duration_minutes_snapshot+30)/60) " +
          "FROM service_booking_resource br WHERE br.tenant_id=b.tenant_id AND br.booking_id=b.id),0)::text AS resource_cost_minor," +
          "COALESCE((SELECT sum((m.unit_cost_minor_snapshot*m.consumed_quantity_milli+500)/1000) " +
          "FROM service_booking_material m WHERE m.tenant_id=b.tenant_id AND m.booking_id=b.id),0)::text AS material_cost_minor " +
          "FROM service_booking b WHERE b.tenant_id=$1 AND b.id=ANY($2::uuid[]) " +
          "AND b.status='COMPLETED'",
          [context.tenantId, bookingIds]
        );

        for (const booking of bookings.rows) {
          const campaignId = bookingCampaign.get(booking.id);
          if (!campaignId) continue;
          const metric = metrics.get(campaignId)!;
          metric.revenueMinor += BigInt(booking.price_minor_snapshot);
          metric.cogsMinor +=
            BigInt(booking.resource_cost_minor) +
            BigInt(booking.material_cost_minor);
        }
      }

      const campaigns = Array.from(metrics.values()).map((metric) =>
        this.serializeMetric(metric)
      );

      const totals = campaigns.reduce(
        (sum, row: any) => ({
          spendMinor: sum.spendMinor + BigInt(row.spendMinor),
          revenueMinor: sum.revenueMinor + BigInt(row.revenueMinor),
          collectedMinor: sum.collectedMinor + BigInt(row.collectedMinor),
          refundsMinor: sum.refundsMinor + BigInt(row.refundsMinor),
          cogsMinor: sum.cogsMinor + BigInt(row.cogsMinor),
          grossProfitMinor:
            sum.grossProfitMinor + BigInt(row.grossProfitMinor),
          contributionProfitMinor:
            sum.contributionProfitMinor +
            BigInt(row.contributionProfitMinor),
          conversions: sum.conversions + row.conversions
        }),
        {
          spendMinor: 0n,
          revenueMinor: 0n,
          collectedMinor: 0n,
          refundsMinor: 0n,
          cogsMinor: 0n,
          grossProfitMinor: 0n,
          contributionProfitMinor: 0n,
          conversions: 0
        }
      );

      const freshness = await client.query<{
        last_synced_at: Date | null;
      }>(
        "SELECT max(last_synced_at) AS last_synced_at " +
        "FROM marketing_connection WHERE tenant_id=$1 AND status<>'DISABLED'",
        [context.tenantId]
      );

      const mappedConversions =
        attribution.rows.length - unmappedConversions;

      return {
        model,
        period: {
          from: from.toISOString(),
          to: to.toISOString()
        },
        totals: {
          spendMinor: totals.spendMinor.toString(),
          revenueMinor: totals.revenueMinor.toString(),
          collectedMinor: totals.collectedMinor.toString(),
          refundsMinor: totals.refundsMinor.toString(),
          cogsMinor: totals.cogsMinor.toString(),
          grossProfitMinor: totals.grossProfitMinor.toString(),
          contributionProfitMinor:
            totals.contributionProfitMinor.toString(),
          conversions: totals.conversions,
          roas: this.ratio(
            totals.revenueMinor - totals.refundsMinor,
            totals.spendMinor
          ),
          romiPercent: this.percent(
            totals.contributionProfitMinor,
            totals.spendMinor
          )
        },
        campaigns: campaigns.sort(
          (a: any, b: any) =>
            Number(b.spendMinor) - Number(a.spendMinor)
        ),
        dataQuality: {
          attributionRows: attribution.rows.length,
          mappedConversions,
          unmappedConversions,
          mappedPercent:
            attribution.rows.length === 0
              ? 100
              : Math.round(
                  (mappedConversions / attribution.rows.length) * 10000
                ) / 100
        },
        freshness: {
          marketingLastSyncedAt:
            freshness.rows[0]?.last_synced_at?.toISOString() ?? null
        }
      };
    });
  }

  async createAlertRule(
    context: TenantContext,
    input: {
      name: string;
      type:
        | "SPEND_WITHOUT_ORDERS"
        | "CPO_ABOVE"
        | "ROMI_BELOW"
        | "CONTRIBUTION_PROFIT_BELOW";
      thresholdMinor?: string;
      thresholdRatio?: number;
      lookbackDays?: number;
      attributionModel?: AttributionModel;
    }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название правила");
    }

    const lookback = Math.floor(input.lookbackDays ?? 7);
    if (lookback < 1 || lookback > 90) {
      throw new BadRequestException("lookback должен быть от 1 до 90 дней");
    }

    if (
      input.thresholdMinor !== undefined &&
      !/^-?\d+$/.test(input.thresholdMinor)
    ) {
      throw new BadRequestException("Некорректный денежный порог");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO marketing_alert_rule(" +
        "tenant_id,name,type,threshold_minor,threshold_ratio,lookback_days," +
        "attribution_model,created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [
          context.tenantId,
          name,
          input.type,
          input.thresholdMinor ?? null,
          input.thresholdRatio ?? null,
          lookback,
          input.attributionModel ?? "LAST_PAID_TOUCH",
          context.membershipId
        ]
      );
      return result.rows[0]!;
    });
  }

  async evaluateAlerts(
    context: TenantContext
  ): Promise<{ evaluated: number; opened: number }> {
    const rules = await this.database.withTenantTransaction(
      context,
      async (client) =>
        (
          await client.query<{
            id: string;
            type: string;
            threshold_minor: string | null;
            threshold_ratio: string | null;
            lookback_days: number;
            attribution_model: AttributionModel;
          }>(
            "SELECT id,type,threshold_minor::text,threshold_ratio::text," +
            "lookback_days,attribution_model FROM marketing_alert_rule " +
            "WHERE tenant_id=$1 AND enabled=true",
            [context.tenantId]
          )
        ).rows
    );

    let opened = 0;

    for (const rule of rules) {
      const to = new Date();
      const from = new Date(
        to.getTime() - rule.lookback_days * 86400000
      );

      const dashboard: any = await this.dashboard(context, {
        model: rule.attribution_model,
        from: from.toISOString(),
        to: to.toISOString()
      });

      await this.database.withTenantTransaction(context, async (client) => {
        for (const campaign of dashboard.campaigns as any[]) {
          const violates = this.ruleViolated(rule, campaign);
          const fromDate = from.toISOString().slice(0, 10);
          const toDate = to.toISOString().slice(0, 10);

          if (violates) {
            await client.query(
              "INSERT INTO marketing_alert_event(" +
              "tenant_id,rule_id,campaign_id,window_from,window_to,severity,status,payload" +
              ") VALUES ($1,$2,$3,$4,$5,'WARNING','OPEN',$6) " +
              "ON CONFLICT (rule_id,campaign_id,window_from,window_to) DO UPDATE SET " +
              "status='OPEN',payload=EXCLUDED.payload,closed_at=NULL",
              [
                context.tenantId,
                rule.id,
                campaign.id,
                fromDate,
                toDate,
                JSON.stringify(campaign)
              ]
            );
            opened += 1;
          } else {
            await client.query(
              "UPDATE marketing_alert_event SET status='CLOSED',closed_at=now() " +
              "WHERE tenant_id=$1 AND rule_id=$2 AND campaign_id=$3 " +
              "AND status='OPEN'",
              [context.tenantId, rule.id, campaign.id]
            );
          }
        }
      });
    }

    return { evaluated: rules.length, opened };
  }

  async alerts(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT e.id,e.severity,e.status,e.window_from,e.window_to,e.payload," +
        "e.created_at,r.name AS rule_name,r.type,c.name AS campaign_name " +
        "FROM marketing_alert_event e " +
        "JOIN marketing_alert_rule r ON r.tenant_id=e.tenant_id AND r.id=e.rule_id " +
        "LEFT JOIN marketing_campaign c ON c.tenant_id=e.tenant_id AND c.id=e.campaign_id " +
        "WHERE e.tenant_id=$1 ORDER BY " +
        "CASE e.status WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END," +
        "e.created_at DESC LIMIT 200",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  private serializeMetric(metric: CampaignMetric): Record<string, unknown> {
    const netRevenue = metric.revenueMinor - metric.refundsMinor;
    const grossProfit = netRevenue - metric.cogsMinor;
    const contribution = grossProfit - metric.spendMinor;
    const customers = metric.customers.size;

    return {
      id: metric.id,
      name: metric.name,
      externalCampaignId: metric.externalCampaignId,
      spendMinor: metric.spendMinor.toString(),
      impressions: metric.impressions.toString(),
      clicks: metric.clicks.toString(),
      conversions: metric.conversions,
      customers,
      revenueMinor: metric.revenueMinor.toString(),
      collectedMinor: metric.collectedMinor.toString(),
      refundsMinor: metric.refundsMinor.toString(),
      netRevenueMinor: netRevenue.toString(),
      cogsMinor: metric.cogsMinor.toString(),
      grossProfitMinor: grossProfit.toString(),
      contributionProfitMinor: contribution.toString(),
      cpcMinor:
        metric.clicks > 0n
          ? (metric.spendMinor / metric.clicks).toString()
          : null,
      cpoMinor:
        metric.conversions > 0
          ? (
              metric.spendMinor /
              BigInt(metric.conversions)
            ).toString()
          : null,
      cacMinor:
        customers > 0
          ? (
              metric.spendMinor /
              BigInt(customers)
            ).toString()
          : null,
      roas: this.ratio(netRevenue, metric.spendMinor),
      romiPercent: this.percent(
        contribution,
        metric.spendMinor
      )
    };
  }

  private ruleViolated(
    rule: {
      type: string;
      threshold_minor: string | null;
      threshold_ratio: string | null;
    },
    campaign: any
  ): boolean {
    if (rule.type === "SPEND_WITHOUT_ORDERS") {
      return (
        campaign.conversions === 0 &&
        BigInt(campaign.spendMinor) >=
          BigInt(rule.threshold_minor ?? "0")
      );
    }

    if (rule.type === "CPO_ABOVE") {
      if (campaign.cpoMinor === null) return false;
      return (
        BigInt(campaign.cpoMinor) >
        BigInt(rule.threshold_minor ?? "0")
      );
    }

    if (rule.type === "ROMI_BELOW") {
      if (campaign.romiPercent === null) return false;
      return (
        Number(campaign.romiPercent) <
        Number(rule.threshold_ratio ?? "0")
      );
    }

    return (
      BigInt(campaign.contributionProfitMinor) <
      BigInt(rule.threshold_minor ?? "0")
    );
  }

  private normalizeAlias(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private ratio(
    numerator: bigint,
    denominator: bigint
  ): number | null {
    if (denominator === 0n) return null;
    return (
      Math.round(
        (Number(numerator) / Number(denominator)) * 10000
      ) / 10000
    );
  }

  private percent(
    numerator: bigint,
    denominator: bigint
  ): number | null {
    if (denominator === 0n) return null;
    return (
      Math.round(
        (Number(numerator) / Number(denominator)) * 100 * 100
      ) / 100
    );
  }
}
