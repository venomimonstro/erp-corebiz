import { Injectable } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

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
    suggestedMilli: string;
    stockCoverDays: string;
    urgency: "OUT" | "CRITICAL" | "REPLENISH";
  }>;
  method: string;
};

@Injectable()
export class CommerceDecisionsService {
  constructor(private readonly database: DatabaseService) {}

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
          ")",
          "SELECT d.sku_id,s.code AS sku,p.name AS product_name,",
          "d.ordered_milli::text AS ordered_milli_30d,",
          "COALESCE(a.sellable_milli,0)::text AS sellable_milli,",
          "COALESCE(i.inbound_milli,0)::text AS inbound_milli,",
          "CEIL(d.ordered_milli*14/30)::text AS target_milli_14d,",
          "GREATEST(CEIL(d.ordered_milli*14/30)-COALESCE(a.sellable_milli,0)-",
          "COALESCE(i.inbound_milli,0),0)::text AS suggested_milli,",
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
          "WHERE v.status='ACTIVE' AND p.status='ACTIVE'",
          "AND COALESCE(a.sellable_milli,0)<d.ordered_milli*14/30",
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
          suggestedMilli: row.suggested_milli,
          stockCoverDays: row.stock_cover_days,
          urgency: row.urgency
        })),
        method: "Оценка на основании количества в подтверждённых/выполненных заказах за 30 дней. " +
          "Цель: 14 дней при неизменном спросе. Учтены текущие доступные остатки, " +
          "страховые запасы и количество в подтверждённых заказах поставщикам. " +
          "Это подсказка, не прогноз и не закупочный документ: не учтены сезонность, " +
          "возвраты, сроки поставки и изменения спроса. Рассмотрены до 200 " +
          "самых заказываемых SKU. Ничего не закупается автоматически."
      };
    });
  }
}
