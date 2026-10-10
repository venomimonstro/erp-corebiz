import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { RuntimePressureService } from "../runtime-pressure/runtime-pressure.service";

@Injectable()
export class DataManagementService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: RuntimePressureService
  ) {}

  async requestExport(
    context: TenantContext,
    input: { format?: "JSON_GZIP" | "CSV_GZIP" }
  ): Promise<{ id: string; status: string }> {
    const format = input.format ?? "JSON_GZIP";
    if (!["JSON_GZIP", "CSV_GZIP"].includes(format)) {
      throw new BadRequestException("Неизвестный формат экспорта");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const running = await client.query<{ id: string }>(
        `SELECT id
         FROM tenant_export_job
         WHERE tenant_id=$1
           AND status IN ('PENDING','PROCESSING')
         ORDER BY created_at DESC
         LIMIT 1`,
        [context.tenantId]
      );

      if (running.rows[0]) {
        await this.runtime.deny(context, {
          operation: "tenant_export",
          reason: "tenant already has active export job",
          currentValue: 1,
          limitValue: 1,
          retryAfterSeconds: 120
        });
      }

      const result = await client.query<{ id: string; status: string }>(
        `INSERT INTO tenant_export_job(
           tenant_id,requested_by_membership_id,format
         ) VALUES ($1,$2,$3)
         RETURNING id,status`,
        [context.tenantId, context.membershipId, format]
      );

      const row = result.rows[0]!;

      await client.query(
        `INSERT INTO audit_event(
           tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data
         ) VALUES ($1,$2,$3,'data.export_requested','tenant_export_job',$4,$5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          row.id,
          JSON.stringify({ format })
        ]
      );

      return row;
    });
  }

  async exports(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `UPDATE tenant_export_job
         SET status='EXPIRED',artifact=NULL,updated_at=now()
         WHERE tenant_id=$1
           AND status='READY'
           AND expires_at IS NOT NULL
           AND expires_at <= now()`,
        [context.tenantId]
      );

      const result = await client.query(
        `SELECT
           id,format,status,schema_version,manifest,
           filename,size_bytes,checksum_sha256,attempts,last_error,
           expires_at,started_at,completed_at,downloaded_at,created_at
         FROM tenant_export_job
         WHERE tenant_id=$1
         ORDER BY created_at DESC
         LIMIT 100`,
        [context.tenantId]
      );

      return result.rows;
    });
  }

  async artifact(
    context: TenantContext,
    id: string
  ): Promise<{
    artifact: Buffer;
    filename: string;
    contentType: string;
    checksumSha256: string;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        status: string;
        artifact: Buffer | null;
        filename: string | null;
        content_type: string | null;
        checksum_sha256: string | null;
        expires_at: Date | null;
      }>(
        `SELECT
           status,artifact,filename,content_type,checksum_sha256,expires_at
         FROM tenant_export_job
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, id]
      );

      const row = result.rows[0];
      if (!row) throw new NotFoundException("Экспорт не найден");

      if (
        row.status !== "READY" ||
        !row.artifact ||
        !row.filename ||
        !row.checksum_sha256
      ) {
        throw new ConflictException("Экспорт ещё не готов к скачиванию");
      }

      if (row.expires_at && row.expires_at <= new Date()) {
        await client.query(
          `UPDATE tenant_export_job
           SET status='EXPIRED',artifact=NULL,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, id]
        );
        throw new ConflictException("Срок хранения экспорта истёк");
      }

      await client.query(
        `UPDATE tenant_export_job
         SET downloaded_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, id]
      );

      await client.query(
        `INSERT INTO audit_event(
           tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data
         ) VALUES ($1,$2,$3,'data.export_downloaded','tenant_export_job',$4,$5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          id,
          JSON.stringify({ checksumSha256: row.checksum_sha256 })
        ]
      );

      return {
        artifact: row.artifact,
        filename: row.filename,
        contentType: row.content_type ?? "application/gzip",
        checksumSha256: row.checksum_sha256
      };
    });
  }

  async offboardingReview(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const [
        tenant,
        subscription,
        freshExport,
        runningExport,
        openOrders,
        openObligations,
        activeWmsTasks,
        openTickets,
        activeChannels
      ] = await Promise.all([
        client.query<{ status: string; name: string }>(
          "SELECT status,name FROM tenant WHERE id=$1",
          [context.tenantId]
        ),
        client.query<{
          status: string;
          cancel_at_period_end: boolean;
          current_period_end: Date;
        }>(
          `SELECT status,cancel_at_period_end,current_period_end
           FROM tenant_subscription
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{ id: string; expires_at: Date }>(
          `SELECT id,expires_at
           FROM tenant_export_job
           WHERE tenant_id=$1
             AND status='READY'
             AND expires_at > now()
           ORDER BY completed_at DESC
           LIMIT 1`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM tenant_export_job
           WHERE tenant_id=$1
             AND status IN ('PENDING','PROCESSING')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM sales_order
           WHERE tenant_id=$1
             AND order_status IN ('DRAFT','CONFIRMED')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM financial_obligation
           WHERE tenant_id=$1
             AND status IN ('OPEN','PARTIALLY_SETTLED')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM warehouse_task
           WHERE tenant_id=$1
             AND status IN ('OPEN','CLAIMED','BLOCKED')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM support_ticket
           WHERE tenant_id=$1
             AND status NOT IN ('RESOLVED','CLOSED')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM channel_connection
           WHERE tenant_id=$1
             AND status <> 'DISABLED'`,
          [context.tenantId]
        )
      ]);

      const subscriptionRow = subscription.rows[0];
      const values = {
        tenantStatus: tenant.rows[0]?.status ?? "UNKNOWN",
        subscriptionStatus: subscriptionRow?.status ?? "NONE",
        subscriptionCancelAtPeriodEnd:
          subscriptionRow?.cancel_at_period_end ?? false,
        freshExportId: freshExport.rows[0]?.id ?? null,
        freshExportExpiresAt:
          freshExport.rows[0]?.expires_at?.toISOString() ?? null,
        runningExports: Number(runningExport.rows[0]?.count ?? "0"),
        openOrders: Number(openOrders.rows[0]?.count ?? "0"),
        openObligations: Number(openObligations.rows[0]?.count ?? "0"),
        activeWmsTasks: Number(activeWmsTasks.rows[0]?.count ?? "0"),
        openSupportTickets: Number(openTickets.rows[0]?.count ?? "0"),
        activeChannels: Number(activeChannels.rows[0]?.count ?? "0")
      };

      const blockers: Array<{
        code: string;
        message: string;
        count?: number;
      }> = [];
      const warnings: Array<{
        code: string;
        message: string;
        count?: number;
      }> = [];

      if (!values.freshExportId) {
        blockers.push({
          code: "FRESH_EXPORT_REQUIRED",
          message: "Сначала сформируйте и скачайте свежий экспорт данных."
        });
      }

      if (values.runningExports > 0) {
        blockers.push({
          code: "EXPORT_RUNNING",
          message: "Дождитесь завершения текущего экспорта.",
          count: values.runningExports
        });
      }

      if (
        subscriptionRow &&
        subscriptionRow.status !== "CANCELLED" &&
        !subscriptionRow.cancel_at_period_end
      ) {
        blockers.push({
          code: "SUBSCRIPTION_ACTIVE",
          message:
            "Активную подписку нужно сначала перевести в режим завершения периода."
        });
      }

      if (values.openOrders > 0) {
        blockers.push({
          code: "OPEN_ORDERS",
          message: "Есть незавершённые заказы.",
          count: values.openOrders
        });
      }

      if (values.openObligations > 0) {
        blockers.push({
          code: "OPEN_FINANCIAL_OBLIGATIONS",
          message: "Есть незакрытые финансовые обязательства.",
          count: values.openObligations
        });
      }

      if (values.activeWmsTasks > 0) {
        blockers.push({
          code: "ACTIVE_WMS_TASKS",
          message: "Есть активные складские задания.",
          count: values.activeWmsTasks
        });
      }

      if (values.openSupportTickets > 0) {
        warnings.push({
          code: "OPEN_SUPPORT_TICKETS",
          message: "Есть незакрытые обращения в поддержку.",
          count: values.openSupportTickets
        });
      }

      if (values.activeChannels > 0) {
        warnings.push({
          code: "ACTIVE_CHANNELS",
          message:
            "Перед финальным offboarding рекомендуется отключить внешние каналы.",
          count: values.activeChannels
        });
      }

      const readiness = blockers.length ? "BLOCKED" : "READY";

      const review = await client.query<{ id: string }>(
        `INSERT INTO tenant_offboarding_review(
           tenant_id,reviewed_by_membership_id,readiness,
           blockers,warnings,snapshot
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          context.membershipId,
          readiness,
          JSON.stringify(blockers),
          JSON.stringify(warnings),
          JSON.stringify(values)
        ]
      );

      return {
        reviewId: review.rows[0]!.id,
        readiness,
        blockers,
        warnings,
        snapshot: values,
        deletionAvailable: false,
        note:
          "Проверка готовности не удаляет tenant и не запускает необратимые действия."
      };
    });
  }

  async offboardingHistory(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           id,readiness,blockers,warnings,snapshot,created_at
         FROM tenant_offboarding_review
         WHERE tenant_id=$1
         ORDER BY created_at DESC
         LIMIT 50`,
        [context.tenantId]
      );
      return result.rows;
    });
  }
}
