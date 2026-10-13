import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";

export type CommerceSnapshot = {
  windowDays: 30;
  targetDays: 14;
  pendingFulfillment: number;
  paymentReview: number;
  openSupplierOrders: number;
  replenishment: Array<{
    skuId: string;
    sku: string;
    productName: string;
    orderedMilli30d: string;
    sellableMilli: string;
    inboundMilli: string;
    targetMilli14d: string;
    targetDaysSku: number;
    leadDays: number | null;
    reviewDays: number | null;
    minimumBatchMilli: string;
    suggestedMilli: string;
    stockCoverDays: string;
    urgency: "OUT" | "CRITICAL" | "REPLENISH";
  }>;
  method: string;
};

@Injectable()
export class CommerceDecisionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async rules(context: TenantContext) {
    const scope=await this.authorization.resolveScope(context,"procurement.read");
    if(scope!=="all")throw new ForbiddenException("Нет доступа к правилам закупок");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT r.sku_id,r.lead_days,r.review_days,
            r.minimum_batch_milli::text,r.enabled,s.code AS sku,
            p.name AS product_name,r.updated_at
          FROM procurement_reorder_rule r
          JOIN sku s ON s.tenant_id=r.tenant_id AND s.id=r.sku_id
          JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
          JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
          WHERE r.tenant_id=$1 ORDER BY p.name LIMIT 500`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async updateRule(context: TenantContext, skuId: string,
    input: {leadDays:number;reviewDays:number;minimumBatchMilli:string;enabled:boolean}) {
    const scope=await this.authorization.resolveScope(context,"procurement.write");
    if(scope!=="all")
      throw new ForbiddenException("Изменять закупочные правила может только закупщик или владелец");
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(skuId))
      throw new BadRequestException("Неверный SKU");
    if(!input||!Number.isInteger(input.leadDays)||input.leadDays<1||input.leadDays>180||
      !Number.isInteger(input.reviewDays)||input.reviewDays<1||input.reviewDays>90||
      typeof input.minimumBatchMilli!=="string"||
      !/^(0|[1-9][0-9]{0,14})$/.test(input.minimumBatchMilli)||
      typeof input.enabled!=="boolean")
      throw new BadRequestException("Проверьте срок поставки, период заказа и минимальную партию");
    return this.database.withTenantTransaction(context,async client=>{
      const exists=await client.query(
        `SELECT 1 FROM sku s JOIN product_variant v
         ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE s.tenant_id=$1 AND s.id=$2 AND s.track_inventory=true
           AND s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'`,
        [context.tenantId,skuId]
      );
      if(!exists.rowCount)throw new NotFoundException("Активный складской SKU не найден");
      const result=await client.query(
        `INSERT INTO procurement_reorder_rule(
           tenant_id,sku_id,lead_days,review_days,minimum_batch_milli,
           enabled,updated_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(tenant_id,sku_id) DO UPDATE SET
           lead_days=EXCLUDED.lead_days,
           review_days=EXCLUDED.review_days,
           minimum_batch_milli=EXCLUDED.minimum_batch_milli,
           enabled=EXCLUDED.enabled,
           updated_by_membership_id=EXCLUDED.updated_by_membership_id,
           updated_at=now()
         RETURNING sku_id,lead_days,review_days,
           minimum_batch_milli::text,enabled,updated_at`,
        [context.tenantId,skuId,input.leadDays,input.reviewDays,
          input.minimumBatchMilli,input.enabled,context.membershipId]
      );
      await client.query(
        `INSERT INTO audit_event(tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data)
         VALUES($1,$2,$3,'procurement.reorder_rule_updated',
           'sku',$4,jsonb_build_object(
             'leadDays',$5::integer,'reviewDays',$6::integer,
             'minimumBatchMilli',$7::text,'enabled',$8::boolean
           ))`,
        [context.tenantId,context.userId,context.membershipId,skuId,
          input.leadDays,input.reviewDays,input.minimumBatchMilli,input.enabled]
      );
      return result.rows[0];
    });
  }

  /**
   * An owner's read-only queue, not an automated procurement engine.
   * Never silently create POs or change stock, payments, or fiscal records.
   * Calculates a 14-day target from confirmed order quantities in 30 days.
   */
  async snapshot(context: TenantContext): Promise<CommerceSnapshot> {
    return this.database.withTenantTransaction(context, async client => {
      const status = await client.query<{
        pending_fulfillment: string;
        payment_review: string;
      }>(
        [
          "SELECT",
          "count(*) FILTER (WHERE order_status='CONFIRMED'",
          " AND fulfillment_status NOT IN ('SHIPPED','CANCELLED'))::text AS pending_fulfillment,",
          "count(*) FILTER (WHERE order_status='CONFIRMED'",
          " AND payment_status IN ('UNPAID','PARTIALLY_PAID'))::text AS payment_review",
          "FROM sales_order WHERE tenant_id=$1"
        ].join(" "),
        [context.tenantId]
      );
      const orders = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM purchase_order " +
        "WHERE tenant_id=$1 AND status IN ('CONFIRMED','PARTIALLY_RECEIVED')",
        [context.tenantId]
      );
      const recommendations = await client.query<{
        sku_id: string;
        sku: string;
        product_name: string;
        ordered_milli_30d: string;
        sellable_milli: string;
        inbound_milli: string;
        target_milli_14d: string;
        target_days_sku: number;
        lead_days: number | null;
        review_days: number | null;
        minimum_batch_milli: string;
        suggested_milli: string;
        stock_cover_days: string;
        urgency: "OUT" | "CRITICAL" | "REPLENISH";
      }>(
        [
          "WITH demand AS (",
          " SELECT l.sku_id, SUM(l.quantity_milli)::numeric AS ordered_milli,",
          " COUNT(DISTINCT o.id)::int AS orders",
          " FROM sales_order_line l",
          " JOIN sales_order o ON o.tenant_id=l.tenant_id AND o.id=l.order_id",
          " JOIN sku s ON s.tenant_id=l.tenant_id AND s.id=l.sku_id",
          " WHERE o.tenant_id=$1 AND o.order_status IN ('CONFIRMED','COMPLETED')",
          " AND o.created_at>=now()-interval '30 days'",
          " AND s.track_inventory=true AND s.status='ACTIVE'",
          " GROUP BY l.sku_id",
          " ORDER BY SUM(l.quantity_milli) DESC, l.sku_id",
          " LIMIT 200",
          "), available AS (",
          " SELECT b.sku_id, SUM(GREATEST(b.physical_milli-b.reserved_milli-",
          " COALESCE(ip.safety_stock_milli,0),0))::numeric AS sellable_milli",
          " FROM inventory_balance b",
          " JOIN warehouse w ON w.tenant_id=b.tenant_id AND w.id=b.warehouse_id",
          " LEFT JOIN inventory_policy ip ON ip.tenant_id=b.tenant_id",
          " AND ip.warehouse_id=b.warehouse_id AND ip.sku_id=b.sku_id",
          " WHERE b.tenant_id=$1 AND b.sku_id IN (SELECT sku_id FROM demand)",
          " AND w.status='ACTIVE' AND COALESCE(ip.enabled,true)=true",
          " GROUP BY b.sku_id",
          "), inbound AS (",
          " SELECT pl.sku_id, SUM(GREATEST(pl.ordered_quantity_milli-",
          " pl.received_quantity_milli,0))::numeric AS inbound_milli",
          " FROM purchase_order_line pl",
          " JOIN purchase_order po ON po.tenant_id=pl.tenant_id",
          " AND po.id=pl.purchase_order_id",
          " WHERE pl.tenant_id=$1 AND pl.sku_id IN (SELECT sku_id FROM demand)",
          " AND po.status IN ('CONFIRMED','PARTIALLY_RECEIVED')",
          " GROUP BY pl.sku_id",
          "), policy AS (",
          " SELECT d.sku_id,",
          " CASE WHEN r.enabled=true THEN r.lead_days+r.review_days ELSE 14 END AS target_days,",
          " CASE WHEN r.enabled=true THEN r.minimum_batch_milli ELSE 0 END AS batch_milli,",
          " CASE WHEN r.enabled=true THEN r.lead_days ELSE NULL END AS lead_days,",
          " CASE WHEN r.enabled=true THEN r.review_days ELSE NULL END AS review_days",
          " FROM demand d LEFT JOIN procurement_reorder_rule r",
          " ON r.tenant_id=$1 AND r.sku_id=d.sku_id",
          ")",
          "SELECT d.sku_id,s.code AS sku,p.name AS product_name,",
          "d.ordered_milli::text AS ordered_milli_30d,",
          "COALESCE(a.sellable_milli,0)::text AS sellable_milli,",
          "COALESCE(i.inbound_milli,0)::text AS inbound_milli,",
          "CEIL(d.ordered_milli*pol.target_days/30)::text AS target_milli_14d,",
          "pol.target_days AS target_days_sku,pol.lead_days,pol.review_days,",
          "pol.batch_milli::text AS minimum_batch_milli,",
          "CASE WHEN CEIL(d.ordered_milli*pol.target_days/30)>",
          " COALESCE(a.sellable_milli,0)+COALESCE(i.inbound_milli,0)",
          " THEN GREATEST(CEIL(d.ordered_milli*pol.target_days/30)-",
          " COALESCE(a.sellable_milli,0)-COALESCE(i.inbound_milli,0),",
          " pol.batch_milli) ELSE 0 END::text AS suggested_milli,",
          "ROUND(COALESCE(a.sellable_milli,0)*30/d.ordered_milli,1)::text AS stock_cover_days,",
          "CASE WHEN COALESCE(a.sellable_milli,0)=0 THEN 'OUT'",
          " WHEN COALESCE(a.sellable_milli,0)*30<d.ordered_milli*7 THEN 'CRITICAL'",
          " ELSE 'REPLENISH' END AS urgency",
          "FROM demand d",
          "JOIN sku s ON s.tenant_id=$1 AND s.id=d.sku_id",
          "JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id",
          "JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id",
          "LEFT JOIN available a ON a.sku_id=d.sku_id",
          "LEFT JOIN inbound i ON i.sku_id=d.sku_id",
          "JOIN policy pol ON pol.sku_id=d.sku_id",
          "WHERE v.status='ACTIVE' AND p.status='ACTIVE'",
          "AND COALESCE(a.sellable_milli,0)+COALESCE(i.inbound_milli,0)<",
          " d.ordered_milli*pol.target_days/30",
          "ORDER BY COALESCE(a.sellable_milli,0)*30/d.ordered_milli ASC,d.ordered_milli DESC",
          "LIMIT 20"
        ].join(" "),
        [context.tenantId]
      );
      const count = (value: string | undefined) => {
        const n = Number(value ?? "0");
        return Number.isSafeInteger(n) && n >= 0 ? n : 0;
      };
      return {
        windowDays: 30,
        targetDays: 14,
        pendingFulfillment: count(status.rows[0]?.pending_fulfillment),
        paymentReview: count(status.rows[0]?.payment_review),
        openSupplierOrders: count(orders.rows[0]?.count),
        replenishment: recommendations.rows.map(row => ({
          skuId: row.sku_id,
          sku: row.sku,
          productName: row.product_name,
          orderedMilli30d: row.ordered_milli_30d,
          sellableMilli: row.sellable_milli,
          inboundMilli: row.inbound_milli,
          targetMilli14d: row.target_milli_14d,
          targetDaysSku: row.target_days_sku,
          leadDays: row.lead_days,
          reviewDays: row.review_days,
          minimumBatchMilli: row.minimum_batch_milli,
          suggestedMilli: row.suggested_milli,
          stockCoverDays: row.stock_cover_days,
          urgency: row.urgency
        })),
        method: "Оценка на основании количества в подтверждённых/выполненных заказах за 30 дней. " +
          "Цель: 14 дней по умолчанию или срок поставки + период пересмотра по SKU. Учтены доступные остатки, " +
          "страховые запасы и количество в подтверждённых заказах поставщикам. " +
          "Это подсказка, не прогноз и не закупочный документ: не учтены сезонность, " +
          "возвраты, сроки поставки и изменения спроса. Рассмотрены до 200 " +
          "самых заказываемых SKU. Ничего не закупается автоматически."
      };
    });
  }
}
