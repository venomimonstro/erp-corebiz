import { Injectable } from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { RedisService } from "../../../infrastructure/cache/redis.service";
import { getEnv } from "../../../infrastructure/config/env";

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService
  ) {}

  async readiness(): Promise<{
    status: "ok" | "degraded";
    postgres: { ok: boolean; latencyMs: number };
    redis: { ok: boolean; latencyMs: number };
    isolation: { ok: boolean; checked: boolean };
  }> {
    const postgresStarted = performance.now();
    let postgresOk = false;
    try {
      await this.database.query("SELECT 1");
      postgresOk = true;
    } catch {
      postgresOk = false;
    }
    const postgresLatency = Math.round(performance.now() - postgresStarted);

    // Liveness is not enough for a multi-tenant SaaS. A superuser,
    // BYPASSRLS role, or an owner of unforced tenant tables can read
    // other tenants' rows regardless of application WHERE clauses.
    let isolationOk = false;
    const isolationChecked = postgresOk && getEnv().nodeEnv === "production";
    if (postgresOk && !isolationChecked) isolationOk = true;
    if (isolationChecked) {
      try {
        const security = await this.database.query<{ safe: boolean }>(
          `SELECT
             (
               SELECT NOT r.rolsuper AND NOT r.rolbypassrls
               FROM pg_roles r WHERE r.rolname=current_user
             )
             AND NOT EXISTS (
               SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid=c.relnamespace
               JOIN pg_attribute a ON a.attrelid=c.oid
                 AND a.attname='tenant_id'
                 AND NOT a.attisdropped
               WHERE n.nspname='public'
                 AND c.relkind IN ('r','p')
                 AND (
                   NOT c.relrowsecurity
                   OR (
                     c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
                     AND NOT c.relforcerowsecurity
                   )
                   OR NOT EXISTS (
                     SELECT 1 FROM pg_policies p
                     WHERE p.schemaname=n.nspname AND p.tablename=c.relname
                   )
                 )
             )
             AND (
               SELECT bool_and(has_function_privilege(current_user, function_name, 'EXECUTE'))
               FROM (VALUES
                 ('public.corebiz_auth_login_identity(text)'),
                 ('public.corebiz_auth_resolve_session(text)'),
                 ('public.corebiz_auth_memberships(uuid)'),
                 ('public.corebiz_auth_switch_tenant(uuid,uuid,uuid)'),
                 ('public.corebiz_auth_accept_invitation(uuid,text)'),
                 ('public.corebiz_auth_login_identity_v2(text)'),
                 ('public.corebiz_auth_resolve_session_v2(text)'),
                 ('public.corebiz_auth_mfa_state(uuid,uuid,uuid)'),
                 ('public.corebiz_auth_mfa_secret(uuid)'),
                 ('public.corebiz_auth_mfa_begin(uuid,text)'),
                 ('public.corebiz_auth_mfa_enable(uuid,uuid,uuid,uuid,text[])'),
                 ('public.corebiz_auth_mfa_consume_recovery(uuid,text)'),
                 ('public.corebiz_auth_mfa_mark_session_verified(uuid,uuid)'),
                 ('public.corebiz_auth_mfa_replace_recovery(uuid,uuid,uuid,uuid,text[])'),
                 ('public.corebiz_auth_mfa_disable(uuid,uuid,uuid,uuid)')
               ) AS auth_functions(function_name)
             ) AS safe`
        );
        isolationOk = security.rows[0]?.safe === true;
      } catch {
        isolationOk = false;
      }
    }

    const redisStarted = performance.now();
    let redisOk = false;
    try {
      redisOk = (await this.redis.ping()) === "PONG";
    } catch {
      redisOk = false;
    }
    const redisLatency = Math.round(performance.now() - redisStarted);

    return {
      status: postgresOk && redisOk && isolationOk ? "ok" : "degraded",
      postgres: { ok: postgresOk, latencyMs: postgresLatency },
      redis: { ok: redisOk, latencyMs: redisLatency },
      isolation: { ok: isolationOk, checked: isolationChecked }
    };
  }

  async diagnostics(context:TenantContext): Promise<{
    outbox: {
      pending: number;
      failed: number;
      oldestPendingAt: string | null;
    };
    database: {
      activeConnections: number;
      idleConnections: number;
    };
  }> {
    // Outbox has tenant RLS. Owner diagnostics must observe only their own
    // company's backlog, not return an empty result with no tenant context.
    const outbox = await this.database.withTenantTransaction(context,client=>
      client.query<{
        pending: string;
        failed: string;
        oldest_pending_at: Date | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
           count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
           min(created_at) FILTER (WHERE status = 'PENDING') AS oldest_pending_at
         FROM domain_event_outbox
         WHERE tenant_id=$1`,
        [context.tenantId]
      )
    );

    const db = await this.database.query<{
      state: string;
      count: string;
    }>(
      `SELECT state, count(*)::text AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
       GROUP BY state`
    );

    const byState = new Map(db.rows.map((row) => [row.state, Number(row.count)]));

    return {
      outbox: {
        pending: Number(outbox.rows[0]?.pending ?? "0"),
        failed: Number(outbox.rows[0]?.failed ?? "0"),
        oldestPendingAt:
          outbox.rows[0]?.oldest_pending_at?.toISOString() ?? null
      },
      database: {
        activeConnections: byState.get("active") ?? 0,
        idleConnections: byState.get("idle") ?? 0
      }
    };
  }
}
