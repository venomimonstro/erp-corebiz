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
               WHERE tenant_id = $1 AND status = 'ACTIVE'), 0)
             +
             COALESCE((SELECT sum(
               CASE WHEN direction = 'IN' THEN amount_minor ELSE -amount_minor END
             ) FROM payment
               WHERE tenant_id = $1 AND status = 'POSTED'), 0)
           )::text AS cash_minor`,
          [context.tenantId]
        ),
        client.query<{
          sales_minor: string;
          gross_profit_minor: string;
        }>(
          `SELECT
             COALESCE(sum(o.total_minor), 0)::text AS sales_minor,
             COALESCE(sum(
               l.line_total_minor -
               ((l.cost_price_minor_snapshot * l.quantity_milli + 500) / 1000)
             ), 0)::text AS gross_profit_minor
           FROM sales_order o
           JOIN sales_order_line l
             ON l.tenant_id = o.tenant_id
            AND l.order_id = o.id
           WHERE o.tenant_id = $1
             AND o.order_status <> 'CANCELLED'
             AND o.created_at >= now() - interval '30 days'`,
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
           WHERE b.tenant_id = $1`,
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

  private money(value: string, currency: string): string {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }
}
