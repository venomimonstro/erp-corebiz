import {
  BadRequestException,
  Injectable
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { GoLiveService } from "../../platform/go-live/go-live.service";

type QueueItem = {
  sourceKey: string;
  domain: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  detail: string;
  href: string;
  createdAt: string;
};

@Injectable()
export class ActionQueueService {
  constructor(
    private readonly database: DatabaseService,
    private readonly goLive: GoLiveService
  ) {}

  async queue(
    context: TenantContext
  ): Promise<{
    unread: number;
    items: Array<QueueItem & {
      state: "UNREAD" | "READ";
    }>;
  }> {
    const base = await this.database.withTenantTransaction(
      context,
      async (client) => {
        await client.query(
          `UPDATE action_queue_user_state
           SET state='UNREAD',snoozed_until=NULL,updated_at=now()
           WHERE tenant_id=$1
             AND membership_id=$2
             AND state='SNOOZED'
             AND snoozed_until <= now()`,
          [context.tenantId, context.membershipId]
        );

        const permissionRows = await client.query<{
          permission_code: string;
        }>(
          `SELECT DISTINCT rp.permission_code
           FROM membership_role mr
           JOIN role_permission rp
             ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
           WHERE mr.tenant_id=$1 AND mr.membership_id=$2`,
          [context.tenantId, context.membershipId]
        );

        const permissions = new Set(
          permissionRows.rows.map((row) => row.permission_code)
        );
        const allowed = (code: string) =>
          permissions.has("*") || permissions.has(code);

        const items: QueueItem[] = [];

        if (allowed("tasks.read")) {
          const tasks = await client.query<{
            id: string;
            title: string;
            priority: string;
            due_at: Date | null;
            created_at: Date;
          }>(
            `SELECT id,title,priority,due_at,created_at
             FROM task
             WHERE tenant_id=$1
               AND responsible_membership_id=$2
               AND state IN ('OPEN','IN_PROGRESS','WAITING')
             ORDER BY
               CASE WHEN due_at IS NOT NULL AND due_at < now() THEN 0 ELSE 1 END,
               due_at NULLS LAST,
               created_at
             LIMIT 30`,
            [context.tenantId, context.membershipId]
          );

          for (const row of tasks.rows) {
            const overdue = Boolean(
              row.due_at && row.due_at.getTime() < Date.now()
            );
            const dueSoon = Boolean(
              row.due_at &&
              row.due_at.getTime() <= Date.now() + 24 * 3600000
            );

            items.push({
              sourceKey: "task:" + row.id,
              domain: "TASK",
              severity:
                overdue || row.priority === "URGENT"
                  ? "CRITICAL"
                  : dueSoon || row.priority === "HIGH"
                    ? "WARNING"
                    : "INFO",
              title: row.title,
              detail: row.due_at
                ? (overdue ? "Просрочено · " : "Срок · ") +
                  row.due_at.toLocaleString("ru-RU")
                : "Без срока",
              href: "/app/tasks?task=" + row.id,
              createdAt: row.created_at.toISOString()
            });
          }
        }

        if (
          allowed("dashboard.owner.read") ||
          allowed("finance.read")
        ) {
          const issues = await client.query<{
            id: string;
            issue_code: string;
            first_seen_at: Date;
          }>(
            `SELECT id,issue_code,first_seen_at
             FROM tenant_operational_issue
             WHERE tenant_id=$1 AND state='OPEN'
             ORDER BY first_seen_at
             LIMIT 50`,
            [context.tenantId]
          );

          const issueLabels: Record<string, {
            title: string;
            href: string;
            severity: "WARNING" | "CRITICAL";
          }> = {
            BANK_UNMATCHED: {
              title: "Сопоставить банковские операции",
              href: "/app/finance",
              severity: "WARNING"
            },
            VAT_UNREGISTERED: {
              title: "Зарегистрировать документы НДС",
              href: "/app/accounting",
              severity: "CRITICAL"
            },
            CLOSE_BLOCKED: {
              title: "Закрытие месяца заблокировано",
              href: "/app/accounting",
              severity: "CRITICAL"
            },
            PAYROLL_DRAFT: {
              title: "Проверить расчёт зарплаты",
              href: "/app/accounting",
              severity: "WARNING"
            }
          };

          for (const row of issues.rows) {
            const meta = issueLabels[row.issue_code] ?? {
              title: row.issue_code,
              href: "/app/operations",
              severity: "WARNING" as const
            };

            items.push({
              sourceKey: "operational:" + row.id,
              domain: "OPERATIONS",
              severity: meta.severity,
              title: meta.title,
              detail:
                "Открыто с " +
                row.first_seen_at.toLocaleString("ru-RU"),
              href: meta.href,
              createdAt: row.first_seen_at.toISOString()
            });
          }
        }

        if (allowed("wms.read")) {
          const wms = await client.query<{
            id: string;
            task_type: string;
            status: string;
            last_error: string | null;
            created_at: Date;
          }>(
            `SELECT id,task_type,status,last_error,created_at
             FROM warehouse_task
             WHERE tenant_id=$1
               AND (
                 assigned_membership_id=$2
                 OR claimed_by_membership_id=$2
               )
               AND status IN ('OPEN','CLAIMED','FAILED')
             ORDER BY
               CASE status WHEN 'FAILED' THEN 0 ELSE 1 END,
               priority,
               created_at
             LIMIT 30`,
            [context.tenantId, context.membershipId]
          );

          for (const row of wms.rows) {
            items.push({
              sourceKey: "wms-task:" + row.id,
              domain: "WMS",
              severity:
                row.status === "FAILED" ? "CRITICAL" : "INFO",
              title:
                row.status === "FAILED"
                  ? "Ошибка складского задания"
                  : "Складское задание " + row.task_type,
              detail:
                row.last_error ??
                (row.status === "CLAIMED"
                  ? "Задание уже взято в работу."
                  : "Задание ожидает выполнения."),
              href: "/app/wms/mobile",
              createdAt: row.created_at.toISOString()
            });
          }
        }

        if (allowed("analytics.read")) {
          const alerts = await client.query<{
            id: string;
            severity: string;
            created_at: Date;
            rule_name: string;
            campaign_name: string | null;
          }>(
            `SELECT
               e.id,e.severity,e.created_at,
               r.name AS rule_name,
               c.name AS campaign_name
             FROM marketing_alert_event e
             JOIN marketing_alert_rule r
               ON r.tenant_id=e.tenant_id AND r.id=e.rule_id
             LEFT JOIN marketing_campaign c
               ON c.tenant_id=e.tenant_id AND c.id=e.campaign_id
             WHERE e.tenant_id=$1
               AND e.status='OPEN'
             ORDER BY e.created_at DESC
             LIMIT 30`,
            [context.tenantId]
          );

          for (const row of alerts.rows) {
            items.push({
              sourceKey: "marketing-alert:" + row.id,
              domain: "MARKETING",
              severity:
                row.severity === "CRITICAL"
                  ? "CRITICAL"
                  : "WARNING",
              title: row.rule_name,
              detail: row.campaign_name ?? "Маркетинговый контроль",
              href: "/app/analytics/profitability",
              createdAt: row.created_at.toISOString()
            });
          }
        }

        return {
          items,
          goLiveAllowed: allowed("go_live.read")
        };
      }
    );

    if (base.goLiveAllowed) {
      try {
        const readiness = await this.goLive.readiness(context) as any;
        for (const blocker of (readiness.blockers ?? []).slice(0, 20)) {
          base.items.push({
            sourceKey: "go-live:" + blocker.code,
            domain: "GO_LIVE",
            severity: "CRITICAL",
            title: blocker.title,
            detail: blocker.detail,
            href: blocker.href || "/app/settings/go-live",
            createdAt: new Date().toISOString()
          });
        }
      } catch {
        // Go-live aggregation must not make the personal queue unavailable.
      }
    }

    const sourceKeys = base.items.map((item) => item.sourceKey);
    const states = sourceKeys.length
      ? await this.database.withTenantTransaction(
          context,
          async (client) => {
            const result = await client.query<{
              source_key: string;
              state: "UNREAD" | "READ" | "SNOOZED";
              snoozed_until: Date | null;
            }>(
              `SELECT source_key,state,snoozed_until
               FROM action_queue_user_state
               WHERE tenant_id=$1
                 AND membership_id=$2
                 AND source_key=ANY($3::text[])`,
              [
                context.tenantId,
                context.membershipId,
                sourceKeys
              ]
            );
            return new Map(
              result.rows.map((row) => [row.source_key,row])
            );
          }
        )
      : new Map();

    const rank = {
      CRITICAL: 0,
      WARNING: 1,
      INFO: 2
    } as const;

    const items = base.items
      .filter((item) => {
        const state = states.get(item.sourceKey);
        return !(
          state?.state === "SNOOZED" &&
          state.snoozed_until &&
          state.snoozed_until.getTime() > Date.now()
        );
      })
      .map((item) => ({
        ...item,
        state:
          states.get(item.sourceKey)?.state === "READ"
            ? "READ" as const
            : "UNREAD" as const
      }))
      .sort(
        (a,b) =>
          rank[a.severity] - rank[b.severity] ||
          new Date(a.createdAt).getTime() -
            new Date(b.createdAt).getTime()
      )
      .slice(0, 100);

    return {
      unread: items.filter((item) => item.state === "UNREAD").length,
      items
    };
  }

  async setState(
    context: TenantContext,
    input: {
      sourceKey: string;
      state: "UNREAD" | "READ" | "SNOOZED";
      snoozedUntil?: string;
    }
  ): Promise<void> {
    const sourceKey = String(input.sourceKey ?? "").trim();
    if (sourceKey.length < 3 || sourceKey.length > 300) {
      throw new BadRequestException("Некорректный sourceKey");
    }

    if (!["UNREAD","READ","SNOOZED"].includes(input.state)) {
      throw new BadRequestException("Некорректное состояние");
    }

    let snoozedUntil: Date | null = null;
    if (input.state === "SNOOZED") {
      snoozedUntil = input.snoozedUntil
        ? new Date(input.snoozedUntil)
        : new Date(Date.now() + 24 * 3600000);

      if (
        Number.isNaN(snoozedUntil.getTime()) ||
        snoozedUntil.getTime() <= Date.now() ||
        snoozedUntil.getTime() > Date.now() + 30 * 86400000
      ) {
        throw new BadRequestException(
          "Snooze должен быть в будущем, максимум 30 дней"
        );
      }
    }

    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO action_queue_user_state(
           tenant_id,membership_id,source_key,state,snoozed_until,updated_at
         ) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (tenant_id,membership_id,source_key)
         DO UPDATE SET
           state=EXCLUDED.state,
           snoozed_until=EXCLUDED.snoozed_until,
           updated_at=now()`,
        [
          context.tenantId,
          context.membershipId,
          sourceKey,
          input.state,
          snoozedUntil
        ]
      );
    });
  }
}
