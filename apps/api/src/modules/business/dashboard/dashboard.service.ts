import { Injectable } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { OPERATIONAL_SCAN_LIMIT, VERTICAL_OPERATIONAL_RULES,
  VERTICAL_OPERATIONAL_RULE_BY_CODE } from "./vertical-operational-rules";

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

  async memberWorkspace(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const rolesResult = await client.query<{ code: string }>(
        `SELECT r.code
         FROM membership_role mr
         JOIN tenant_role r
           ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
         WHERE mr.tenant_id=$1 AND mr.membership_id=$2`,
        [context.tenantId, context.membershipId]
      );

      const roles = rolesResult.rows.map((row) => row.code);
      const has = (code: string) => roles.includes(code);
      // Workspaces are resolved from effective permissions, never only a role
      // title. Role membership can outlive a revoked or narrowed grant.
      const permissionRows=await client.query<{
        permission_code:string;scope:"own"|"team"|"branch"|"all";
      }>(
        `SELECT rp.permission_code,rp.scope
         FROM membership_role mr
         JOIN role_permission rp ON rp.tenant_id=mr.tenant_id
           AND rp.role_id=mr.role_id
         WHERE mr.tenant_id=$1 AND mr.membership_id=$2`,
        [context.tenantId,context.membershipId]
      );
      const grants=permissionRows.rows;
      const can=(code:string)=>grants.some(row=>
        row.permission_code==="*"||row.permission_code===code
      );
      const canSeeCompanyFinance=grants.some(row=>
        row.permission_code==="*"||
        (row.permission_code==="finance.read"&&row.scope==="all")
      );

      let workspace =
        has("WAREHOUSE")&&can("wms.read") ? "WAREHOUSE" :
        has("FINANCE")&&canSeeCompanyFinance ? "FINANCE" :
        has("PROCUREMENT")&&can("procurement.read") ? "PROCUREMENT" :
        has("SERVICE_STAFF")&&can("service.read") ? "SERVICE" :
        (has("SALES_HEAD")||has("SALES_MANAGER"))&&
          can("crm.read")&&can("sales.read")&&can("tasks.read") ? "SALES" :
        can("projects.read")&&can("tasks.read") ? "PROJECTS" :
        "VIEWER";

      const metrics: Array<{
        label: string;
        value: string;
        detail: string;
      }> = [];
      const actions: Array<{
        id: string;
        title: string;
        detail: string;
        href: string;
        severity: "INFO" | "WARNING" | "CRITICAL";
      }> = [];

      if (workspace === "SALES") {
        const [deals,tasks,orders] = await Promise.all([
          client.query<{ count: string; amount_minor: string }>(
            `SELECT count(*)::text AS count,
                    COALESCE(sum(d.amount_minor),0)::text AS amount_minor
             FROM crm_deal d
             JOIN crm_stage s
               ON s.tenant_id=d.tenant_id AND s.id=d.stage_id
             WHERE d.tenant_id=$1
               AND d.responsible_membership_id=$2
               AND s.kind='NORMAL'`,
            [context.tenantId, context.membershipId]
          ),
          client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM task
             WHERE tenant_id=$1
               AND responsible_membership_id=$2
               AND state IN ('OPEN','IN_PROGRESS','WAITING')`,
            [context.tenantId, context.membershipId]
          ),
          client.query<{ count: string; total_minor: string }>(
            `SELECT count(*)::text AS count,
                    COALESCE(sum(total_minor),0)::text AS total_minor
             FROM sales_order
             WHERE tenant_id=$1
               AND responsible_membership_id=$2
               AND order_status IN ('DRAFT','CONFIRMED')`,
            [context.tenantId, context.membershipId]
          )
        ]);

        metrics.push(
          {
            label: "Мои сделки",
            value: deals.rows[0]?.count ?? "0",
            detail: "Активная воронка"
          },
          {
            label: "Сумма сделок",
            value: this.money(deals.rows[0]?.amount_minor ?? "0","RUB"),
            detail: "Активные сделки"
          },
          {
            label: "Мои задачи",
            value: tasks.rows[0]?.count ?? "0",
            detail: "Открытые / в работе"
          },
          {
            label: "Мои заказы",
            value: orders.rows[0]?.count ?? "0",
            detail: this.money(orders.rows[0]?.total_minor ?? "0","RUB")
          }
        );

        const overdue = await client.query<{
          id: string;
          title: string;
          due_at: Date;
        }>(
          `SELECT id,title,due_at
           FROM task
           WHERE tenant_id=$1
             AND responsible_membership_id=$2
             AND state IN ('OPEN','IN_PROGRESS','WAITING')
             AND due_at < now()
           ORDER BY due_at
           LIMIT 20`,
          [context.tenantId, context.membershipId]
        );

        for (const row of overdue.rows) {
          actions.push({
            id: "task:" + row.id,
            title: row.title,
            detail: "Просрочено " + row.due_at.toLocaleString("ru-RU"),
            href: "/app/tasks?filter=overdue",
            severity: "CRITICAL"
          });
        }
      } else if (workspace === "SERVICE") {
        const [todayBookings,tasks] = await Promise.all([
          client.query<{ count: string }>(
            `SELECT count(DISTINCT b.id)::text AS count
             FROM service_booking b
             JOIN service_booking_resource br
               ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
             JOIN service_resource r
               ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
             WHERE b.tenant_id=$1
               AND r.membership_id=$2
               AND b.status NOT IN ('CANCELLED','NO_SHOW')
               AND (b.starts_at AT TIME ZONE coalesce(r.timezone,'Europe/Moscow'))::date
                 = (now() AT TIME ZONE coalesce(r.timezone,'Europe/Moscow'))::date
               AND NOT EXISTS(
                 SELECT 1 FROM dance_lesson l
                 WHERE l.tenant_id=b.tenant_id AND l.host_booking_id=b.id
               )`,
            [context.tenantId, context.membershipId]
          ),
          client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM task
             WHERE tenant_id=$1
               AND responsible_membership_id=$2
               AND state IN ('OPEN','IN_PROGRESS','WAITING')`,
            [context.tenantId, context.membershipId]
          )
        ]);

        metrics.push(
          {
            label: "Записи сегодня",
            value: todayBookings.rows[0]?.count ?? "0",
            detail: "Моё расписание"
          },
          {
            label: "Мои задачи",
            value: tasks.rows[0]?.count ?? "0",
            detail: "Открытые / в работе"
          }
        );

        const overdue=await client.query<{
          id:string;service:string;ends_at:Date;
        }>(
          `SELECT DISTINCT b.id,s.name AS service,b.ends_at
           FROM service_booking b
           JOIN service_booking_resource br
             ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
           JOIN service_resource r
             ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
           JOIN service_catalog_item s
             ON s.tenant_id=b.tenant_id AND s.id=b.service_id
           WHERE b.tenant_id=$1 AND r.membership_id=$2
             AND b.status IN ('CONFIRMED','ARRIVED','IN_SERVICE')
             AND b.ends_at<now()-interval '15 minutes'
             AND NOT EXISTS(SELECT 1 FROM dance_lesson l
               WHERE l.tenant_id=b.tenant_id AND l.host_booking_id=b.id)
           ORDER BY b.ends_at,b.id LIMIT 10`,
          [context.tenantId,context.membershipId]
        );
        metrics.push({
          label:"Незакрытые визиты",
          value:String(overdue.rows.length),
          detail:overdue.rows.length===10?"Не менее десяти визитов":"Нужна отметка завершения"
        });
        for(const row of overdue.rows){
          actions.push({
            id:"booking-overdue:"+row.id,
            title:"Закрыть визит · "+row.service,
            detail:"Завершён по времени: "+row.ends_at.toLocaleString("ru-RU"),
            href:"/app/service/bookings",
            severity:"WARNING"
          });
        }
        const upcoming = await client.query<{
          id: string;
          business_number: string;
          starts_at: Date;
          customer: string | null;
          service: string;
        }>(
          `SELECT DISTINCT
             b.id,b.business_number,b.starts_at,
             p.display_name AS customer,
             s.name AS service
           FROM service_booking b
           JOIN service_booking_resource br
             ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
           JOIN service_resource r
             ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
           JOIN service_catalog_item s
             ON s.tenant_id=b.tenant_id AND s.id=b.service_id
           LEFT JOIN party p
             ON p.tenant_id=b.tenant_id AND p.id=b.party_id
           WHERE b.tenant_id=$1
             AND r.membership_id=$2
             AND b.status IN ('CONFIRMED','ARRIVED','IN_SERVICE')
             AND b.starts_at >= now()
             AND NOT EXISTS(SELECT 1 FROM dance_lesson l
               WHERE l.tenant_id=b.tenant_id AND l.host_booking_id=b.id)
           ORDER BY b.starts_at
           LIMIT 20`,
          [context.tenantId, context.membershipId]
        );

        for (const row of upcoming.rows) {
          actions.push({
            id: "booking:" + row.id,
            title: row.service,
            detail:
              row.starts_at.toLocaleString("ru-RU") +
              " · " +
              (row.customer ?? "Клиент"),
            href: "/app/service/bookings",
            severity: "INFO"
          });
        }
      } else if (workspace === "PROJECTS") {
        // Internal agency/development assignments: never expose a client
        // portfolio to contractors merely because they have projects.read.
        const [projects,tasks,late]=await Promise.all([
          client.query<{count:string;overdue:string}>(
            `SELECT count(*)::text AS count,
               count(*) FILTER(WHERE due_on<current_date)::text AS overdue
             FROM work_project p
             WHERE p.tenant_id=$1 AND p.status IN ('PLANNED','ACTIVE','ON_HOLD')
               AND (p.responsible_membership_id=$2 OR EXISTS(
                 SELECT 1 FROM work_project_member m WHERE m.tenant_id=p.tenant_id
                   AND m.project_id=p.id AND m.membership_id=$2
                   AND m.status='ACTIVE'))`,
            [context.tenantId,context.membershipId]),
          client.query<{count:string}>(
            `SELECT count(*)::text AS count FROM task
             WHERE tenant_id=$1 AND responsible_membership_id=$2
               AND state IN ('OPEN','IN_PROGRESS','WAITING')`,
            [context.tenantId,context.membershipId]),
          client.query<{id:string;name:string;due_on:string}>(
            `SELECT p.id,p.name,p.due_on::text
             FROM work_project p
             WHERE p.tenant_id=$1 AND p.status IN ('PLANNED','ACTIVE','ON_HOLD')
               AND p.due_on<current_date
               AND (p.responsible_membership_id=$2 OR EXISTS(
                 SELECT 1 FROM work_project_member m WHERE m.tenant_id=p.tenant_id
                   AND m.project_id=p.id AND m.membership_id=$2
                   AND m.status='ACTIVE'))
             ORDER BY p.due_on,p.id LIMIT 15`,
            [context.tenantId,context.membershipId])
        ]);
        metrics.push(
          {label:"Мои проекты",value:projects.rows[0]?.count??"0",
            detail:"В работе и на согласовании"},
          {label:"Мои задачи",value:tasks.rows[0]?.count??"0",
            detail:"Открыто / в работе"},
          {label:"Просрочено проектов",value:projects.rows[0]?.overdue??"0",
            detail:"По согласованному сроку"}
        );
        for(const row of late.rows){
          actions.push({id:"project:"+row.id,title:row.name,
            detail:"Срок проекта: "+row.due_on,
            href:"/app/projects/"+row.id,severity:"WARNING"});
        }
      } else if (workspace === "WAREHOUSE") {
        const tasks = await client.query<{
          status: string;
          count: string;
        }>(
          `SELECT status,count(*)::text AS count
           FROM warehouse_task
           WHERE tenant_id=$1
             AND status NOT IN ('COMPLETED','CANCELLED')
             AND (
               assigned_membership_id=$2
               OR claimed_by_membership_id=$2
               OR (
                 assigned_membership_id IS NULL
                 AND claimed_by_membership_id IS NULL
               )
             )
           GROUP BY status`,
          [context.tenantId, context.membershipId]
        );

        const total = tasks.rows.reduce(
          (sum,row) => sum + Number(row.count),
          0
        );
        const failed = Number(
          tasks.rows.find((row) => row.status === "FAILED")?.count ?? "0"
        );

        metrics.push(
          {
            label: "Доступные задания",
            value: String(total),
            detail: "Назначенные и свободная очередь"
          },
          {
            label: "Проблемные",
            value: String(failed),
            detail: "Требуют разбора"
          }
        );

        actions.push({
          id: "wms-next",
          title: "Взять следующее складское задание",
          detail: "Scanner-first рабочее место",
          href: "/app/wms/mobile",
          severity: failed > 0 ? "WARNING" : "INFO"
        });
      } else if (workspace === "FINANCE") {
        const [obligations,bank] = await Promise.all([
          client.query<{
            direction: string;
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
          ),
          client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM finance_bank_statement_line l
             JOIN finance_bank_statement s
               ON s.tenant_id=l.tenant_id AND s.id=l.statement_id
             WHERE l.tenant_id=$1
               AND l.payment_id IS NULL
               AND s.status='IMPORTED'`,
            [context.tenantId]
          )
        ]);

        const ar = obligations.rows.find(
          (row) => row.direction === "RECEIVABLE"
        )?.amount_minor ?? "0";
        const ap = obligations.rows.find(
          (row) => row.direction === "PAYABLE"
        )?.amount_minor ?? "0";

        metrics.push(
          {
            label: "Дебиторка",
            value: this.money(ar,"RUB"),
            detail: "Открыто к получению"
          },
          {
            label: "Кредиторка",
            value: this.money(ap,"RUB"),
            detail: "Открыто к оплате"
          },
          {
            label: "Банк не сопоставлен",
            value: bank.rows[0]?.count ?? "0",
            detail: "Строк выписки"
          }
        );

        if (Number(bank.rows[0]?.count ?? "0") > 0) {
          actions.push({
            id: "bank-unmatched",
            title: "Сопоставить банковские операции",
            detail: bank.rows[0]!.count + " строк без payment",
            href: "/app/finance",
            severity: "WARNING"
          });
        }
      } else if (workspace === "PROCUREMENT") {
        const orders = await client.query<{
          count: string;
          total_minor: string;
          overdue: string;
        }>(
          `SELECT
             count(*)::text AS count,
             COALESCE(sum(total_minor),0)::text AS total_minor,
             count(*) FILTER (
               WHERE expected_at IS NOT NULL
                 AND expected_at < now()
             )::text AS overdue
           FROM purchase_order
           WHERE tenant_id=$1
             AND (
               responsible_membership_id=$2
               OR responsible_membership_id IS NULL
             )
             AND status IN ('DRAFT','CONFIRMED','PARTIALLY_RECEIVED')`,
          [context.tenantId, context.membershipId]
        );

        metrics.push(
          {
            label: "Закупки в работе",
            value: orders.rows[0]?.count ?? "0",
            detail: this.money(orders.rows[0]?.total_minor ?? "0","RUB")
          },
          {
            label: "Просрочено поставок",
            value: orders.rows[0]?.overdue ?? "0",
            detail: "Ожидаемая дата прошла"
          }
        );

        if (Number(orders.rows[0]?.overdue ?? "0") > 0) {
          actions.push({
            id: "purchase-overdue",
            title: "Проверить просроченные поставки",
            detail: orders.rows[0]!.overdue + " закупок",
            href: "/app/purchases",
            severity: "WARNING"
          });
        }
      }

      return {
        workspace,
        roles,
        title:
          workspace === "SALES" ? "Мои продажи" :
          workspace === "SERVICE" ? "Мой рабочий день" :
          workspace === "WAREHOUSE" ? "Мои складские задания" :
          workspace === "FINANCE" ? "Финансы сегодня" :
          workspace === "PROCUREMENT" ? "Закупки сегодня" :
          workspace === "PROJECTS" ? "Мои проекты и задачи" :
          "Моя работа",
        metrics,
        actions
      };
    });
  }

  async activation(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const profileResult = await client.query<{
        profile_code: "GENERAL" | "TRADE" | "ECOMMERCE" | "SERVICE" | "WAREHOUSE_3PL";
        vertical_code: string | null;
      }>(
        `SELECT
           COALESCE(
             (SELECT profile_code
              FROM tenant_business_profile
              WHERE tenant_id=$1),
             'GENERAL'
           ) AS profile_code,
           (SELECT vertical_code
            FROM tenant_business_vertical
            WHERE tenant_id=$1) AS vertical_code`,
        [context.tenantId]
      );

      const profile = profileResult.rows[0]?.profile_code ?? "GENERAL";
      const verticalCode = profileResult.rows[0]?.vertical_code ?? null;

      const counts = await Promise.all([
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM party
           WHERE tenant_id=$1 AND status='ACTIVE'`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM product
           WHERE tenant_id=$1 AND status='ACTIVE'`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM crm_deal
           WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM sales_order
           WHERE tenant_id=$1
             AND order_status IN ('CONFIRMED','COMPLETED')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM service_booking
           WHERE tenant_id=$1
             AND status NOT IN ('DRAFT','CANCELLED')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM site_page_version v
           JOIN site_page p
             ON p.tenant_id=v.tenant_id AND p.id=v.page_id
           WHERE v.tenant_id=$1
             AND v.status='PUBLISHED'
             AND p.status='ACTIVE'`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM service_catalog_item
           WHERE tenant_id=$1 AND status='ACTIVE'`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM channel_connection
           WHERE tenant_id=$1 AND status='ACTIVE'`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM wms_task
           WHERE tenant_id=$1
             AND status IN ('READY','ASSIGNED','IN_PROGRESS','DONE')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM migration_batch
           WHERE tenant_id=$1
             AND status IN ('IMPORTED','RECONCILED')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM task
           WHERE tenant_id=$1
             AND state IN ('OPEN','IN_PROGRESS','WAITING','DONE')`,
          [context.tenantId]
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM work_project
           WHERE tenant_id=$1
             AND status IN ('PLANNED','ACTIVE','ON_HOLD','COMPLETED')`,
          [context.tenantId]
        )
      ]);

      const values = {
        party: Number(counts[0].rows[0]?.count ?? "0"),
        product: Number(counts[1].rows[0]?.count ?? "0"),
        deal: Number(counts[2].rows[0]?.count ?? "0"),
        order: Number(counts[3].rows[0]?.count ?? "0"),
        booking: Number(counts[4].rows[0]?.count ?? "0"),
        site: Number(counts[5].rows[0]?.count ?? "0"),
        service: Number(counts[6].rows[0]?.count ?? "0"),
        channel: Number(counts[7].rows[0]?.count ?? "0"),
        wmsTask: Number(counts[8].rows[0]?.count ?? "0"),
        migration: Number(counts[9].rows[0]?.count ?? "0"),
        task: Number(counts[10].rows[0]?.count ?? "0"),
        project: Number(counts[11].rows[0]?.count ?? "0")
      };

      const definitions: Record<string, Array<{
        key: string;
        title: string;
        detail: string;
        href: string;
        done: boolean;
        firstValue?: boolean;
      }>> = {
        GENERAL: [
          {
            key: "party",
            title: "Добавьте клиента или контрагента",
            detail: "Единая карточка станет основой CRM, заказов и финансов.",
            href: "/app/crm/deals",
            done: values.party > 0
          },
          {
            key: "product",
            title: "Добавьте товар или услугу",
            detail: "Каталог нужен для заказов, себестоимости и аналитики.",
            href: "/app/catalog/products",
            done: values.product > 0 || values.service > 0
          },
          {
            key: "first-operation",
            title: "Проведите первую реальную операцию",
            detail: "Подтвердите заказ, создайте запись клиента или начните сделку.",
            href: "/app",
            done: values.order > 0 || values.booking > 0 || values.deal > 0,
            firstValue: true
          }
        ],
        TRADE: [
          {
            key: "product",
            title: "Загрузите или добавьте ассортимент",
            detail: "Начните с реальных SKU, цен и себестоимости.",
            href: "/app/catalog/products",
            done: values.product > 0
          },
          {
            key: "party",
            title: "Добавьте первого клиента",
            detail: "Клиент будет связан с заказами и оплатами.",
            href: "/app/crm/deals",
            done: values.party > 0
          },
          {
            key: "order",
            title: "Подтвердите первый заказ",
            detail: "Система начнёт показывать продажи, деньги и обязательства.",
            href: "/app/sales/orders",
            done: values.order > 0,
            firstValue: true
          }
        ],
        ECOMMERCE: [
          {
            key: "product",
            title: "Подготовьте каталог",
            detail: "Товары, цены и SKU используются сайтом и маркетплейсами.",
            href: "/app/catalog/products",
            done: values.product > 0
          },
          {
            key: "site-channel",
            title: "Подключите канал продаж или опубликуйте сайт",
            detail: "Можно начать с собственного магазина, Ozon или Wildberries.",
            href: values.site > 0 ? "/app/channels" : "/app/sites",
            done: values.site > 0 || values.channel > 0
          },
          {
            key: "order",
            title: "Получите и подтвердите первый заказ",
            detail: "После этого включаются OMS, прибыльность и платёжный контур.",
            href: "/app/sales/orders",
            done: values.order > 0,
            firstValue: true
          }
        ],
        SERVICE: [
          {
            key: "service",
            title: "Добавьте услугу",
            detail: "Укажите длительность и цену, чтобы открыть расписание.",
            href: "/app/service",
            done: values.service > 0
          },
          {
            key: "party",
            title: "Добавьте первого клиента",
            detail: "История записей и продаж будет храниться в одной карточке.",
            href: "/app/service/bookings",
            done: values.party > 0
          },
          {
            key: "booking",
            title: "Создайте первую запись клиента",
            detail: "Это первая ценность сервисного рабочего места.",
            href: "/app/service/bookings",
            done: values.booking > 0,
            firstValue: true
          }
        ],
        WAREHOUSE_3PL: [
          {
            key: "product",
            title: "Загрузите SKU",
            detail: "Складские задания всегда работают с единым каталогом.",
            href: "/app/catalog/products",
            done: values.product > 0
          },
          {
            key: "migration",
            title: "Загрузите остатки или начальные данные",
            detail: "Используйте Migration Center или фактическую приёмку.",
            href: "/app/inventory/stock",
            done: values.migration > 0 || values.wmsTask > 0
          },
          {
            key: "wms-task",
            title: "Запустите первое складское задание",
            detail: "После этого склад работает через task-driven контур.",
            href: "/app/wms",
            done: values.wmsTask > 0,
            firstValue: true
          }
        ]
      };

      if (profile === "SERVICE" && verticalCode === "PROFESSIONAL_SERVICES") {
        definitions.SERVICE = [
          {
            key: "party",
            title: "Добавьте первого клиента",
            detail: "Карточка клиента объединит сделки, задачи и расчёты.",
            href: "/app/crm/deals",
            done: values.party > 0
          },
          {
            key: "deal",
            title: "Зафиксируйте клиентскую сделку",
            detail: "Сделка хранит договорённость до передачи в исполнение.",
            href: "/app/crm/deals",
            done: values.deal > 0
          },
          {
            key: "project",
            title: "Запустите клиентский проект",
            detail: "Проект связывает договорённость, этапы, сроки, бюджет и трудозатраты.",
            href: "/app/projects",
            done: values.project > 0
          },
          {
            key: "next-action",
            title: "Поставьте первую задачу по проекту",
            detail: "Исполнение должно иметь конкретное следующее действие.",
            href: "/app/tasks",
            done: values.project > 0 && values.task > 0,
            firstValue: true
          }
        ];
      }

      if (profile === "ECOMMERCE" && verticalCode === "ECOMMERCE_STORE") {
        definitions.ECOMMERCE = [
          {
            key: "product",
            title: "Подготовьте каталог",
            detail: "Товары, цены и SKU используются витриной, заказами и складом.",
            href: "/app/catalog/products",
            done: values.product > 0
          },
          {
            key: "site",
            title: "Опубликуйте интернет-магазин",
            detail: "Для собственного e-commerce первым каналом должна быть опубликованная витрина.",
            href: "/app/sites",
            done: values.site > 0
          },
          {
            key: "order",
            title: "Получите и подтвердите первый заказ",
            detail: "После заказа включается сквозной OMS/склад/финансовый сценарий.",
            href: "/app/sales/orders",
            done: values.order > 0,
            firstValue: true
          }
        ];
      }

      if (profile === "ECOMMERCE" && verticalCode === "MARKETPLACE_SELLER") {
        definitions.ECOMMERCE = [
          {
            key: "product",
            title: "Подготовьте единый каталог SKU",
            detail: "Внутренний SKU нужен для сопоставления Ozon/Wildberries и остатков.",
            href: "/app/catalog/products",
            done: values.product > 0
          },
          {
            key: "channel",
            title: "Подключите маркетплейс",
            detail: "Для этого профиля сайт не заменяет рабочее подключение канала.",
            href: "/app/channels",
            done: values.channel > 0
          },
          {
            key: "order",
            title: "Получите первый заказ из канала",
            detail: "Заказ подтверждает работу цепочки channel inbox → OMS → ERP.",
            href: "/app/sales/orders",
            done: values.order > 0,
            firstValue: true
          }
        ];
      }

      // First-day steps must reflect the selected VERTICAL, not just the
      // generic SERVICE or TRADE profile. Counts represent persisted domain
      // events, not clicks, claims of readiness or generated demo records.
      if (verticalCode === "DANCE_FITNESS") {
        const r=await client.query<{
          services:number;trainers:number;programs:number;groups:number;
          students:number;plans:number;lessons:number;payroll:number;
        }>(
          `SELECT
             (SELECT count(*)::integer FROM service_catalog_item
              WHERE tenant_id=$1 AND status='ACTIVE') AS services,
             (SELECT count(*)::integer FROM service_resource
              WHERE tenant_id=$1 AND type='EMPLOYEE' AND status='ACTIVE') AS trainers,
             (SELECT count(*)::integer FROM dance_program
              WHERE tenant_id=$1 AND status='ACTIVE') AS programs,
             (SELECT count(*)::integer FROM dance_group
              WHERE tenant_id=$1 AND status='ACTIVE') AS groups,
             (SELECT count(*)::integer FROM dance_student
              WHERE tenant_id=$1 AND status IN ('LEAD','TRIAL','ACTIVE')) AS students,
             (SELECT count(*)::integer FROM service_package_plan
              WHERE tenant_id=$1 AND status='ACTIVE') AS plans,
             (SELECT count(*)::integer FROM dance_lesson
              WHERE tenant_id=$1 AND status IN ('PLANNED','OPEN_FOR_BOOKING','COMPLETED')) AS lessons,
             (SELECT count(*)::integer FROM trainer_payroll_profile
              WHERE tenant_id=$1 AND status='ACTIVE') AS payroll`,
          [context.tenantId]
        );
        const d=r.rows[0]!;
        definitions.SERVICE=[
          {key:"dance-service",title:"Укажите услугу, цену и длительность",
            detail:"Направление танцев нельзя создать без услуги. Начните с этого шага.",
            href:"/app/dance/setup",done:d.services>0},
          {key:"dance-trainer",title:"Добавьте тренера",
            detail:"Тренер нужен для расписания и расчёта начислений.",
            href:"/app/dance/setup",done:d.trainers>0},
          {key:"dance-program",title:"Создайте направление",
            detail:"Например: хип-хоп, балет или индивидуальные занятия.",
            href:"/app/dance/groups",done:d.programs>0},
          {key:"dance-group",title:"Создайте группу и назначьте тренера",
            detail:"Укажите вместимость, дни и время занятий.",
            href:"/app/dance/groups",done:d.groups>0},
          {key:"dance-student",title:"Добавьте ученика и плательщика",
            detail:"Привяжите родителя, чтобы вести абонементы и задолженности.",
            href:"/app/dance/students",done:d.students>0},
          {key:"dance-plan",title:"Создайте абонемент",
            detail:"Зафиксируйте число занятий, стоимость и срок действия.",
            href:"/app/dance/students",done:d.plans>0},
          {key:"dance-lesson",title:"Сформируйте первое занятие",
            detail:"После этого появятся участники, посещаемость и расчёты.",
            href:"/app/dance/groups",done:d.lessons>0,firstValue:true},
          {key:"dance-payroll",title:"Определите оплату тренера",
            detail:"Оклад, ставка или процент; не обещайте начисление без правила.",
            href:"/app/dance/team",done:d.payroll>0}
        ];
      }

      if (verticalCode === "AUTO_SERVICE" ||
          verticalCode === "AUTO_PARTS_DISMANTLING") {
        const r=await client.query<{
          vehicles:number;orders:number;donors:number;parts:number;
          completed:number;
        }>(
          `SELECT
             (SELECT count(*)::integer FROM automotive_vehicle
               WHERE tenant_id=$1 AND status='ACTIVE') AS vehicles,
             (SELECT count(*)::integer FROM automotive_work_order
               WHERE tenant_id=$1 AND status<>'CANCELLED') AS orders,
             (SELECT count(*)::integer FROM automotive_donor_vehicle
               WHERE tenant_id=$1 AND status<>'ARCHIVED') AS donors,
             (SELECT count(*)::integer FROM automotive_dismantled_part
               WHERE tenant_id=$1 AND status<>'ARCHIVED') AS parts,
             (SELECT count(*)::integer FROM automotive_work_order
               WHERE tenant_id=$1 AND status='DELIVERED') AS completed`,
          [context.tenantId]
        );
        const a=r.rows[0]!;
        if (verticalCode==="AUTO_SERVICE") {
          definitions.SERVICE=[
            {key:"auto-client",title:"Добавьте клиента",
              detail:"Начните с владельца автомобиля и контактных данных.",
              href:"/app/crm/customers",done:values.party>0},
            {key:"auto-vehicle",title:"Создайте карточку автомобиля",
              detail:"VIN, госномер, пробег и привязка к владельцу.",
              href:"/app/automotive",done:a.vehicles>0},
            {key:"auto-order",title:"Откройте заказ-наряд",
              detail:"Запишите жалобу клиента и согласуйте работы и запчасти.",
              href:"/app/automotive",done:a.orders>0,firstValue:true},
            {key:"auto-delivery",title:"Завершите ремонт и выдачу",
              detail:"Проверьте выполненные работы, сумму и статус выдачи.",
              href:"/app/automotive",done:a.completed>0}
          ];
        } else {
          definitions.TRADE=[
            {key:"donor",title:"Примите автомобиль-донор",
              detail:"Укажите себестоимость покупки, VIN и номер донора.",
              href:"/app/automotive",done:a.donors>0},
            {key:"part",title:"Добавьте снятую деталь",
              detail:"OEM, состояние и распределённую себестоимость.",
              href:"/app/automotive",done:a.parts>0,firstValue:true},
            {key:"sale",title:"Проведите первую продажу",
              detail:"Продажа должна уменьшить остаток и показать маржу.",
              href:"/app/sales/orders",done:values.order>0}
          ];
        }
      }

      if (["WEB_STUDIO","WEB_MARKETING_AGENCY","MARKETING_AGENCY",
          "PROFESSIONAL_SERVICES"].includes(verticalCode??"")) {
        definitions.SERVICE=[
          {key:"agency-client",title:"Создайте клиента",
            detail:"Карточка клиента объединяет сделки, проекты и задолженности.",
            href:"/app/crm/customers",done:values.party>0},
          {key:"agency-deal",title:"Создайте коммерческую сделку",
            detail:"Зафиксируйте услугу, бюджет и ожидаемый срок.",
            href:"/app/crm/deals",done:values.deal>0},
          {key:"agency-project",title:"Создайте проект",
            detail:"Свяжите обязательства, бюджет и этапы работ.",
            href:"/app/projects",done:values.project>0,firstValue:true},
          {key:"agency-task",title:"Назначьте первую задачу",
            detail:"Исполнение начинается со срока и ответственного.",
            href:"/app/tasks",done:values.task>0}
        ];
      }

      if (["BEAUTY_SALON","BARBERSHOP","NAIL_SALON"].includes(verticalCode??"")) {
        const resources=await client.query<{count:number}>(
          `SELECT count(*)::integer AS count FROM service_resource
           WHERE tenant_id=$1 AND type='EMPLOYEE' AND status='ACTIVE'`,
          [context.tenantId]
        );
        definitions.SERVICE=[
          {key:"salon-master",title:"Добавьте мастера и график",
            detail:"Без мастера нельзя корректно показывать свободные окна.",
            href:"/app/service/setup",done:(resources.rows[0]?.count??0)>0},
          {key:"salon-service",title:"Укажите услуги и персональные цены",
            detail:"Добавьте длительность и стоимость для работы записи.",
            href:"/app/service/setup",done:values.service>0},
          {key:"salon-client",title:"Добавьте первого клиента",
            detail:"Контакты понадобятся для подтверждений и повторных визитов.",
            href:"/app/crm/customers",done:values.party>0},
          {key:"salon-booking",title:"Создайте первую запись",
            detail:"Убедитесь, что мастер доступен, затем подтвердите время.",
            href:"/app/service/bookings",done:values.booking>0,firstValue:true}
        ];
      }

      if (verticalCode === "WAREHOUSE_3PL") {
        const extra=await client.query<{done:number;owners:number}>(
          `SELECT
             (SELECT count(*)::integer FROM wms_task
              WHERE tenant_id=$1 AND status='DONE') AS done,
             (SELECT count(*)::integer FROM inventory_owner
              WHERE tenant_id=$1 AND status='ACTIVE' AND owner_type='CLIENT') AS owners`,
          [context.tenantId]
        );
        definitions.WAREHOUSE_3PL=[
          {key:"owner",title:"Добавьте клиента-владельца товара",
            detail:"Товар клиентов должен храниться раздельно по владельцам.",
            href:"/app/wms/owners",done:(extra.rows[0]?.owners??0)>0},
          {key:"sku",title:"Загрузите номенклатуру",
            detail:"SKU используются для приёмки и адресного хранения.",
            href:"/app/catalog/products",done:values.product>0},
          {key:"task",title:"Создайте складское задание",
            detail:"Готовое задание можно назначить и выполнить на ТСД.",
            href:"/app/wms",done:values.wmsTask>0},
          {key:"task-done",title:"Завершите реальное складское задание",
            detail:"Только статус DONE подтверждает первый складской сценарий.",
            href:"/app/wms/mobile",done:(extra.rows[0]?.done??0)>0,firstValue:true}
        ];
      }

      if (verticalCode === "ECOMMERCE_STORE") {
        const launched=await client.query<{published:number}>(
          `SELECT count(DISTINCT s.id)::integer AS published
           FROM site s
           JOIN storefront_config sc
             ON sc.tenant_id=s.tenant_id AND sc.site_id=s.id AND sc.enabled
           JOIN site_page p
             ON p.tenant_id=s.tenant_id AND p.site_id=s.id
             AND p.slug='/' AND p.status='ACTIVE'
           JOIN site_page_version v
             ON v.tenant_id=p.tenant_id AND v.id=p.published_version_id
             AND v.status='PUBLISHED'
           WHERE s.tenant_id=$1 AND s.status='ACTIVE'`,
          [context.tenantId]
        );
        definitions.ECOMMERCE=[
          {key:"shop-product",title:"Добавьте товары с реальными ценами",
            detail:"Карточка товара и SKU формируют витрину и складской учёт.",
            href:"/app/catalog/products",done:values.product>0},
          {key:"shop-site",title:"Опубликуйте интернет-магазин",
            detail:"Нужна опубликованная главная и включённая витрина.",
            href:"/app/sites",done:(launched.rows[0]?.published??0)>0},
          {key:"shop-payment",title:"Настройте получение и эквайринг",
            detail:"Самовывоз или курьер, свои реквизиты YooKassa и ККТ.",
            href:"/app/sites/payments",done:false},
          {key:"shop-order",title:"Получите первый подтверждённый заказ",
            detail:"Проверьте резерв, платёж и доставку на тестовом стенде.",
            href:"/app/commerce",done:values.order>0,firstValue:true}
        ];
        const config=await client.query<{configured:number}>(
          `SELECT count(*)::integer AS configured
           FROM commerce_merchant_config c
           WHERE c.tenant_id=$1 AND c.enabled AND c.fiscal_enabled
             AND EXISTS(
               SELECT 1 FROM commerce_delivery_method d
               WHERE d.tenant_id=c.tenant_id AND d.site_id=c.site_id AND d.active
             )`,
          [context.tenantId]
        );
        definitions.ECOMMERCE[2]!.done=(config.rows[0]?.configured??0)>0;
      }

      if(verticalCode==="RETAIL_STORE"){
        const result=await client.query<{stock:number}>(
          `SELECT count(*)::integer AS stock FROM inventory_balance b
           JOIN warehouse w ON w.tenant_id=b.tenant_id
             AND w.id=b.warehouse_id AND w.status='ACTIVE'
           WHERE b.tenant_id=$1 AND b.physical_milli>b.reserved_milli`,
          [context.tenantId]
        );
        definitions.TRADE=[
          {key:"retail-product",title:"Добавьте товар с ценой",
            detail:"Артикул, себестоимость и цена нужны для расчёта маржи.",
            href:"/app/catalog/products",done:values.product>0},
          {key:"retail-stock",title:"Примите первый товар на склад",
            detail:"Сначала создайте склад и проведите приход, а не рисуйте остаток.",
            href:"/app/inventory/stock",done:(result.rows[0]?.stock??0)>0},
          {key:"retail-order",title:"Продайте первый товар",
            detail:"Подтвердите заказ и проверьте резерв и движение денег.",
            href:"/app/sales/orders",done:values.order>0,firstValue:true}
        ];
      }

      if(verticalCode==="WHOLESALE_B2B"){
        const result=await client.query<{terms:number}>(
          `SELECT count(*)::integer AS terms FROM party_commercial_terms
           WHERE tenant_id=$1`,[context.tenantId]);
        definitions.TRADE=[
          {key:"b2b-client",title:"Добавьте компанию-клиента",
            detail:"Контрагент станет владельцем договора, заказа и задолженности.",
            href:"/app/crm/customers",done:values.party>0},
          {key:"b2b-terms",title:"Определите договорные условия",
            detail:"Валюта, срок оплаты, скидка и кредитный лимит.",
            href:"/app/crm/customers",done:(result.rows[0]?.terms??0)>0},
          {key:"b2b-product",title:"Создайте прайс и номенклатуру",
            detail:"Для клиента можно настроить персональную цену по SKU.",
            href:"/app/catalog/products",done:values.product>0},
          {key:"b2b-order",title:"Подтвердите первый оптовый заказ",
            detail:"После подтверждения появляются дебиторка и обеспеченность.",
            href:"/app/sales/orders",done:values.order>0,firstValue:true}
        ];
      }

      if(verticalCode==="MARKETPLACE_SELLER"){
        const result=await client.query<{mapped:number}>(
          `SELECT count(*)::integer AS mapped FROM channel_product_mapping
           WHERE tenant_id=$1`,[context.tenantId]);
        definitions.ECOMMERCE=[
          {key:"market-sku",title:"Загрузите товары и SKU",
            detail:"Один внутренний SKU используется для склада и всех каналов.",
            href:"/app/catalog/products",done:values.product>0},
          {key:"market-account",title:"Подключите Ozon или Wildberries",
            detail:"Активное подключение ещё не подтверждает успешный обмен.",
            href:"/app/channels",done:values.channel>0},
          {key:"market-mapping",title:"Сопоставьте артикулы продавца с SKU",
            detail:"Без соответствий канал не может надёжно обновлять остатки.",
            href:"/app/ecommerce",done:(result.rows[0]?.mapped??0)>0},
          {key:"market-order",title:"Получите реальный заказ из канала",
            detail:"Проверьте источник и OMS; ручной заказ не равен синхронизации.",
            href:"/app/oms",done:false,firstValue:true}
        ];
        const imported=await client.query<{orders:number}>(
          `SELECT count(*)::integer AS orders FROM channel_order_inbox
           WHERE tenant_id=$1 AND sales_order_id IS NOT NULL`,
          [context.tenantId]
        );
        definitions.ECOMMERCE[3]!.done=(imported.rows[0]?.orders??0)>0;
      }

      const milestones = definitions[profile] ?? definitions.GENERAL;
      const firstValueDone = milestones.some(
        (item) => item.firstValue && item.done
      );
      const completed = milestones.every((item) => item.done);

      const stateResult = await client.query<{
        first_seen_at: Date;
        first_value_at: Date | null;
        completed_at: Date | null;
        dismissed_at: Date | null;
      }>(
        `SELECT first_seen_at,first_value_at,completed_at,dismissed_at
         FROM tenant_activation_state
         WHERE tenant_id=$1
         FOR UPDATE`,
        [context.tenantId]
      );

      if (!stateResult.rows[0]) {
        await client.query(
          `INSERT INTO tenant_activation_state(tenant_id)
           VALUES ($1)
           ON CONFLICT DO NOTHING`,
          [context.tenantId]
        );
      }

      const state = stateResult.rows[0] ?? {
        first_seen_at: new Date(),
        first_value_at: null,
        completed_at: null,
        dismissed_at: null
      };

      const firstValueAt =
        state.first_value_at ??
        (firstValueDone ? new Date() : null);
      const completedAt =
        state.completed_at ??
        (completed && firstValueAt ? new Date() : null);

      if (
        firstValueAt !== state.first_value_at ||
        completedAt !== state.completed_at
      ) {
        await client.query(
          `UPDATE tenant_activation_state
           SET first_value_at=COALESCE(first_value_at,$2),
               completed_at=COALESCE(completed_at,$3),
               updated_at=now()
           WHERE tenant_id=$1`,
          [context.tenantId, firstValueAt, completedAt]
        );
      }

      const doneCount = milestones.filter((item) => item.done).length;
      const ttfvMinutes = firstValueAt
        ? Math.max(
            0,
            Math.round(
              (firstValueAt.getTime() - state.first_seen_at.getTime()) / 60000
            )
          )
        : null;

      return {
        profile,
        verticalCode,
        dismissed: Boolean(state.dismissed_at),
        completed,
        progressPercent:
          milestones.length === 0
            ? 100
            : Math.round((doneCount / milestones.length) * 100),
        doneCount,
        total: milestones.length,
        firstSeenAt: state.first_seen_at.toISOString(),
        firstValueAt: firstValueAt?.toISOString() ?? null,
        timeToFirstValueMinutes: ttfvMinutes,
        milestones
      };
    });
  }

  async dismissActivation(
    context: TenantContext,
    dismissed: boolean
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO tenant_activation_state(
           tenant_id,dismissed_at,updated_at
         ) VALUES ($1,CASE WHEN $2 THEN now() ELSE NULL END,now())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           dismissed_at=CASE WHEN $2 THEN now() ELSE NULL END,
           updated_at=now()`,
        [context.tenantId, dismissed]
      );
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

      const truncatedRules=new Set<string>();
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
           AND s.status='IMPORTED'
         ORDER BY l.id
         LIMIT 201`,
        [context.tenantId]
      );
      if(unmatched.rows.length>OPERATIONAL_SCAN_LIMIT)
        truncatedRules.add("BANK_UNMATCHED");
      for (const row of unmatched.rows.slice(0,OPERATIONAL_SCAN_LIMIT)) {
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
           )
         ORDER BY d.id
         LIMIT 201`,
        [context.tenantId]
      );
      if(vat.rows.length>OPERATIONAL_SCAN_LIMIT)
        truncatedRules.add("VAT_UNREGISTERED");
      for (const row of vat.rows.slice(0,OPERATIONAL_SCAN_LIMIT)) {
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
           )
         ORDER BY p.id
         LIMIT 201`,
        [context.tenantId]
      );
      if(close.rows.length>OPERATIONAL_SCAN_LIMIT)
        truncatedRules.add("CLOSE_BLOCKED");
      for (const row of close.rows.slice(0,OPERATIONAL_SCAN_LIMIT)) {
        currentIssues.get("CLOSE_BLOCKED")!.add(row.id);
      }

      const payroll = await client.query<{ id: string }>(
        `SELECT id
         FROM payroll_accrual_batch
         WHERE tenant_id=$1 AND status='DRAFT'
         ORDER BY id
         LIMIT 201`,
        [context.tenantId]
      );
      if(payroll.rows.length>OPERATIONAL_SCAN_LIMIT)
        truncatedRules.add("PAYROLL_DRAFT");
      for (const row of payroll.rows.slice(0,OPERATIONAL_SCAN_LIMIT)) {
        currentIssues.get("PAYROLL_DRAFT")!.add(row.id);
      }

      // Covers all installed verticals via their real domain events and
      // transaction states, not synthetic "ready" percentages. Scans include
      // a sentinel row to avoid falsely resolving issues in large tenants.
      for(const rule of VERTICAL_OPERATIONAL_RULES){
        const found=await client.query<{id:string}>(rule.sql,[context.tenantId]);
        if(found.rows.length>OPERATIONAL_SCAN_LIMIT)
          truncatedRules.add(rule.code);
        currentIssues.set(rule.code,
          new Set(found.rows.slice(0,OPERATIONAL_SCAN_LIMIT).map(row=>row.id)));
      }

      for(const [issueCode,ids] of currentIssues){
        const idArray=Array.from(ids);
        if(idArray.length){
          // One statement per issue class, not 200 individual round trips.
          await client.query(
            `INSERT INTO tenant_operational_issue(
               tenant_id,issue_code,reference_id,state
             ) SELECT $1,$2,ids.id,'OPEN' FROM unnest($3::uuid[]) AS ids(id)
             ON CONFLICT(tenant_id,issue_code,reference_id)
             DO UPDATE SET state='OPEN',resolved_at=NULL`,
            [context.tenantId,issueCode,idArray]
          );
        }
        if(truncatedRules.has(issueCode))continue;
        await client.query(
          `UPDATE tenant_operational_issue
           SET state='RESOLVED',resolved_at=now()
           WHERE tenant_id=$1 AND issue_code=$2 AND state='OPEN'
             AND (cardinality($3::uuid[])=0
               OR reference_id<>ALL($3::uuid[]))`,
          [context.tenantId,issueCode,idArray]
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

      const issueTotal=await client.query<{count:number}>(
        `SELECT count(*)::integer AS count FROM tenant_operational_issue
         WHERE tenant_id=$1 AND state='OPEN'`,
        [context.tenantId]
      );
      const incompleteScans=Array.from(truncatedRules).sort();

      const href: Record<string, string> = {
        BANK_UNMATCHED: "/app/finance",
        VAT_UNREGISTERED: "/app/accounting",
        CLOSE_BLOCKED: "/app/accounting",
        PAYROLL_DRAFT: "/app/accounting",
        ...Object.fromEntries(VERTICAL_OPERATIONAL_RULES.map(rule=>[
          rule.code,rule.href
        ]))
      };

      return {
        generatedAt: new Date().toISOString(),
        issuesTotal:issueTotal.rows[0]?.count??0,
        resultsLimited:(issueTotal.rows[0]?.count??0)>issues.rows.length,
        incompleteScans,
        snapshots: snapshots.rows,
        issues: issues.rows.map((issue) => ({
          id: issue.id,
          code: issue.issue_code,
          referenceId: issue.reference_id,
          firstSeenAt: issue.first_seen_at.toISOString(),
          href: href[issue.issue_code] ?? "/app",
          title: VERTICAL_OPERATIONAL_RULE_BY_CODE.get(issue.issue_code)?.label
            ?? issue.issue_code,
          severity: VERTICAL_OPERATIONAL_RULE_BY_CODE.get(issue.issue_code)?.severity
            ?? (["CLOSE_BLOCKED","VAT_UNREGISTERED"].includes(issue.issue_code)
              ? "CRITICAL" : "WARNING"),
          domain: VERTICAL_OPERATIONAL_RULE_BY_CODE.get(issue.issue_code)?.domain
            ?? "ACCOUNTING",
          explanation: VERTICAL_OPERATIONAL_RULE_BY_CODE.get(issue.issue_code)?.explanation
            ?? "Откройте раздел и устраните причину проблемы"
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
