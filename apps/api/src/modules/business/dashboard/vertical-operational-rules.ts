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
] as const;

export const VERTICAL_OPERATIONAL_RULE_BY_CODE=
  new Map(VERTICAL_OPERATIONAL_RULES.map(rule=>[rule.code,rule]));

export function isCompleteOperationalScan(rowCount:number):boolean{
  return rowCount<=OPERATIONAL_SCAN_LIMIT;
}
