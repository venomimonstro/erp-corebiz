/**
 * The same exception scan serves every vertical. Each check is bounded,
 * tenant-scoped and produces stable UUID references so open issues can
 * recover automatically when operators fix the underlying business object.
 */
export type VerticalOperationalRule={
  code:string;domain:string;label:string;severity:"WARNING"|"CRITICAL";
  href:string;explanation:string;permission:string;sql:string;
};
/** Hard cap + sentinel; never resolve issues outside a truncated scan. */
export const OPERATIONAL_SCAN_LIMIT=200;
export const VERTICAL_OPERATIONAL_RULES:readonly VerticalOperationalRule[]=[
  {
    code:"SALES_UNFULFILLED",domain:"TRADE",label:"Заказы ждут отгрузки",
    severity:"WARNING",href:"/app/sales/orders",
    explanation:"Заказ подтверждён более трёх дней назад, но исполнение не завершено",
    permission:"sales.read",
    sql:`SELECT id FROM sales_order
      WHERE tenant_id=$1 AND order_status='CONFIRMED'
        AND fulfillment_status NOT IN ('SHIPPED','CANCELLED')
        AND confirmed_at<now()-interval '3 days'
      ORDER BY confirmed_at,id LIMIT 201`
  },
  {
    code:"PROCUREMENT_OVERDUE",domain:"PROCUREMENT",label:"Поставки просрочены",
    severity:"WARNING",href:"/app/purchases",
    explanation:"Поставщик не закрыл ожидаемую поставку к согласованной дате",
    permission:"procurement.read",
    sql:`SELECT id FROM purchase_order
      WHERE tenant_id=$1 AND status IN ('CONFIRMED','PARTIALLY_RECEIVED')
        AND expected_at IS NOT NULL AND expected_at<now()
      ORDER BY expected_at,id LIMIT 201`
  },
  {
    code:"SERVICE_UNCLOSED",domain:"SERVICE",label:"Визиты не закрыты",
    severity:"WARNING",href:"/app/service/bookings",
    explanation:"Время записи прошло; завершите визит или оформите неявку/отмену",
    permission:"service.read",
    sql:`SELECT b.id FROM service_booking b
      WHERE b.tenant_id=$1 AND b.status IN ('CONFIRMED','ARRIVED','IN_SERVICE')
        AND b.ends_at<now()-interval '6 hours'
        AND NOT EXISTS (SELECT 1 FROM dance_lesson l
          WHERE l.tenant_id=b.tenant_id AND l.host_booking_id=b.id)
      ORDER BY b.ends_at,b.id LIMIT 201`
  },
  {
    code:"DANCE_UNCLOSED",domain:"DANCE",label:"Уроки не закрыты",
    severity:"WARNING",href:"/app/dance/groups",
    explanation:"Занятие уже завершилось, но посещения и расчёт ещё не закрыты",
    permission:"dance.read",
    sql:`SELECT id FROM dance_lesson WHERE tenant_id=$1
        AND status IN ('PLANNED','OPEN_FOR_BOOKING','STARTED')
        AND ends_at<now()-interval '2 hours'
      ORDER BY ends_at,id LIMIT 201`
  },
  {
    code:"DANCE_MISSING_MARGIN",domain:"DANCE",label:"Уроки без экономики",
    severity:"CRITICAL",href:"/app/dance/team",
    explanation:"Закрытый урок не имеет зафиксированной себестоимости и выручки",
    permission:"finance.read",
    sql:`SELECT l.id FROM dance_lesson l
      WHERE l.tenant_id=$1 AND l.status='COMPLETED'
        AND NOT EXISTS(SELECT 1 FROM dance_lesson_profitability p
          WHERE p.tenant_id=l.tenant_id AND p.lesson_id=l.id)
      ORDER BY l.ends_at,l.id LIMIT 201`
  },
  {
    code:"AUTOMOTIVE_OVERDUE",domain:"AUTOMOTIVE",label:"Просроченные заказ-наряды",
    severity:"CRITICAL",href:"/app/automotive",
    explanation:"Автомобиль не выдан к обещанной дате: проверьте запчасти и согласование",
    permission:"service.read",
    sql:`SELECT id FROM automotive_work_order
      WHERE tenant_id=$1 AND status NOT IN ('DELIVERED','CANCELLED')
        AND promised_at IS NOT NULL AND promised_at<now()
      ORDER BY promised_at,id LIMIT 201`
  },
  {
    code:"MARKETPLACE_UNMAPPED",domain:"ECOMMERCE",label:"Заказы площадок требуют разбора",
    severity:"CRITICAL",href:"/app/ecommerce",
    explanation:"Ошибка импорта или не сопоставлен SKU: проверьте заказ до новой продажи",
    permission:"channels.read",
    sql:`SELECT id FROM channel_order_inbox
      WHERE tenant_id=$1 AND status IN ('FAILED','NEEDS_MAPPING')
        AND received_at<now()-interval '30 minutes'
      ORDER BY received_at,id LIMIT 201`
  },
  {
    code:"MARKETPLACE_STOCK_BLOCKED",domain:"ECOMMERCE",label:"Не обновляются остатки",
    severity:"CRITICAL",href:"/app/ecommerce",
    explanation:"API площадки не подтвердил новые остатки; проверьте токен и витрину",
    permission:"channels.read",
    sql:`SELECT t.listing_id AS id FROM channel_stock_target t
      JOIN channel_stock_listing l ON l.tenant_id=t.tenant_id AND l.id=t.listing_id
      WHERE t.tenant_id=$1 AND t.status='BLOCKED'
        AND l.publish_enabled
      ORDER BY t.updated_at,t.listing_id LIMIT 201`
  },
  {
    code:"MARKETPLACE_EXCESS_PUBLICATION",
    domain:"ECOMMERCE",label:"Остаток опубликован сверх доступного",
    severity:"CRITICAL",href:"/app/ecommerce",
    explanation:"Сумма последних подтверждённых остатков на площадках превышает доступный остаток собственного склада с учётом резервов и страхового запаса",
    permission:"channels.read",
    sql:`WITH exposure AS (
      SELECT l.tenant_id,l.warehouse_id,l.sku_id,
        sum(coalesce(t.published_units,0))::numeric AS published
      FROM channel_stock_listing l JOIN channel_stock_target t
        ON t.tenant_id=l.tenant_id AND t.listing_id=l.id
      WHERE l.tenant_id=$1
      GROUP BY l.tenant_id,l.warehouse_id,l.sku_id
    ), unsafe AS (
      SELECT e.tenant_id,e.warehouse_id,e.sku_id
      FROM exposure e
      LEFT JOIN inventory_balance b ON b.tenant_id=e.tenant_id
        AND b.warehouse_id=e.warehouse_id AND b.sku_id=e.sku_id
      LEFT JOIN inventory_policy p ON p.tenant_id=e.tenant_id
        AND p.warehouse_id=e.warehouse_id AND p.sku_id=e.sku_id
      WHERE e.published >
        CASE WHEN p.enabled=false THEN 0 ELSE
          greatest(0,floor((
            coalesce(b.physical_milli,0)
            -coalesce(b.reserved_milli,0)
            -coalesce(p.safety_stock_milli,0)
          )::numeric/1000)) END
    )
    SELECT l.id FROM channel_stock_listing l
    JOIN unsafe r ON r.tenant_id=l.tenant_id
      AND r.warehouse_id=l.warehouse_id AND r.sku_id=l.sku_id
    WHERE l.tenant_id=$1 AND l.publish_enabled
    ORDER BY l.id LIMIT 201`
  },
  {
    code:"MARKETPLACE_ORDER_FEED_STALE",
    domain:"ECOMMERCE",label:"Заказы площадки давно не обновлялись",
    severity:"CRITICAL",href:"/app/ecommerce",
    explanation:"При публикации товара поток заказов маркетплейса должен регулярно обновляться; иначе остатки могут быть недостоверными",
    permission:"channels.read",
    sql:`SELECT l.id FROM channel_stock_listing l
      JOIN channel_connection c ON c.tenant_id=l.tenant_id
        AND c.id=l.connection_id
      WHERE l.tenant_id=$1 AND l.enabled AND l.publish_enabled
        AND c.status='ACTIVE'
        AND (c.last_synced_at IS NULL
          OR c.last_synced_at<now()-interval '10 minutes')
      ORDER BY l.id LIMIT 201`
  },
  {
    code:"PROJECT_DELIVERABLE_OVERDUE",domain:"PROJECTS",label:"Сорванные сроки результатов",
    severity:"WARNING",href:"/app/projects",
    explanation:"Этап разработки, SEO, рекламы или отчёт не передан в срок",
    permission:"projects.read",
    sql:`SELECT id FROM work_project_deliverable
      WHERE tenant_id=$1 AND status NOT IN ('APPROVED','CANCELLED')
        AND due_at IS NOT NULL AND due_at<now()
      ORDER BY due_at,id LIMIT 201`
  },
  {
    code:"WMS_TASK_FAILED",domain:"WMS",label:"Ошибки складских операций",
    severity:"CRITICAL",href:"/app/wms",
    explanation:"Операция хранения, комплектования или отгрузки завершилась ошибкой",
    permission:"wms.read",
    sql:`SELECT id FROM warehouse_task
      WHERE tenant_id=$1 AND (status='FAILED'
        OR (status='CLAIMED' AND claimed_at<now()-interval '1 day'))
      ORDER BY updated_at,id LIMIT 201`
  },
  {
    code:"FINANCE_OVERDUE",domain:"FINANCE",label:"Просроченные обязательства",
    severity:"WARNING",href:"/app/finance",
    explanation:"Клиентская дебиторка или оплата поставщику вышла за срок",
    permission:"finance.read",
    sql:`SELECT id FROM financial_obligation
      WHERE tenant_id=$1 AND status IN ('OPEN','PARTIALLY_SETTLED')
        AND due_at IS NOT NULL AND due_at<now()
        AND amount_minor>settled_minor
      ORDER BY due_at,id LIMIT 201`
  },
  {
    code:"CRM_ACTION_OVERDUE",domain:"CRM",label:"Сделки без своевременного контакта",
    severity:"WARNING",href:"/app/crm/deals",
    explanation:"Следующее действие по активной сделке просрочено",
    permission:"crm.read",
    sql:`SELECT d.id FROM crm_deal d
      JOIN crm_stage s ON s.tenant_id=d.tenant_id AND s.id=d.stage_id
      WHERE d.tenant_id=$1 AND s.kind='NORMAL'
        AND d.next_action_at IS NOT NULL
        AND d.next_action_at<now()-interval '4 hours'
      ORDER BY d.next_action_at,d.id LIMIT 201`
  },
  {
    code:"SUPPORT_ESCALATED",domain:"SUPPORT",label:"Обращения без ответа",
    severity:"WARNING",href:"/app/support",
    explanation:"Срочное обращение ожидает сотрудника дольше двенадцати часов",
    permission:"support.read",
    sql:`SELECT id FROM support_ticket
      WHERE tenant_id=$1 AND status IN ('NEW','OPEN','WAITING_SUPPORT')
        AND priority IN ('HIGH','URGENT')
        AND updated_at<now()-interval '12 hours'
      ORDER BY updated_at,id LIMIT 201`
  }
  {
    code:"OMS_BACKORDER_OVERDUE",domain:"ECOMMERCE",
    label:"Незакрытая потребность в товарах",
    severity:"CRITICAL",href:"/app/oms",
    explanation:"По подтверждённому заказу не хватает товаров: срок обещанной поставки прошёл или срок не указан более двух дней",
    permission:"oms.read",
    sql:`SELECT b.id FROM oms_backorder_line b
      WHERE b.tenant_id=$1 AND b.status IN ('OPEN','PARTIALLY_ALLOCATED')
        AND (b.expected_at<now() OR
          (b.expected_at IS NULL AND b.created_at<now()-interval '2 days'))
      ORDER BY coalesce(b.expected_at,b.created_at),b.id LIMIT 201`
  },
  {
    code:"DANCE_STRANDED_VISIT",domain:"DANCE",
    label:"Зависшие посещения абонементов",
    severity:"CRITICAL",href:"/app/dance/students",
    explanation:"Урок отменён или закрыт, но резерв абонемента остался активным. Нужна сверка перед повторным списанием",
    permission:"dance.read",
    sql:`SELECT r.id FROM dance_package_redemption r
      JOIN dance_lesson_participant lp ON lp.tenant_id=r.tenant_id
        AND lp.id=r.participant_id
      JOIN dance_lesson l ON l.tenant_id=lp.tenant_id AND l.id=lp.lesson_id
      WHERE r.tenant_id=$1 AND r.state='RESERVED'
        AND (lp.status IN ('WAITLIST','CANCELLED_IN_TIME')
          OR l.status IN ('COMPLETED','CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER'))
      ORDER BY r.id LIMIT 201`
  },
  {
    code:"PAYROLL_REVIEW_DISPUTED",domain:"PAYROLL",
    label:"Неурегулированные споры по зарплате",
    severity:"CRITICAL",href:"/app/dance/team",
    explanation:"Тренер или сотрудник не согласен с расчётом. Проверьте спор до выплаты зарплаты",
    permission:"finance.read",
    sql:`SELECT id FROM payroll_statement_review
      WHERE tenant_id=$1 AND review_status='DISPUTED'
      ORDER BY updated_at,id LIMIT 201`
  },
  {
    code:"PROJECT_CLIENT_APPROVAL_OVERDUE",domain:"PROJECTS",
    label:"Клиент не согласовал результат или бюджет",
    severity:"WARNING",href:"/app/agency",
    explanation:"Истёк согласованный срок решения клиента по этапу, бюджету или запуску кампании",
    permission:"projects.read",
    sql:`SELECT id FROM work_project_client_approval
      WHERE tenant_id=$1 AND status='PENDING'
        AND due_at IS NOT NULL AND due_at<now()
      ORDER BY due_at,id LIMIT 201`
  },
] as const;

export const VERTICAL_OPERATIONAL_RULE_BY_CODE=
  new Map(VERTICAL_OPERATIONAL_RULES.map(rule=>[rule.code,rule]));

export function isCompleteOperationalScan(rowCount:number):boolean{
  return rowCount<=OPERATIONAL_SCAN_LIMIT;
}
