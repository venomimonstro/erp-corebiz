import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

const SENSITIVE_KEY =
  /(password|secret|token|credential|authorization|cookie|session_hash|api[_-]?key|private[_-]?key|ciphertext)$/i;

@Injectable()
export class SecurityCenterService {
  constructor(private readonly database: DatabaseService) {}

  async audit(
    context: TenantContext,
    input: {
      action?: string;
      resourceType?: string;
      resourceId?: string;
      actorMembershipId?: string;
      from?: string;
      to?: string;
      limit?: number;
    }
  ): Promise<Array<Record<string, unknown>>> {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
    const from = input.from ? new Date(input.from) : null;
    const to = input.to ? new Date(input.to) : null;

    if (from && Number.isNaN(from.getTime())) {
      throw new BadRequestException("Некорректная дата from");
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new BadRequestException("Некорректная дата to");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        actor_user_id: string | null;
        actor_membership_id: string | null;
        action: string;
        resource_type: string;
        resource_id: string | null;
        before_data: Record<string, unknown> | null;
        after_data: Record<string, unknown> | null;
        reason: string | null;
        trace_id: string | null;
        created_at: Date;
        email: string | null;
      }>(
        `SELECT
           a.id,a.actor_user_id,a.actor_membership_id,
           a.action,a.resource_type,a.resource_id,
           a.before_data,a.after_data,a.reason,a.trace_id,a.created_at,
           u.email
         FROM audit_event a
         LEFT JOIN app_user u ON u.id=a.actor_user_id
         WHERE a.tenant_id=$1
           AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
           AND ($3::text IS NULL OR a.resource_type=$3)
           AND ($4::text IS NULL OR a.resource_id=$4)
           AND ($5::uuid IS NULL OR a.actor_membership_id=$5)
           AND ($6::timestamptz IS NULL OR a.created_at >= $6)
           AND ($7::timestamptz IS NULL OR a.created_at < $7)
         ORDER BY a.created_at DESC
         LIMIT $8`,
        [
          context.tenantId,
          input.action?.trim() || null,
          input.resourceType?.trim() || null,
          input.resourceId?.trim() || null,
          input.actorMembershipId || null,
          from,
          to,
          limit
        ]
      );

      return result.rows.map((row) => ({
        ...row,
        before_data: this.redact(row.before_data),
        after_data: this.redact(row.after_data)
      }));
    });
  }

  async sessions(
    context: TenantContext,
    currentSessionId: string
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query<{
      id: string;
      active_membership_id: string | null;
      expires_at: Date;
      revoked_at: Date | null;
      last_seen_at: Date | null;
      user_agent: string | null;
      created_at: Date;
    }>(
      `SELECT
         id,active_membership_id,expires_at,revoked_at,last_seen_at,
         user_agent,created_at
       FROM user_session
       WHERE user_id=$1
       ORDER BY
         CASE WHEN revoked_at IS NULL AND expires_at > now() THEN 0 ELSE 1 END,
         COALESCE(last_seen_at,created_at) DESC
       LIMIT 100`,
      [context.userId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      current: row.id === currentSessionId,
      active: row.revoked_at === null && row.expires_at > new Date(),
      membershipId: row.active_membership_id,
      expiresAt: row.expires_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      userAgent: row.user_agent
    }));
  }

  async revokeSession(
    context: TenantContext,
    currentSessionId: string,
    sessionId: string
  ): Promise<{ revoked: true; currentSession: boolean }> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE user_session
       SET revoked_at=COALESCE(revoked_at,now())
       WHERE id=$1
         AND user_id=$2
       RETURNING id`,
      [sessionId, context.userId]
    );

    if (!result.rowCount) {
      throw new NotFoundException("Сессия не найдена");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO audit_event(
           tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data
         ) VALUES ($1,$2,$3,'security.session_revoked','session',$4,$5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          sessionId,
          JSON.stringify({
            currentSession: sessionId === currentSessionId
          })
        ]
      );
    });

    return {
      revoked: true,
      currentSession: sessionId === currentSessionId
    };
  }

  async revokeOthers(
    context: TenantContext,
    currentSessionId: string
  ): Promise<{ revoked: number }> {
    const result = await this.database.query(
      `UPDATE user_session
       SET revoked_at=now()
       WHERE user_id=$1
         AND id<>$2
         AND revoked_at IS NULL
         AND expires_at>now()`,
      [context.userId, currentSessionId]
    );

    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO audit_event(
           tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data
         ) VALUES ($1,$2,$3,'security.sessions_revoked_others','user',$2,$4)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          JSON.stringify({ revoked: result.rowCount ?? 0 })
        ]
      );
    });

    return { revoked: result.rowCount ?? 0 };
  }

  private redact(
    value: unknown
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }

    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>
      )) {
        output[key] = SENSITIVE_KEY.test(key)
          ? "[REDACTED]"
          : this.redact(child);
      }
      return output;
    }

    if (typeof value === "string" && value.length > 10000) {
      return value.slice(0, 10000) + "…";
    }

    return value;
  }
}
