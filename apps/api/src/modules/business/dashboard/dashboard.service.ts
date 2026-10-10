import { Injectable } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  async owner(context: TenantContext): Promise<{
    kpis: {
      cashMinor: string;
      sales30dMinor: string;
      grossProfit30dMinor: string;
      openOrders: number;
      receivableMinor: string;
      payableMinor: string;
      stockValueMinor: string;
    };
    queue: Array<{
      id: string;
      type: "OVERDUE_TASK" | "DEAL_NO_NEXT_ACTION" | "OVERDUE_OBLIGATION" | "STOCK_RISK";
      severity: "INFO" | "WARNING" | "CRITICAL";
      title: string;
      detail: string;
      href: string;
    }>;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const [cash, sales, openOrders, obligations, stock] = await Promise.all([
        client.query<{ cash_minor: string }>(
          `SELECT (
             COALESCE((SELECT sum(opening_balance_minor) FROM cash_account
               WHERE tenant_id = $1 AND status = 'ACTIVE' AND currency = 'RUB'), 0)
             +
             COALESCE((SELECT sum(
               CASE WHEN direction = 'IN' THEN amount_minor ELSE -amount_minor END
             ) FROM payment
               WHERE tenant_id = $1 AND status = 'POSTED' AND currency = 'RUB'), 0)
           )::text AS cash_minor`,
          [context.tenantId]
        ),
        client.query<{
          sales_minor: string;
          gross_profit_minor: string;
        }>(
          `SELECT
             COALESCE((
               SELECT sum(o.total_minor)
               FROM sales_order o
               WHERE o.tenant_id = $1
                 AND o.order_status IN ('CONFIRMED','COMPLETED')
                 AND o.created_at >= now() - interval '30 days'
                 AND o.currency = 'RUB'
             ), 0)::text AS sales_minor,
             COALESCE((
               SELECT sum(
                 l.line_total_minor -
                 ((l.cost_price_minor_snapshot * l.quantity_milli + 500) / 1000)
               )
               FROM sales_order o
               JOIN sales_order_line l
                 ON l.tenant_id = o.tenant_id
                AND l.order_id = o.id
               WHERE o.tenant_id = $1
                 AND o.order_status IN ('CONFIRMED','COMPLETED')
                 AND o.created_at >= now() - interval '30 days'
                 AND o.currency = 'RUB'
             ), 0)::text AS gross_profit_minor`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM sales_order
           WHERE tenant_id = $1
             AND order_status IN ('DRAFT','CONFIRMED')`,
          [context.tenantId]
        ),
        client.query<{
          direction: "RECEIVABLE" | "PAYABLE";
          remaining_minor: string;
        }>(
          `SELECT
             direction,
             COALESCE(sum(amount_minor - settled_minor), 0)::text AS remaining_minor
           FROM financial_obligation
           WHERE tenant_id = $1
             AND status IN ('OPEN','PARTIALLY_SETTLED')
             AND currency = 'RUB'
           GROUP BY direction`,
          [context.tenantId]
        ),
        client.query<{ stock_value_minor: string }>(
          `SELECT COALESCE(sum(
             ((b.physical_milli * s.cost_price_minor + 500) / 1000)
           ), 0)::text AS stock_value_minor
           FROM inventory_balance b
           JOIN sku s
             ON s.tenant_id = b.tenant_id
            AND s.id = b.sku_id
           WHERE b.tenant_id = $1 AND s.currency = 'RUB'`,
          [context.tenantId]
        )
      ]);

      const receivable = obligations.rows.find(
        (row) => row.direction === "RECEIVABLE"
      );
      const payable = obligations.rows.find(
        (row) => row.direction === "PAYABLE"
      );

      const queue: Array<{
        id: string;
        type: "OVERDUE_TASK" | "DEAL_NO_NEXT_ACTION" | "OVERDUE_OBLIGATION" | "STOCK_RISK";
        severity: "INFO" | "WARNING" | "CRITICAL";
        title: string;
        detail: string;
        href: string;
      }> = [];

      const overdueTasks = await client.query<{
        id: string;
        title: string;
        due_at: Date;
      }>(
        `SELECT id, title, due_at
         FROM task
         WHERE tenant_id = $1
           AND state IN ('OPEN','IN_PROGRESS','WAITING')
           AND due_at < now()
         ORDER BY due_at ASC
         LIMIT 20`,
        [context.tenantId]
      );

      for (const task of overdueTasks.rows) {
        queue.push({
          id: `task:${task.id}`,
          type: "OVERDUE_TASK",
          severity: "WARNING",
          title: task.title,
          detail: `Просрочено: ${task.due_at.toLocaleString("ru-RU")}`,
          href: "/app/tasks?filter=overdue"
        });
      }

      const staleDeals = await client.query<{
        id: string;
        title: string;
        updated_at: Date;
      }>(
        `SELECT d.id, d.title, d.updated_at
         FROM crm_deal d
         JOIN crm_stage s
           ON s.tenant_id = d.tenant_id
          AND s.id = d.stage_id
         WHERE d.tenant_id = $1
           AND s.kind = 'NORMAL'
           AND NOT EXISTS (
             SELECT 1 FROM task t
             WHERE t.tenant_id = d.tenant_id
               AND t.linked_type = 'DEAL'
               AND t.linked_id = d.id
               AND t.state IN ('OPEN','IN_PROGRESS','WAITING')
           )
         ORDER BY d.updated_at ASC
         LIMIT 20`,
        [context.tenantId]
      );

      for (const deal of staleDeals.rows) {
        queue.push({
          id: `deal:${deal.id}`,
          type: "DEAL_NO_NEXT_ACTION",
          severity:
            deal.updated_at < new Date(Date.now() - 3 * 86400000)
              ? "CRITICAL"
              : "WARNING",
          title: deal.title,
          detail: "У сделки нет следующего действия",
          href: "/app/crm/deals"
        });
      }

      const overdueObligations = await client.query<{
        id: string;
        direction: string;
        remaining_minor: string;
        currency: string;
        party_name: string | null;
      }>(
        `SELECT
           o.id,
           o.direction,
           (o.amount_minor - o.settled_minor)::text AS remaining_minor,
           o.currency,
           p.display_name AS party_name
         FROM financial_obligation o
         LEFT JOIN party p
           ON p.tenant_id = o.tenant_id
          AND p.id = o.party_id
         WHERE o.tenant_id = $1
           AND o.status IN ('OPEN','PARTIALLY_SETTLED')
           AND o.due_at IS NOT NULL
           AND o.due_at < now()
         ORDER BY o.due_at ASC
         LIMIT 20`,
        [context.tenantId]
      );

      for (const item of overdueObligations.rows) {
        queue.push({
          id: `obligation:${item.id}`,
          type: "OVERDUE_OBLIGATION",
          severity: item.direction === "RECEIVABLE" ? "CRITICAL" : "WARNING",
          title:
            item.direction === "RECEIVABLE"
              ? "Просроченная дебиторка"
              : "Просроченная кредиторка",
          detail: `${item.party_name ?? "Контрагент"} · ${this.money(
            item.remaining_minor,
            item.currency
          )}`,
          href: "/app/finance"
        });
      }

      const stockRisks = await client.query<{
        sku_id: string;
        sku_code: string;
        product_name: string;
        warehouse_name: string;
        available_milli: string;
      }>(
        `SELECT
           b.sku_id,
           s.code AS sku_code,
           p.name AS product_name,
           w.name AS warehouse_name,
           (b.physical_milli - b.reserved_milli)::text AS available_milli
         FROM inventory_balance b
         JOIN warehouse w
           ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
         JOIN sku s
           ON s.tenant_id = b.tenant_id AND s.id = b.sku_id
         JOIN product_variant v
           ON v.tenant_id = s.tenant_id AND v.id = s.variant_id
         JOIN product p
           ON p.tenant_id = v.tenant_id AND p.id = v.product_id
         WHERE b.tenant_id = $1
           AND s.track_inventory = true
           AND (b.physical_milli - b.reserved_milli) <= 0
         ORDER BY p.name
         LIMIT 20`,
        [context.tenantId]
      );

      for (const item of stockRisks.rows) {
        queue.push({
          id: `stock:${item.sku_id}:${item.warehouse_name}`,
          type: "STOCK_RISK",
          severity: "CRITICAL",
          title: `${item.product_name} · ${item.sku_code}`,
          detail: `${item.warehouse_name}: доступный остаток ${Number(
            item.available_milli
          ) / 1000}`,
          href: "/app/inventory/stock"
        });
      }

      const severityRank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
      queue.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

      return {
        kpis: {
          cashMinor: cash.rows[0]?.cash_minor ?? "0",
          sales30dMinor: sales.rows[0]?.sales_minor ?? "0",
          grossProfit30dMinor: sales.rows[0]?.gross_profit_minor ?? "0",
          openOrders: Number(openOrders.rows[0]?.count ?? "0"),
          receivableMinor: receivable?.remaining_minor ?? "0",
          payableMinor: payable?.remaining_minor ?? "0",
          stockValueMinor: stock.rows[0]?.stock_value_minor ?? "0"
        },
        queue: queue.slice(0, 50)
      };
    });
  }

  async operational(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const today = new Date().toISOString().slice(0, 10);

      const payments = await client.query<{
        direction: "IN" | "OUT";
        amount_minor: string;
      }>(
        `SELECT direction,COALESCE(sum(amount_minor),0)::text AS amount_minor
         FROM payment
         WHERE tenant_id=$1
           AND status='POSTED'
           AND currency='RUB'
           AND created_at >= $2::date
           AND created_at < ($2::date + 1)
         GROUP BY direction`,
        [context.tenantId, today]
      );

      const obligations = await client.query<{
        direction: "RECEIVABLE" | "PAYABLE";
        amount_minor: string;
      }>(
        `SELECT direction,
                COALESCE(sum(amount_minor-settled_minor),0)::text AS amount_minor
         FROM financial_obligation
         WHERE tenant_id=$1
           AND status IN ('OPEN','PARTIALLY_SETTLED')
           AND currency='RUB'
         GROUP BY direction`,
        [context.tenantId]
      );

      const bank = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM finance_bank_statement_line l
         JOIN finance_bank_statement s
           ON s.tenant_id=l.tenant_id AND s.id=l.statement_id
         WHERE l.tenant_id=$1
           AND l.payment_id IS NULL
           AND s.status='IMPORTED'`,
        [context.tenantId]
      );

      const metricValues = new Map<string, bigint>([
        [
          "PAYMENTS_IN",
          BigInt(
            payments.rows.find((row) => row.direction === "IN")
              ?.amount_minor ?? "0"
          )
        ],
        [
          "PAYMENTS_OUT",
          BigInt(
            payments.rows.find((row) => row.direction === "OUT")
              ?.amount_minor ?? "0"
          )
        ],
        [
          "AR_OPEN",
          BigInt(
            obligations.rows.find((row) => row.direction === "RECEIVABLE")
              ?.amount_minor ?? "0"
          )
        ],
        [
          "AP_OPEN",
          BigInt(
            obligations.rows.find((row) => row.direction === "PAYABLE")
              ?.amount_minor ?? "0"
          )
        ],
        ["BANK_UNMATCHED", BigInt(bank.rows[0]?.count ?? "0")]
      ]);

      for (const [metricCode, value] of metricValues) {
        await client.query(
          `INSERT INTO tenant_analytics_snapshot(
             tenant_id,metric_date,metric_code,currency,value_minor,source_updated_at
           ) VALUES ($1,$2,$3,'RUB',$4,now())
           ON CONFLICT (tenant_id,metric_date,metric_code,currency)
           DO UPDATE SET
             value_minor=EXCLUDED.value_minor,
             source_updated_at=now()`,
          [context.tenantId, today, metricCode, value.toString()]
        );
      }

      const currentIssues = new Map<string, Set<string>>([
        ["BANK_UNMATCHED", new Set<string>()],
        ["VAT_UNREGISTERED", new Set<string>()],
        ["CLOSE_BLOCKED", new Set<string>()],
        ["PAYROLL_DRAFT", new Set<string>()]
      ]);

      const unmatched = await client.query<{ id: string }>(
        `SELECT l.id
         FROM finance_bank_statement_line l
         JOIN finance_bank_statement s
           ON s.tenant_id=l.tenant_id AND s.id=l.statement_id
         WHERE l.tenant_id=$1
           AND l.payment_id IS NULL
           AND s.status='IMPORTED'`,
        [context.tenantId]
      );
      for (const row of unmatched.rows) {
        currentIssues.get("BANK_UNMATCHED")!.add(row.id);
      }

      const vat = await client.query<{ id: string }>(
        `SELECT d.id
         FROM accounting_vat_document d
         WHERE d.tenant_id=$1
           AND d.status='APPROVED'
           AND NOT EXISTS(
             SELECT 1
             FROM accounting_vat_register r
             WHERE r.tenant_id=d.tenant_id
               AND r.vat_document_id=d.id
           )`,
        [context.tenantId]
      );
      for (const row of vat.rows) {
        currentIssues.get("VAT_UNREGISTERED")!.add(row.id);
      }

      const close = await client.query<{ id: string }>(
        `SELECT p.id
         FROM accounting_period p
         WHERE p.tenant_id=$1
           AND p.state='OPEN'
           AND EXISTS(
             SELECT 1
             FROM accounting_month_close_check c
             WHERE c.tenant_id=p.tenant_id
               AND c.period_id=p.id
               AND c.status<>'DONE'
           )`,
        [context.tenantId]
      );
      for (const row of close.rows) {
        currentIssues.get("CLOSE_BLOCKED")!.add(row.id);
      }

      const payroll = await client.query<{ id: string }>(
        `SELECT id
         FROM payroll_accrual_batch
         WHERE tenant_id=$1 AND status='DRAFT'`,
        [context.tenantId]
      );
      for (const row of payroll.rows) {
        currentIssues.get("PAYROLL_DRAFT")!.add(row.id);
      }

      for (const [issueCode, ids] of currentIssues) {
        for (const referenceId of ids) {
          await client.query(
            `INSERT INTO tenant_operational_issue(
               tenant_id,issue_code,reference_id,state
             ) VALUES ($1,$2,$3,'OPEN')
             ON CONFLICT (tenant_id,issue_code,reference_id)
             DO UPDATE SET
               state='OPEN',
               resolved_at=NULL`,
            [context.tenantId, issueCode, referenceId]
          );
        }

        const idArray = Array.from(ids);
        await client.query(
          `UPDATE tenant_operational_issue
           SET state='RESOLVED',resolved_at=now()
           WHERE tenant_id=$1
             AND issue_code=$2
             AND state='OPEN'
             AND (
               cardinality($3::uuid[]) = 0
               OR reference_id <> ALL($3::uuid[])
             )`,
          [context.tenantId, issueCode, idArray]
        );
      }

      const snapshots = await client.query(
        `SELECT metric_code,value_minor::text,currency,metric_date,source_updated_at
         FROM tenant_analytics_snapshot
         WHERE tenant_id=$1
           AND metric_date=$2::date
         ORDER BY metric_code`,
        [context.tenantId, today]
      );

      const issues = await client.query<{
        id: string;
        issue_code: string;
        reference_id: string;
        first_seen_at: Date;
      }>(
        `SELECT id,issue_code,reference_id,first_seen_at
         FROM tenant_operational_issue
         WHERE tenant_id=$1 AND state='OPEN'
         ORDER BY first_seen_at ASC
         LIMIT 200`,
        [context.tenantId]
      );

      const href: Record<string, string> = {
        BANK_UNMATCHED: "/app/finance",
        VAT_UNREGISTERED: "/app/accounting",
        CLOSE_BLOCKED: "/app/accounting",
        PAYROLL_DRAFT: "/app/accounting"
      };

      return {
        generatedAt: new Date().toISOString(),
        snapshots: snapshots.rows,
        issues: issues.rows.map((issue) => ({
          id: issue.id,
          code: issue.issue_code,
          referenceId: issue.reference_id,
          firstSeenAt: issue.first_seen_at.toISOString(),
          href: href[issue.issue_code] ?? "/app"
        }))
      };
    });
  }

  private money(value: string, currency: string): string {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }
}
