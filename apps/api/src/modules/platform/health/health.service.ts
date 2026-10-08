import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { RedisService } from "../../../infrastructure/cache/redis.service";

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

    const redisStarted = performance.now();
    let redisOk = false;
    try {
      redisOk = (await this.redis.ping()) === "PONG";
    } catch {
      redisOk = false;
    }
    const redisLatency = Math.round(performance.now() - redisStarted);

    return {
      status: postgresOk && redisOk ? "ok" : "degraded",
      postgres: { ok: postgresOk, latencyMs: postgresLatency },
      redis: { ok: redisOk, latencyMs: redisLatency }
    };
  }

  async diagnostics(): Promise<{
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
    const outbox = await this.database.query<{
      pending: string;
      failed: string;
      oldest_pending_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
         count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
         min(created_at) FILTER (WHERE status = 'PENDING') AS oldest_pending_at
       FROM domain_event_outbox`
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
