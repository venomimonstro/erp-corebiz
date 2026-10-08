import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { getEnv } from "../../../infrastructure/config/env";
import { IntegrationCryptoService } from "./integration-crypto.service";

@Injectable()
export class ConversionBridgeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: IntegrationCryptoService
  ) {}

  async callConnections(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT id,tracker_site_id,provider,name,status,last_received_at,last_error," +
        "created_at,updated_at FROM calltracking_connection " +
        "WHERE tenant_id=$1 ORDER BY created_at DESC",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createCallConnection(
    context: TenantContext,
    input: {
      provider: "CALLTOUCH" | "ROISTAT" | "MANGO" | "OTHER";
      name: string;
      trackerSiteId?: string;
      credentials?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    webhookSecret: string;
  }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название подключения");
    }

    const secret = randomBytes(32).toString("base64url");
    const secretHash = createHash("sha256").update(secret).digest("hex");
    const encrypted =
      input.credentials && Object.keys(input.credentials).length
        ? this.crypto.encrypt(input.credentials)
        : null;

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.trackerSiteId) {
        const site = await client.query(
          "SELECT 1 FROM tracker_site WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
          [context.tenantId, input.trackerSiteId]
        );
        if (!site.rowCount) throw new NotFoundException("Tracker-site не найден");
      }

      const result = await client.query<{ id: string }>(
        "INSERT INTO calltracking_connection(" +
        "tenant_id,tracker_site_id,provider,name,webhook_secret_hash," +
        "credentials_ciphertext,created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          context.tenantId,
          input.trackerSiteId ?? null,
          input.provider,
          name,
          secretHash,
          encrypted,
          context.membershipId
        ]
      );

      const row = result.rows[0];
      if (!row) throw new Error("CALLTRACKING_CONNECTION_CREATE_FAILED");

      await this.audit(
        client,
        context,
        "growth.calltracking_created",
        "calltracking_connection",
        row.id,
        { provider: input.provider, name }
      );

      return {
        id: row.id,
        webhookSecret: secret
      };
    });
  }

  async ingestCall(
    connectionId: string,
    webhookSecret: string,
    input: {
      externalCallId: string;
      startedAt: string;
      durationSeconds?: number;
      status?: "ANSWERED" | "MISSED" | "BUSY" | "FAILED" | "UNKNOWN";
      outcome?: string;
      source?: string;
      callerPhone?: string;
      visitorId?: string;
      sessionId?: string;
      partyId?: string;
      payload?: Record<string, unknown>;
    }
  ): Promise<{ accepted: true; callId: string }> {
    if (!input.externalCallId?.trim() || input.externalCallId.length > 250) {
      throw new BadRequestException("Некорректный externalCallId");
    }

    const startedAt = new Date(input.startedAt);
    if (
      Number.isNaN(startedAt.getTime()) ||
      Math.abs(Date.now() - startedAt.getTime()) > 366 * 86400000
    ) {
      throw new BadRequestException("Некорректное время звонка");
    }

    const duration = Math.max(
      0,
      Math.min(24 * 3600, Math.floor(input.durationSeconds ?? 0))
    );

    const lookup = await this.database.query<{
      connection_id: string;
      tenant_id: string;
      tracker_site_id: string | null;
      webhook_secret_hash: string;
      status: string;
    }>(
      "SELECT * FROM corebiz_resolve_calltracking_connection($1)",
      [connectionId]
    );

    const connection = lookup.rows[0];
    if (!connection || connection.status === "DISABLED") {
      throw new NotFoundException("Calltracking connection не найден");
    }

    const suppliedHash = createHash("sha256")
      .update(webhookSecret)
      .digest();
    const expectedHash = Buffer.from(
      connection.webhook_secret_hash,
      "hex"
    );

    if (
      suppliedHash.length !== expectedHash.length ||
      !timingSafeEqual(suppliedHash, expectedHash)
    ) {
      throw new ForbiddenException("Некорректный webhook secret");
    }

    const phoneHash = input.callerPhone
      ? this.hmac(
          "phone|" + this.normalizePhone(input.callerPhone)
        )
      : null;

    return this.database.withTenantTransaction(
      {
        tenantId: connection.tenant_id,
        userId: "00000000-0000-0000-0000-000000000000",
        membershipId: "00000000-0000-0000-0000-000000000000"
      },
      async (client) => {
        let visitorId: string | null = null;
        let sessionId: string | null = null;
        let partyId: string | null = null;

        if (connection.tracker_site_id && input.visitorId) {
          const visitorHash = this.hmac(
            connection.tracker_site_id + "|" + input.visitorId.trim()
          );

          const visitor = await client.query<{
            id: string;
            party_id: string | null;
          }>(
            "SELECT id,party_id FROM marketing_visitor " +
            "WHERE tenant_id=$1 AND visitor_key_hash=$2",
            [connection.tenant_id, visitorHash]
          );

          if (visitor.rows[0]) {
            visitorId = visitor.rows[0].id;
            partyId = visitor.rows[0].party_id;
          }
        }

        if (visitorId && connection.tracker_site_id && input.sessionId) {
          const sessionHash = this.hmac(
            connection.tracker_site_id + "|" + input.sessionId.trim()
          );
          const session = await client.query<{ id: string }>(
            "SELECT id FROM marketing_session WHERE tenant_id=$1 " +
            "AND visitor_id=$2 AND session_key_hash=$3",
            [connection.tenant_id, visitorId, sessionHash]
          );
          sessionId = session.rows[0]?.id ?? null;
        }

        if (input.partyId) {
          const party = await client.query(
            "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
            [connection.tenant_id, input.partyId]
          );
          if (!party.rowCount) throw new NotFoundException("Клиент не найден");

          if (partyId && partyId !== input.partyId) {
            throw new ConflictException(
              "Webhook party конфликтует с visitor identity"
            );
          }
          partyId = input.partyId;
        }

        const result = await client.query<{ id: string }>(
          "INSERT INTO marketing_call(" +
          "tenant_id,connection_id,external_call_id,visitor_id,session_id,party_id," +
          "caller_phone_hash,started_at,duration_seconds,status,outcome,source,payload" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) " +
          "ON CONFLICT (connection_id,external_call_id) DO UPDATE SET " +
          "visitor_id=COALESCE(EXCLUDED.visitor_id,marketing_call.visitor_id)," +
          "session_id=COALESCE(EXCLUDED.session_id,marketing_call.session_id)," +
          "party_id=COALESCE(EXCLUDED.party_id,marketing_call.party_id)," +
          "duration_seconds=EXCLUDED.duration_seconds,status=EXCLUDED.status," +
          "outcome=EXCLUDED.outcome,source=EXCLUDED.source,payload=EXCLUDED.payload," +
          "updated_at=now() RETURNING id",
          [
            connection.tenant_id,
            connection.connection_id,
            input.externalCallId.trim(),
            visitorId,
            sessionId,
            partyId,
            phoneHash,
            startedAt,
            duration,
            input.status ?? "UNKNOWN",
            this.limit(input.outcome, 300),
            this.limit(input.source, 300),
            JSON.stringify(this.sanitizePayload(input.payload ?? {}))
          ]
        );

        await client.query(
          "UPDATE calltracking_connection SET status='ACTIVE'," +
          "last_received_at=now(),last_error=NULL,updated_at=now() " +
          "WHERE tenant_id=$1 AND id=$2",
          [connection.tenant_id, connection.connection_id]
        );

        return {
          accepted: true as const,
          callId: result.rows[0]!.id
        };
      }
    );
  }

  async calls(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT c.id,c.external_call_id,c.started_at,c.duration_seconds,c.status," +
        "c.outcome,c.source,c.visitor_id,c.session_id,c.party_id,p.display_name AS party_name," +
        "cc.name AS connection_name,cc.provider " +
        "FROM marketing_call c " +
        "JOIN calltracking_connection cc ON cc.tenant_id=c.tenant_id AND cc.id=c.connection_id " +
        "LEFT JOIN party p ON p.tenant_id=c.tenant_id AND p.id=c.party_id " +
        "WHERE c.tenant_id=$1 ORDER BY c.started_at DESC LIMIT 500",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async offlineConnections(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT id,provider,name,counter_id,target,status,last_export_at,last_error," +
        "created_at FROM offline_conversion_connection " +
        "WHERE tenant_id=$1 ORDER BY created_at DESC",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createYandexMetrica(
    context: TenantContext,
    input: {
      name: string;
      counterId: string;
      target: string;
      oauthToken: string;
    }
  ): Promise<{ id: string }> {
    const counterId = BigInt(input.counterId);
    if (counterId <= 0n) throw new BadRequestException("Некорректный counterId");

    const name = input.name.trim();
    const target = input.target.trim();
    const token = input.oauthToken.trim();

    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название подключения");
    }
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(target)) {
      throw new BadRequestException("Некорректный Target");
    }
    if (token.length < 16 || token.length > 4096) {
      throw new BadRequestException("Некорректный OAuth-токен");
    }

    const encrypted = this.crypto.encrypt({ oauthToken: token });

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO offline_conversion_connection(" +
        "tenant_id,provider,name,counter_id,target,credentials_ciphertext," +
        "created_by_membership_id" +
        ") VALUES ($1,'YANDEX_METRICA',$2,$3,$4,$5,$6) RETURNING id",
        [
          context.tenantId,
          name,
          counterId.toString(),
          target,
          encrypted,
          context.membershipId
        ]
      );
      return result.rows[0]!;
    });
  }

  async queueOfflineConversions(
    context: TenantContext,
    connectionId: string,
    model = "LAST_PAID_TOUCH"
  ): Promise<{ queued: number; skippedNoYclid: number }> {
    if (!["FIRST_TOUCH","LAST_TOUCH","LAST_PAID_TOUCH"].includes(model)) {
      throw new BadRequestException("Неизвестная модель атрибуции");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const connection = await client.query<{
        target: string;
        status: string;
      }>(
        "SELECT target,status FROM offline_conversion_connection " +
        "WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, connectionId]
      );

      const conn = connection.rows[0];
      if (!conn) throw new NotFoundException("Offline connection не найден");
      if (conn.status === "DISABLED") {
        throw new BadRequestException("Подключение отключено");
      }

      const conversions = await client.query<{
        conversion_type: string;
        conversion_id: string;
        party_id: string;
        conversion_at: Date;
        yclid: string | null;
        value_minor: string;
        currency: string;
      }>(
        "SELECT a.conversion_type,a.conversion_id,a.party_id,a.conversion_at," +
        "t.yclid," +
        "CASE WHEN a.conversion_type='SALES_ORDER' THEN COALESCE(o.total_minor,0)::text " +
        "ELSE COALESCE(b.price_minor_snapshot,0)::text END AS value_minor," +
        "CASE WHEN a.conversion_type='SALES_ORDER' THEN COALESCE(o.currency,'RUB') " +
        "ELSE COALESCE(b.currency,'RUB') END AS currency " +
        "FROM attribution_result a " +
        "LEFT JOIN marketing_touchpoint t ON t.tenant_id=a.tenant_id AND t.id=a.touchpoint_id " +
        "LEFT JOIN sales_order o ON a.conversion_type='SALES_ORDER' " +
        "AND o.tenant_id=a.tenant_id AND o.id=a.conversion_id " +
        "LEFT JOIN service_booking b ON a.conversion_type='SERVICE_BOOKING' " +
        "AND b.tenant_id=a.tenant_id AND b.id=a.conversion_id " +
        "WHERE a.tenant_id=$1 AND a.model=$2 AND a.conversion_at <= now()",
        [context.tenantId, model]
      );

      let queued = 0;
      let skippedNoYclid = 0;

      for (const row of conversions.rows) {
        if (!row.yclid) {
          skippedNoYclid += 1;
          continue;
        }

        const result = await client.query(
          "INSERT INTO offline_conversion_job(" +
          "tenant_id,connection_id,conversion_type,conversion_id,party_id,yclid,target," +
          "occurred_at,value_minor,currency" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) " +
          "ON CONFLICT (connection_id,conversion_type,conversion_id,target) DO NOTHING " +
          "RETURNING id",
          [
            context.tenantId,
            connectionId,
            row.conversion_type,
            row.conversion_id,
            row.party_id,
            row.yclid,
            conn.target,
            row.conversion_at,
            row.value_minor,
            row.currency
          ]
        );

        if (result.rowCount) queued += 1;
      }

      return { queued, skippedNoYclid };
    });
  }

  async offlineJobs(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT j.id,j.conversion_type,j.conversion_id,j.target,j.occurred_at," +
        "j.value_minor::text,j.currency,j.status,j.attempts,j.provider_upload_id," +
        "j.provider_status,j.last_error,j.created_at,c.name AS connection_name " +
        "FROM offline_conversion_job j " +
        "JOIN offline_conversion_connection c ON c.tenant_id=j.tenant_id AND c.id=j.connection_id " +
        "WHERE j.tenant_id=$1 ORDER BY j.created_at DESC LIMIT 500",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  private normalizePhone(value: string): string {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      throw new BadRequestException("Некорректный номер телефона");
    }
    return digits;
  }

  private hmac(value: string): string {
    return createHmac("sha256", getEnv().sessionSecret)
      .update(value)
      .digest("hex");
  }

  private limit(value: string | undefined, max: number): string | null {
    const normalized = value?.trim();
    return normalized ? normalized.slice(0, max) : null;
  }

  private sanitizePayload(
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    const blocked = new Set([
      "phone","callerphone","password","token","authorization",
      "cookie","recordingurl","recording"
    ]);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload).slice(0, 80)) {
      if (blocked.has(key.toLowerCase().replace(/[^a-z]/g, ""))) continue;
      if (typeof value === "string") result[key] = value.slice(0, 500);
      else if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        result[key] = value;
      }
    }

    if (JSON.stringify(result).length > 10000) {
      throw new BadRequestException("Call payload слишком большой");
    }
    return result;
  }

  private async audit(
    client: import("pg").PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_event(" +
      "tenant_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,after_data" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        data ? JSON.stringify(data) : null
      ]
    );
  }
}
