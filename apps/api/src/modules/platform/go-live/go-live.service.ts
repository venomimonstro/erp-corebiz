import {
  BadRequestException,
  Injectable
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type Check = {
  code: string;
  title: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  href: string;
};

@Injectable()
export class GoLiveService {
  constructor(private readonly database: DatabaseService) {}

  async readiness(context: TenantContext): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const [profileResult, launchResult, activationResult] = await Promise.all([
        client.query<{ profile_code: string }>(
          `SELECT profile_code
           FROM tenant_business_profile
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{
          stage: string;
          go_live_at: Date | null;
          hypercare_until: Date | null;
          last_review_id: string | null;
        }>(
          `SELECT stage,go_live_at,hypercare_until,last_review_id
           FROM tenant_launch_state
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{
          first_value_at: Date | null;
          completed_at: Date | null;
        }>(
          `SELECT first_value_at,completed_at
           FROM tenant_activation_state
           WHERE tenant_id=$1`,
          [context.tenantId]
        )
      ]);

      const profile = profileResult.rows[0]?.profile_code ?? "GENERAL";
      const launch = launchResult.rows[0] ?? {
        stage: "PREPARING",
        go_live_at: null,
        hypercare_until: null,
        last_review_id: null
      };
      const activation = activationResult.rows[0];

      const checks: Check[] = [];

      checks.push({
        code: "FIRST_VALUE",
        title: "Первый рабочий сценарий",
        ok: Boolean(activation?.first_value_at),
        blocking: true,
        detail: activation?.first_value_at
          ? "Первый результат получен " +
            activation.first_value_at.toLocaleString("ru-RU")
          : "Проведите первую реальную операцию профиля бизнеса.",
        href: "/app"
      });

      const owner = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM tenant_membership
         WHERE tenant_id=$1
           AND status='ACTIVE'
           AND is_owner=true`,
        [context.tenantId]
      );
      checks.push({
        code: "ACTIVE_OWNER",
        title: "Активный владелец",
        ok: Number(owner.rows[0]?.count ?? "0") > 0,
        blocking: true,
        detail: "У tenant должен оставаться хотя бы один активный владелец.",
        href: "/app/settings"
      });

      const migrations = await client.query<{
        total: string;
        unresolved: string;
      }>(
        `SELECT
           count(*)::text AS total,
           count(*) FILTER (
             WHERE status <> 'RECONCILED'
           )::text AS unresolved
         FROM migration_batch
         WHERE tenant_id=$1`,
        [context.tenantId]
      );
      const migrationTotal = Number(migrations.rows[0]?.total ?? "0");
      const migrationUnresolved = Number(
        migrations.rows[0]?.unresolved ?? "0"
      );
      checks.push({
        code: "MIGRATION_RECONCILED",
        title: "Миграция данных",
        ok: migrationUnresolved === 0,
        blocking: migrationTotal > 0,
        detail:
          migrationTotal === 0
            ? "Migration Center не использовался."
            : migrationUnresolved === 0
              ? "Все импортированные пакеты прошли reconciliation."
              : "Незавершённых или несверенных пакетов: " +
                migrationUnresolved,
        href: "/app/settings"
      });

      const degradedChannels = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM channel_connection
         WHERE tenant_id=$1
           AND status='DEGRADED'`,
        [context.tenantId]
      );
      const degradedCount = Number(
        degradedChannels.rows[0]?.count ?? "0"
      );
      checks.push({
        code: "CHANNEL_HEALTH",
        title: "Каналы продаж",
        ok: degradedCount === 0,
        blocking: true,
        detail:
          degradedCount === 0
            ? "DEGRADED каналов нет."
            : "DEGRADED подключений: " + degradedCount,
        href: "/app/channels"
      });

      const evidence = await client.query<{
        component_code: string;
        verification_kind: string;
        outcome: string;
        executed_at: Date;
      }>(
        `SELECT DISTINCT ON (component_code,verification_kind)
           component_code,verification_kind,outcome,executed_at
         FROM release_verification_record
         WHERE tenant_id=$1
         ORDER BY component_code,verification_kind,executed_at DESC`,
        [context.tenantId]
      );

      const evidenceMap = new Map(
        evidence.rows.map((row) => [
          row.component_code + ":" + row.verification_kind,
          row
        ])
      );
      const freshAfter = Date.now() - 30 * 86400000;

      const evidenceCheck = (
        component: string,
        kind: string,
        code: string,
        title: string,
        blocking = true
      ) => {
        const row = evidenceMap.get(component + ":" + kind);
        const fresh =
          row?.outcome === "PASS" &&
          row.executed_at.getTime() >= freshAfter;
        checks.push({
          code,
          title,
          ok: fresh,
          blocking,
          detail: row
            ? row.outcome +
              " · " +
              row.executed_at.toLocaleString("ru-RU")
            : "Evidence отсутствует.",
          href: "/app/settings/release"
        });
      };

      evidenceCheck(
        "CORE",
        "SECURITY",
        "SECURITY_EVIDENCE",
        "Security gate"
      );
      evidenceCheck(
        "CORE",
        "RESTORE",
        "RESTORE_EVIDENCE",
        "Backup / restore evidence"
      );
      evidenceCheck(
        "FINANCE",
        "RECONCILIATION",
        "FINANCE_RECONCILIATION",
        "Finance reconciliation"
      );

      const capability = await client.query<{
        capability_key: string;
        enabled: boolean;
      }>(
        `SELECT capability_key,enabled
         FROM capability_toggle
         WHERE tenant_id=$1
           AND capability_key IN ('wms','accounting')`,
        [context.tenantId]
      );
      const caps = new Map(
        capability.rows.map((row) => [
          row.capability_key,
          row.enabled
        ])
      );

      if (caps.get("wms") === true) {
        evidenceCheck(
          "WMS",
          "RECONCILIATION",
          "WMS_RECONCILIATION",
          "WMS reconciliation"
        );
      }

      if (caps.get("accounting") === true) {
        evidenceCheck(
          "ACCOUNTING",
          "RECONCILIATION",
          "ACCOUNTING_RECONCILIATION",
          "Accounting reconciliation"
        );
      }

      if (profile === "TRADE" || profile === "ECOMMERCE") {
        const flow = await client.query<{
          products: string;
          orders: string;
          published_sites: string;
          channels: string;
        }>(
          `SELECT
             (SELECT count(*) FROM product
               WHERE tenant_id=$1 AND status='ACTIVE')::text AS products,
             (SELECT count(*) FROM sales_order
               WHERE tenant_id=$1
                 AND order_status IN ('CONFIRMED','COMPLETED'))::text AS orders,
             (SELECT count(*) FROM site_page_version
               WHERE tenant_id=$1 AND status='PUBLISHED')::text AS published_sites,
             (SELECT count(*) FROM channel_connection
               WHERE tenant_id=$1 AND status='ACTIVE')::text AS channels`,
          [context.tenantId]
        );
        const row = flow.rows[0]!;
        checks.push({
          code: "TRADE_FLOW",
          title:
            profile === "ECOMMERCE"
              ? "E-commerce business flow"
              : "Торговый business flow",
          ok:
            Number(row.products) > 0 &&
            Number(row.orders) > 0 &&
            (
              profile !== "ECOMMERCE" ||
              Number(row.published_sites) + Number(row.channels) > 0
            ),
          blocking: true,
          detail:
            "Товаров " + row.products +
            " · заказов " + row.orders +
            " · сайтов " + row.published_sites +
            " · каналов " + row.channels,
          href:
            profile === "ECOMMERCE"
              ? "/app/channels"
              : "/app/sales/orders"
        });
      } else if (profile === "SERVICE") {
        const flow = await client.query<{
          services: string;
          bookings: string;
        }>(
          `SELECT
             (SELECT count(*) FROM service_catalog_item
               WHERE tenant_id=$1 AND status='ACTIVE')::text AS services,
             (SELECT count(*) FROM service_booking
               WHERE tenant_id=$1
                 AND status NOT IN ('DRAFT','CANCELLED'))::text AS bookings`,
          [context.tenantId]
        );
        const row = flow.rows[0]!;
        checks.push({
          code: "SERVICE_FLOW",
          title: "Сервисный business flow",
          ok: Number(row.services) > 0 && Number(row.bookings) > 0,
          blocking: true,
          detail:
            "Услуг " + row.services + " · рабочих записей " + row.bookings,
          href: "/app/service/bookings"
        });
      } else if (profile === "WAREHOUSE_3PL") {
        const flow = await client.query<{
          profiles: string;
          tasks: string;
        }>(
          `SELECT
             (SELECT count(*) FROM warehouse_wms_profile
               WHERE tenant_id=$1 AND status='ACTIVE')::text AS profiles,
             (SELECT count(*) FROM warehouse_task
               WHERE tenant_id=$1)::text AS tasks`,
          [context.tenantId]
        );
        const row = flow.rows[0]!;
        checks.push({
          code: "WMS_FLOW",
          title: "WMS business flow",
          ok: Number(row.profiles) > 0 && Number(row.tasks) > 0,
          blocking: true,
          detail:
            "Активных WMS-профилей " +
            row.profiles +
            " · заданий " +
            row.tasks,
          href: "/app/wms"
        });
      }

      const operational = await client.query<{
        issue_code: string;
        count: string;
      }>(
        `SELECT issue_code,count(*)::text AS count
         FROM tenant_operational_issue
         WHERE tenant_id=$1
           AND state='OPEN'
           AND issue_code IN (
             'VAT_UNREGISTERED','CLOSE_BLOCKED','BANK_UNMATCHED'
           )
         GROUP BY issue_code`,
        [context.tenantId]
      );
      const warningCount = operational.rows.reduce(
        (sum,row) => sum + Number(row.count),
        0
      );
      checks.push({
        code: "OPERATIONAL_WARNINGS",
        title: "Операционные исключения",
        ok: warningCount === 0,
        blocking: false,
        detail:
          warningCount === 0
            ? "Критичных финансовых исключений не зарегистрировано."
            : "Открытых исключений: " + warningCount,
        href: "/app/operations"
      });

      const blockers = checks.filter(
        (check) => check.blocking && !check.ok
      );
      const warnings = checks.filter(
        (check) => !check.blocking && !check.ok
      );

      const history = await client.query(
        `SELECT id,decision,note,reviewed_at,reviewed_by_membership_id
         FROM tenant_go_live_review
         WHERE tenant_id=$1
         ORDER BY reviewed_at DESC
         LIMIT 20`,
        [context.tenantId]
      );

      return {
        profile,
        ready: blockers.length === 0,
        stage: launch.stage,
        goLiveAt: launch.go_live_at?.toISOString() ?? null,
        hypercareUntil:
          launch.hypercare_until?.toISOString() ?? null,
        blockers,
        warnings,
        checks,
        history: history.rows
      };
    });
  }

  async review(
    context: TenantContext,
    input: {
      decision: "GO" | "NO_GO";
      note?: string;
      hypercareDays?: number;
    }
  ): Promise<{
    reviewId: string;
    decision: "GO" | "NO_GO";
    stage: string;
  }> {
    if (!["GO","NO_GO"].includes(input.decision)) {
      throw new BadRequestException("Решение должно быть GO или NO_GO");
    }

    const hypercareDays = Math.floor(input.hypercareDays ?? 14);
    if (hypercareDays < 1 || hypercareDays > 90) {
      throw new BadRequestException("Hypercare: от 1 до 90 дней");
    }

    const snapshot = await this.readiness(context) as any;

    if (input.decision === "GO" && !snapshot.ready) {
      throw new BadRequestException(
        "GO запрещён: сначала устраните все блокирующие проверки"
      );
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const review = await client.query<{ id: string }>(
        `INSERT INTO tenant_go_live_review(
           tenant_id,decision,readiness_snapshot,note,
           reviewed_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [
          context.tenantId,
          input.decision,
          JSON.stringify(snapshot),
          input.note?.trim().slice(0, 2000) || null,
          context.membershipId
        ]
      );

      const reviewId = review.rows[0]!.id;

      if (input.decision === "GO") {
        await client.query(
          `UPDATE tenant_launch_state
           SET stage=CASE
                 WHEN go_live_at IS NULL THEN 'HYPERCARE'
                 ELSE stage
               END,
               go_live_at=COALESCE(go_live_at,now()),
               hypercare_until=CASE
                 WHEN go_live_at IS NULL
                 THEN now()+($3::text || ' days')::interval
                 ELSE hypercare_until
               END,
               last_review_id=$4,
               updated_by_membership_id=$5,
               updated_at=now()
           WHERE tenant_id=$1`,
          [
            context.tenantId,
            context.tenantId,
            String(hypercareDays),
            reviewId,
            context.membershipId
          ]
        );
      } else {
        await client.query(
          `UPDATE tenant_launch_state
           SET last_review_id=$2,
               updated_by_membership_id=$3,
               updated_at=now()
           WHERE tenant_id=$1`,
          [context.tenantId, reviewId, context.membershipId]
        );
      }

      const state = await client.query<{ stage: string }>(
        `SELECT stage FROM tenant_launch_state
         WHERE tenant_id=$1`,
        [context.tenantId]
      );

      return {
        reviewId,
        decision: input.decision,
        stage: state.rows[0]?.stage ?? "PREPARING"
      };
    });
  }

  async finishHypercare(
    context: TenantContext
  ): Promise<void> {
    const snapshot = await this.readiness(context) as any;
    if (!snapshot.ready) {
      throw new BadRequestException(
        "Нельзя завершить hypercare при активных блокерах"
      );
    }

    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE tenant_launch_state
         SET stage='LIVE',
             updated_by_membership_id=$2,
             updated_at=now()
         WHERE tenant_id=$1
           AND stage='HYPERCARE'
           AND go_live_at IS NOT NULL
         RETURNING tenant_id`,
        [context.tenantId, context.membershipId]
      );

      if (!result.rowCount) {
        throw new BadRequestException(
          "Tenant не находится в HYPERCARE"
        );
      }
    });
  }
}
