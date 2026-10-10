import {
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type LeaseScope = "TENANT" | "MEMBERSHIP";

@Injectable()
export class RuntimePressureService {
  constructor(private readonly database: DatabaseService) {}

  async acquire(
    context: TenantContext,
    input: {
      operation: string;
      scope: LeaseScope;
      limit: number;
      ttlSeconds?: number;
      retryAfterSeconds?: number;
    }
  ): Promise<{ leaseKey: string }> {
    const operation = input.operation.trim().slice(0,120);
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    const ttlSeconds = Math.max(
      5,
      Math.min(3600, Math.floor(input.ttlSeconds ?? 60))
    );
    const retryAfterSeconds = Math.max(
      1,
      Math.min(
        86400,
        Math.floor(input.retryAfterSeconds ?? Math.min(ttlSeconds,60))
      )
    );

    const membershipId =
      input.scope === "MEMBERSHIP" ? context.membershipId : null;

    const result = await this.database.withTenantTransaction(
      context,
      async (client) => {
        const lockIdentity =
          context.tenantId +
          "|runtime-pressure|" +
          input.scope +
          "|" +
          (membershipId ?? "-") +
          "|" +
          operation;

        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [lockIdentity]
        );

        await client.query(
          `DELETE FROM tenant_runtime_lease
           WHERE tenant_id=$1 AND expires_at<=now()`,
          [context.tenantId]
        );

        const active = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM tenant_runtime_lease
           WHERE tenant_id=$1
             AND operation=$2
             AND scope=$3
             AND (
               ($3='TENANT' AND membership_id IS NULL)
               OR
               ($3='MEMBERSHIP' AND membership_id=$4)
             )
             AND expires_at>now()`,
          [
            context.tenantId,
            operation,
            input.scope,
            membershipId
          ]
        );

        const current = Number(active.rows[0]?.count ?? "0");
        if (current >= limit) {
          return {
            exceeded: true as const,
            current
          };
        }

        const leaseKey =
          "lease_" + randomBytes(18).toString("base64url");

        await client.query(
          `INSERT INTO tenant_runtime_lease(
             tenant_id,membership_id,operation,scope,
             lease_key,expires_at
           ) VALUES (
             $1,$2,$3,$4,$5,
             now()+($6::text || ' seconds')::interval
           )`,
          [
            context.tenantId,
            membershipId,
            operation,
            input.scope,
            leaseKey,
            String(ttlSeconds)
          ]
        );

        return {
          exceeded: false as const,
          current: current + 1,
          leaseKey
        };
      }
    );

    if (result.exceeded) {
      return this.deny(context, {
        operation,
        reason:
          input.scope === "TENANT"
            ? "tenant concurrent operation budget exceeded"
            : "member concurrent operation budget exceeded",
        currentValue: result.current,
        limitValue: limit,
        retryAfterSeconds
      });
    }

    return { leaseKey: result.leaseKey };
  }

  async release(
    context: TenantContext,
    leaseKey: string
  ): Promise<void> {
    if (!leaseKey?.trim()) return;

    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `DELETE FROM tenant_runtime_lease
         WHERE tenant_id=$1 AND lease_key=$2`,
        [context.tenantId,leaseKey]
      );
    });
  }

  async deny(
    context: TenantContext,
    input: {
      operation: string;
      reason: string;
      currentValue?: number;
      limitValue?: number;
      retryAfterSeconds?: number;
    }
  ): Promise<never> {
    const retryAfter = Math.max(
      1,
      Math.min(86400, Math.floor(input.retryAfterSeconds ?? 60))
    );

    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO tenant_runtime_pressure_event(
           tenant_id,membership_id,operation,reason,
           current_value,limit_value,retry_after_seconds
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          context.tenantId,
          context.membershipId,
          input.operation.slice(0,120),
          input.reason.slice(0,300),
          input.currentValue ?? null,
          input.limitValue ?? null,
          retryAfter
        ]
      );
    });

    throw new HttpException(
      {
        message:
          "Операция временно ограничена, чтобы сохранить стабильность системы.",
        code: "TENANT_RUNTIME_BUDGET_EXCEEDED",
        operation: input.operation,
        retryAfterSeconds: retryAfter
      },
      HttpStatus.TOO_MANY_REQUESTS
    );
  }

  async overview(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `DELETE FROM tenant_runtime_lease
         WHERE tenant_id=$1 AND expires_at<=now()`,
        [context.tenantId]
      );

      const [
        exports,
        channelSync,
        marketingSync,
        offlineConversions,
        workflowQueue,
        outbox,
        leases,
        recentEvents
      ] = await Promise.all([
        client.query<{ pending: string; running: string }>(
          `SELECT
             count(*) FILTER (WHERE status IN ('PENDING','FAILED'))::text AS pending,
             count(*) FILTER (WHERE status='PROCESSING')::text AS running
           FROM tenant_export_job
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{ pending: string; running: string }>(
          `SELECT
             count(*) FILTER (WHERE status IN ('PENDING','FAILED'))::text AS pending,
             count(*) FILTER (WHERE status='RUNNING')::text AS running
           FROM channel_sync_job
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{ pending: string; running: string }>(
          `SELECT
             count(*) FILTER (WHERE status IN ('PENDING','FAILED'))::text AS pending,
             count(*) FILTER (WHERE status='RUNNING')::text AS running
           FROM marketing_sync_job
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{ pending: string; uploaded: string }>(
          `SELECT
             count(*) FILTER (WHERE status IN ('PENDING','FAILED'))::text AS pending,
             count(*) FILTER (WHERE status='UPLOADED')::text AS uploaded
           FROM offline_conversion_job
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{ pending: string }>(
          `SELECT count(*)::text AS pending
           FROM workflow_execution
           WHERE tenant_id=$1
             AND status IN ('PENDING','RUNNING','RETRY')`,
          [context.tenantId]
        ).catch(() => ({ rows: [{ pending: "0" }] } as any)),
        client.query<{ pending: string }>(
          `SELECT count(*)::text AS pending
           FROM domain_event_outbox
           WHERE tenant_id=$1
             AND processed_at IS NULL`,
          [context.tenantId]
        ).catch(() => ({ rows: [{ pending: "0" }] } as any)),
        client.query(
          `SELECT
             operation,scope,count(*)::int AS active,
             min(expires_at) AS nearest_expiry
           FROM tenant_runtime_lease
           WHERE tenant_id=$1 AND expires_at>now()
           GROUP BY operation,scope
           ORDER BY active DESC,operation`,
          [context.tenantId]
        ),
        client.query(
          `SELECT
             id,operation,reason,current_value,limit_value,
             retry_after_seconds,created_at
           FROM tenant_runtime_pressure_event
           WHERE tenant_id=$1
             AND created_at >= now()-interval '24 hours'
           ORDER BY created_at DESC
           LIMIT 100`,
          [context.tenantId]
        )
      ]);

      const queue = {
        exports: {
          pending: Number(exports.rows[0]?.pending ?? "0"),
          running: Number(exports.rows[0]?.running ?? "0")
        },
        channelSync: {
          pending: Number(channelSync.rows[0]?.pending ?? "0"),
          running: Number(channelSync.rows[0]?.running ?? "0")
        },
        marketingSync: {
          pending: Number(marketingSync.rows[0]?.pending ?? "0"),
          running: Number(marketingSync.rows[0]?.running ?? "0")
        },
        offlineConversions: {
          pending: Number(offlineConversions.rows[0]?.pending ?? "0"),
          uploadedWaitingStatus: Number(
            offlineConversions.rows[0]?.uploaded ?? "0"
          )
        },
        workflow: {
          pending: Number(workflowQueue.rows[0]?.pending ?? "0")
        },
        outbox: {
          pending: Number(outbox.rows[0]?.pending ?? "0")
        }
      };

      const activeLeaseCount = leases.rows.reduce(
        (sum: number,row: any) => sum + Number(row.active ?? 0),
        0
      );

      const pressureScore =
        queue.exports.pending * 4 +
        queue.exports.running * 8 +
        queue.channelSync.pending * 2 +
        queue.channelSync.running * 5 +
        queue.marketingSync.pending * 2 +
        queue.marketingSync.running * 5 +
        Math.min(queue.offlineConversions.pending,100) +
        Math.min(queue.workflow.pending,100) +
        Math.min(queue.outbox.pending,100) +
        activeLeaseCount * 3;

      return {
        state:
          pressureScore >= 100
            ? "HIGH"
            : pressureScore >= 30
              ? "ELEVATED"
              : "NORMAL",
        pressureScore,
        queue,
        activeLeases: leases.rows,
        activeLeaseCount,
        deniedLast24h: recentEvents.rows.length,
        recentEvents: recentEvents.rows
      };
    });
  }
}
