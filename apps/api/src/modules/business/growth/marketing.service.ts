import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { IntegrationCryptoService } from "./integration-crypto.service";

@Injectable()
export class MarketingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: IntegrationCryptoService
  ) {}

  async connections(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           id, provider, name, external_account_id, client_login,
           status, last_synced_at, last_error, sync_cursor,
           created_at, updated_at
         FROM marketing_connection
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [context.tenantId]
      );

      return result.rows;
    });
  }

  async createYandex(
    context: TenantContext,
    input: {
      name: string;
      oauthToken: string;
      clientLogin?: string;
      externalAccountId?: string;
    }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    const token = input.oauthToken.trim();

    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название подключения");
    }
    if (token.length < 16 || token.length > 4096) {
      throw new BadRequestException("Некорректный OAuth-токен");
    }

    const encrypted = this.crypto.encrypt({
      oauthToken: token
    });

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO marketing_connection(
           tenant_id, provider, name, external_account_id,
           client_login, credentials_ciphertext,
           created_by_membership_id
         ) VALUES ($1,'YANDEX_DIRECT',$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          name,
          input.externalAccountId?.trim() || null,
          input.clientLogin?.trim() || null,
          encrypted,
          context.membershipId
        ]
      );

      const row = result.rows[0];
      if (!row) throw new Error("MARKETING_CONNECTION_CREATE_FAILED");

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id, after_data
         ) VALUES (
           $1,$2,$3,'analytics.connection_created',
           'marketing_connection',$4,$5
         )`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          row.id,
          JSON.stringify({
            provider: "YANDEX_DIRECT",
            name,
            clientLogin: input.clientLogin?.trim() || null
          })
        ]
      );

      return row;
    });
  }

  async requestSync(
    context: TenantContext,
    connectionId: string,
    input: {
      from: string;
      to: string;
    }
  ): Promise<{ jobId: string; status: string }> {
    const from = this.dateOnly(input.from);
    const to = this.dateOnly(input.to);

    const fromDate = new Date(from + "T00:00:00Z");
    const toDate = new Date(to + "T00:00:00Z");

    if (toDate < fromDate) {
      throw new BadRequestException("Дата окончания раньше даты начала");
    }

    if (toDate.getTime() - fromDate.getTime() > 92 * 86400000) {
      throw new BadRequestException("Один sync-job ограничен 93 днями");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const connection = await client.query<{
        provider: string;
        status: string;
      }>(
        `SELECT provider, status
         FROM marketing_connection
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, connectionId]
      );

      const row = connection.rows[0];
      if (!row) throw new NotFoundException("Подключение не найдено");
      if (row.status === "DISABLED") {
        throw new BadRequestException("Подключение отключено");
      }

      const reportName =
        "corebiz-" +
        connectionId.slice(0, 8) +
        "-" +
        from +
        "-" +
        to +
        "-" +
        randomBytes(4).toString("hex");

      const job = await client.query<{ id: string; status: string }>(
        `INSERT INTO marketing_sync_job(
           tenant_id, connection_id, provider,
           period_from, period_to, report_name
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, status`,
        [
          context.tenantId,
          connectionId,
          row.provider,
          from,
          to,
          reportName
        ]
      );

      return {
        jobId: job.rows[0]!.id,
        status: job.rows[0]!.status
      };
    });
  }

  async jobs(
    context: TenantContext,
    connectionId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           id, connection_id, provider,
           period_from, period_to, status, attempts,
           retry_at, provider_request_id, last_error,
           started_at, finished_at, created_at
         FROM marketing_sync_job
         WHERE tenant_id = $1
           AND ($2::uuid IS NULL OR connection_id = $2)
         ORDER BY created_at DESC
         LIMIT 200`,
        [context.tenantId, connectionId ?? null]
      );

      return result.rows;
    });
  }

  async stats(
    context: TenantContext,
    input: {
      from?: string;
      to?: string;
    }
  ): Promise<{
    totals: {
      spendMinor: string;
      impressions: string;
      clicks: string;
      conversions: string;
    };
    campaigns: Array<Record<string, unknown>>;
    daily: Array<Record<string, unknown>>;
  }> {
    const to = input.to
      ? this.dateOnly(input.to)
      : new Date().toISOString().slice(0, 10);
    const from = input.from
      ? this.dateOnly(input.from)
      : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    return this.database.withTenantTransaction(context, async (client) => {
      const totals = await client.query<{
        spend_minor: string;
        impressions: string;
        clicks: string;
        conversions: string;
      }>(
        `SELECT
           COALESCE(sum(spend_minor),0)::text AS spend_minor,
           COALESCE(sum(impressions),0)::text AS impressions,
           COALESCE(sum(clicks),0)::text AS clicks,
           COALESCE(sum(conversions),0)::text AS conversions
         FROM marketing_daily_stat
         WHERE tenant_id = $1
           AND stat_date BETWEEN $2 AND $3`,
        [context.tenantId, from, to]
      );

      const campaigns = await client.query(
        `SELECT
           c.id, c.external_campaign_id, c.name, c.status, c.currency,
           COALESCE(sum(s.spend_minor),0)::text AS spend_minor,
           COALESCE(sum(s.impressions),0)::text AS impressions,
           COALESCE(sum(s.clicks),0)::text AS clicks,
           COALESCE(sum(s.conversions),0)::text AS conversions
         FROM marketing_campaign c
         LEFT JOIN marketing_daily_stat s
           ON s.tenant_id = c.tenant_id
          AND s.campaign_id = c.id
          AND s.stat_date BETWEEN $2 AND $3
         WHERE c.tenant_id = $1
         GROUP BY c.id
         ORDER BY spend_minor::bigint DESC, c.name`,
        [context.tenantId, from, to]
      );

      const daily = await client.query(
        `SELECT
           stat_date,
           sum(spend_minor)::text AS spend_minor,
           sum(impressions)::text AS impressions,
           sum(clicks)::text AS clicks,
           sum(conversions)::text AS conversions
         FROM marketing_daily_stat
         WHERE tenant_id = $1
           AND stat_date BETWEEN $2 AND $3
         GROUP BY stat_date
         ORDER BY stat_date`,
        [context.tenantId, from, to]
      );

      return {
        totals: {
          spendMinor: totals.rows[0]?.spend_minor ?? "0",
          impressions: totals.rows[0]?.impressions ?? "0",
          clicks: totals.rows[0]?.clicks ?? "0",
          conversions: totals.rows[0]?.conversions ?? "0"
        },
        campaigns: campaigns.rows,
        daily: daily.rows
      };
    });
  }

  private dateOnly(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException("Дата должна быть YYYY-MM-DD");
    }
    const date = new Date(value + "T00:00:00Z");
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException("Некорректная дата");
    }
    return value;
  }
}
