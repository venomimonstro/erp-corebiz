import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { InventoryService } from "../inventory/inventory.service";

type Candidate = {
  warehouseId: string;
  warehouseName: string;
  isDefault: boolean;
  physicalMilli: bigint;
  reservedMilli: bigint;
  safetyStockMilli: bigint;
  sourcingPriority: number;
  atpMilli: bigint;
};

@Injectable()
export class OmsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventory: InventoryService
  ) {}

  async list(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           oo.id, oo.sales_order_id, oo.state, oo.allocation_version,
           oo.last_sourcing_summary, oo.last_error, oo.updated_at,
           so.business_number, so.total_minor::text, so.currency,
           so.payment_status, so.fulfillment_status,
           p.display_name AS party_name,
           count(a.id)::int AS allocation_count
         FROM oms_order oo
         JOIN sales_order so
           ON so.tenant_id = oo.tenant_id AND so.id = oo.sales_order_id
         LEFT JOIN party p
           ON p.tenant_id = so.tenant_id AND p.id = so.party_id
         LEFT JOIN oms_allocation a
           ON a.tenant_id = oo.tenant_id
          AND a.oms_order_id = oo.id
          AND a.state = 'RESERVED'
         WHERE oo.tenant_id = $1
         GROUP BY oo.id, so.id, p.display_name
         ORDER BY oo.updated_at DESC
         LIMIT 500`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async ensureOrder(
    context: TenantContext,
    salesOrderId: string
  ): Promise<{ id: string; state: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const order = await client.query<{ order_status: string }>(
        `SELECT order_status
         FROM sales_order
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, salesOrderId]
      );

      const row = order.rows[0];
      if (!row) throw new NotFoundException("Заказ не найден");
      if (row.order_status !== "CONFIRMED") {
        throw new BadRequestException("OMS принимает только подтверждённые заказы");
      }

      const result = await client.query<{ id: string; state: string }>(
        `INSERT INTO oms_order(tenant_id,sales_order_id)
         VALUES ($1,$2)
         ON CONFLICT (tenant_id,sales_order_id)
         DO UPDATE SET updated_at=now()
         RETURNING id,state`,
        [context.tenantId, salesOrderId]
      );

      return result.rows[0]!;
    });
  }

  async setPolicy(
    context: TenantContext,
    input: {
      warehouseId: string;
      skuId: string;
      safetyStockMilli?: string;
      sourcingPriority?: number;
      enabled?: boolean;
    }
  ): Promise<void> {
    const safety = input.safetyStockMilli ?? "0";
    if (!/^\d+$/.test(safety)) {
      throw new BadRequestException("Некорректный safety stock");
    }

    const priority = Math.floor(input.sourcingPriority ?? 100);
    if (priority < 0 || priority > 10000) {
      throw new BadRequestException("Приоритет должен быть от 0 до 10000");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      const warehouse = await client.query(
        `SELECT 1 FROM warehouse
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, input.warehouseId]
      );
      if (!warehouse.rowCount) throw new NotFoundException("Склад не найден");

      const sku = await client.query(
        `SELECT 1 FROM sku
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, input.skuId]
      );
      if (!sku.rowCount) throw new NotFoundException("SKU не найден");

      await client.query(
        `INSERT INTO inventory_policy(
           tenant_id,warehouse_id,sku_id,safety_stock_milli,
           sourcing_priority,enabled,updated_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,warehouse_id,sku_id)
         DO UPDATE SET
           safety_stock_milli=EXCLUDED.safety_stock_milli,
           sourcing_priority=EXCLUDED.sourcing_priority,
           enabled=EXCLUDED.enabled,
           updated_by_membership_id=EXCLUDED.updated_by_membership_id,
           updated_at=now()`,
        [
          context.tenantId,
          input.warehouseId,
          input.skuId,
          safety,
          priority,
          input.enabled ?? true,
          context.membershipId
        ]
      );
    });
  }

  async atp(
    context: TenantContext,
    skuId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           w.id AS warehouse_id,
           w.name AS warehouse_name,
           w.is_default,
           s.id AS sku_id,
           s.code AS sku_code,
           COALESCE(b.physical_milli,0)::text AS physical_milli,
           COALESCE(b.reserved_milli,0)::text AS reserved_milli,
           COALESCE(ip.safety_stock_milli,0)::text AS safety_stock_milli,
           COALESCE(ip.sourcing_priority,100)::int AS sourcing_priority,
           GREATEST(
             COALESCE(b.physical_milli,0)
             - COALESCE(b.reserved_milli,0)
             - COALESCE(ip.safety_stock_milli,0),
             0
           )::text AS atp_milli
         FROM warehouse w
         CROSS JOIN sku s
         LEFT JOIN inventory_balance b
           ON b.tenant_id=w.tenant_id
          AND b.warehouse_id=w.id
          AND b.sku_id=s.id
         LEFT JOIN inventory_policy ip
           ON ip.tenant_id=w.tenant_id
          AND ip.warehouse_id=w.id
          AND ip.sku_id=s.id
         WHERE w.tenant_id=$1
           AND w.status='ACTIVE'
           AND s.tenant_id=$1
           AND s.status='ACTIVE'
           AND s.track_inventory=true
           AND ($2::uuid IS NULL OR s.id=$2)
           AND COALESCE(ip.enabled,true)=true
         ORDER BY s.code,
                  COALESCE(ip.sourcing_priority,100),
                  w.is_default DESC,
                  atp_milli::bigint DESC,
                  w.id`,
        [context.tenantId, skuId ?? null]
      );
      return result.rows;
    });
  }

  async orderDetails(
    context: TenantContext,
    omsOrderId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const order = await client.query(
        `SELECT
           oo.id,oo.sales_order_id,oo.state,oo.allocation_version,
           oo.last_sourcing_summary,oo.last_error,oo.updated_at,
           so.business_number,so.fulfillment_status,so.payment_status,
           so.total_minor::text,so.currency
         FROM oms_order oo
         JOIN sales_order so
           ON so.tenant_id=oo.tenant_id AND so.id=oo.sales_order_id
         WHERE oo.tenant_id=$1 AND oo.id=$2`,
        [context.tenantId, omsOrderId]
      );

      if (!order.rows[0]) throw new NotFoundException("OMS-заказ не найден");

      const lines = await client.query(
        `SELECT
           l.id,l.sku_id,s.code AS sku_code,l.description,
           l.quantity_milli::text,
           s.track_inventory
         FROM sales_order_line l
         LEFT JOIN sku s
           ON s.tenant_id=l.tenant_id AND s.id=l.sku_id
         WHERE l.tenant_id=$1
           AND l.order_id=$2
         ORDER BY l.created_at`,
        [context.tenantId, order.rows[0].sales_order_id]
      );

      const allocations = await client.query(
        `SELECT
           a.id,a.sales_order_line_id,a.sku_id,a.warehouse_id,
           w.name AS warehouse_name,a.reservation_id,
           a.quantity_milli::text,a.safety_stock_milli_snapshot::text,
           a.sourcing_priority_snapshot,a.state,a.explanation,a.created_at
         FROM oms_allocation a
         JOIN warehouse w
           ON w.tenant_id=a.tenant_id AND w.id=a.warehouse_id
         WHERE a.tenant_id=$1 AND a.oms_order_id=$2
         ORDER BY a.created_at,a.warehouse_id`,
        [context.tenantId, omsOrderId]
      );

      return {
        order: order.rows[0],
        lines: lines.rows,
        allocations: allocations.rows
      };
    });
  }

  async allocate(
    context: TenantContext,
    omsOrderId: string
  ): Promise<Record<string, unknown>> {
    let salesOrderId = "";

    try {
      return await this.database.withTenantTransaction(context, async (client) => {
        const omsResult = await client.query<{
          id: string;
          sales_order_id: string;
          state: string;
          allocation_version: number;
        }>(
          `SELECT id,sales_order_id,state,allocation_version
           FROM oms_order
           WHERE tenant_id=$1 AND id=$2
           FOR UPDATE`,
          [context.tenantId, omsOrderId]
        );

        const oms = omsResult.rows[0];
        if (!oms) throw new NotFoundException("OMS-заказ не найден");
        salesOrderId = oms.sales_order_id;

        if (["FULFILLMENT","SHIPPED","CANCELLED"].includes(oms.state)) {
          throw new BadRequestException(
            "Текущее состояние OMS-заказа не допускает перераспределение"
          );
        }

        const order = await client.query<{
          order_status: string;
          fulfillment_status: string;
        }>(
          `SELECT order_status,fulfillment_status
           FROM sales_order
           WHERE tenant_id=$1 AND id=$2
           FOR UPDATE`,
          [context.tenantId, salesOrderId]
        );

        const sales = order.rows[0];
        if (!sales) throw new NotFoundException("Заказ продаж не найден");
        if (sales.order_status !== "CONFIRMED") {
          throw new BadRequestException("Заказ должен быть подтверждён");
        }
        if (["PARTIALLY_SHIPPED","SHIPPED"].includes(sales.fulfillment_status)) {
          throw new ConflictException("Заказ уже передан в отгрузку");
        }

        const lines = await client.query<{
          line_id: string;
          sku_id: string | null;
          quantity_milli: string;
          track_inventory: boolean | null;
          sku_code: string | null;
        }>(
          `SELECT
             l.id AS line_id,l.sku_id,l.quantity_milli::text,
             s.track_inventory,s.code AS sku_code
           FROM sales_order_line l
           LEFT JOIN sku s
             ON s.tenant_id=l.tenant_id AND s.id=l.sku_id
           WHERE l.tenant_id=$1 AND l.order_id=$2
           ORDER BY l.created_at
           FOR UPDATE OF l`,
          [context.tenantId, salesOrderId]
        );

        const stockLines = lines.rows.filter(
          (line) => line.sku_id && line.track_inventory
        );

        const runNumber = oms.allocation_version + 1;
        const run = await client.query<{ id: string }>(
          `INSERT INTO oms_sourcing_run(
             tenant_id,oms_order_id,run_number,status,strategy,input_snapshot
           ) VALUES ($1,$2,$3,'RUNNING','PRIORITY_ATP',$4)
           RETURNING id`,
          [
            context.tenantId,
            oms.id,
            runNumber,
            JSON.stringify({
              salesOrderId,
              lines: stockLines.map((line) => ({
                lineId: line.line_id,
                skuId: line.sku_id,
                sku: line.sku_code,
                quantityMilli: line.quantity_milli
              }))
            })
          ]
        );

        await client.query(
          `UPDATE oms_order
           SET state='ALLOCATING',last_error=NULL,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, oms.id]
        );

        const decisions: Array<Record<string, unknown>> = [];
        const usedWarehouses = new Set<string>();
        let totalBackorderMilli = 0n;
        let newlyReserved = 0;

        for (const line of stockLines) {
          const reservedResult = await client.query<{ reserved_milli: string }>(
            `SELECT COALESCE(sum(quantity_milli),0)::text AS reserved_milli
             FROM inventory_reservation
             WHERE tenant_id=$1
               AND sales_order_id=$2
               AND sales_order_line_id=$3
               AND status='ACTIVE'`,
            [context.tenantId, salesOrderId, line.line_id]
          );

          const alreadyReserved = BigInt(
            reservedResult.rows[0]?.reserved_milli ?? "0"
          );
          const requested = BigInt(line.quantity_milli);
          let remaining =
            requested > alreadyReserved ? requested - alreadyReserved : 0n;

          const existingWarehouses = await client.query<{ warehouse_id: string }>(
            `SELECT DISTINCT warehouse_id
             FROM inventory_reservation
             WHERE tenant_id=$1
               AND sales_order_id=$2
               AND sales_order_line_id=$3
               AND status='ACTIVE'`,
            [context.tenantId, salesOrderId, line.line_id]
          );
          for (const row of existingWarehouses.rows) {
            usedWarehouses.add(row.warehouse_id);
          }

          if (remaining > 0n) {
            const candidates = await this.candidates(
              client,
              context.tenantId,
              line.sku_id!
            );

            for (const candidate of candidates) {
              if (remaining <= 0n) break;
              if (candidate.atpMilli <= 0n) continue;

              const alreadyOnWarehouse = await client.query(
                `SELECT 1
                 FROM inventory_reservation
                 WHERE tenant_id=$1
                   AND sales_order_line_id=$2
                   AND warehouse_id=$3
                   AND status='ACTIVE'
                 LIMIT 1`,
                [
                  context.tenantId,
                  line.line_id,
                  candidate.warehouseId
                ]
              );
              if (alreadyOnWarehouse.rowCount) continue;

              const take =
                candidate.atpMilli < remaining
                  ? candidate.atpMilli
                  : remaining;

              try {
                const reservation = await this.inventory.reserveAllocation(
                  client,
                  context,
                  {
                    salesOrderId,
                    salesOrderLineId: line.line_id,
                    warehouseId: candidate.warehouseId,
                    skuId: line.sku_id!,
                    quantityMilli: take,
                    safetyStockMilli: candidate.safetyStockMilli,
                    idempotencyKey:
                      "oms:" +
                      oms.id +
                      ":run:" +
                      runNumber +
                      ":line:" +
                      line.line_id +
                      ":warehouse:" +
                      candidate.warehouseId
                  }
                );

                usedWarehouses.add(candidate.warehouseId);
                newlyReserved += reservation.applied ? 1 : 0;

                const explanation = {
                  strategy: "PRIORITY_ATP",
                  warehouseName: candidate.warehouseName,
                  sourcingPriority: candidate.sourcingPriority,
                  isDefault: candidate.isDefault,
                  physicalMilli: candidate.physicalMilli.toString(),
                  reservedMilli: candidate.reservedMilli.toString(),
                  safetyStockMilli: candidate.safetyStockMilli.toString(),
                  atpBeforeMilli: candidate.atpMilli.toString(),
                  allocatedMilli: take.toString(),
                  reason:
                    "Минимальный sourcing priority, затем default warehouse и максимальный ATP"
                };

                await client.query(
                  `INSERT INTO oms_allocation(
                     tenant_id,oms_order_id,sourcing_run_id,
                     sales_order_line_id,sku_id,warehouse_id,reservation_id,
                     quantity_milli,safety_stock_milli_snapshot,
                     sourcing_priority_snapshot,state,explanation
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RESERVED',$11)`,
                  [
                    context.tenantId,
                    oms.id,
                    run.rows[0]!.id,
                    line.line_id,
                    line.sku_id,
                    candidate.warehouseId,
                    reservation.reservationId,
                    take.toString(),
                    candidate.safetyStockMilli.toString(),
                    candidate.sourcingPriority,
                    JSON.stringify(explanation)
                  ]
                );

                decisions.push({
                  lineId: line.line_id,
                  skuId: line.sku_id,
                  sku: line.sku_code,
                  warehouseId: candidate.warehouseId,
                  warehouseName: candidate.warehouseName,
                  quantityMilli: take.toString(),
                  explanation
                });

                remaining -= take;
              } catch (error) {
                if (!(error instanceof ConflictException)) throw error;
                decisions.push({
                  lineId: line.line_id,
                  skuId: line.sku_id,
                  sku: line.sku_code,
                  warehouseId: candidate.warehouseId,
                  warehouseName: candidate.warehouseName,
                  quantityMilli: "0",
                  skipped: true,
                  reason:
                    "ATP изменился конкурентно; склад пропущен и sourcing продолжен"
                });
              }
            }
          }

          if (remaining > 0n) {
            totalBackorderMilli += remaining;

            await client.query(
              `INSERT INTO oms_backorder_line(
                 tenant_id,oms_order_id,sales_order_line_id,sku_id,
                 quantity_milli,status,reason
               ) VALUES ($1,$2,$3,$4,$5,'OPEN','INSUFFICIENT_ATP')
               ON CONFLICT (tenant_id,oms_order_id,sales_order_line_id)
               DO UPDATE SET
                 quantity_milli=EXCLUDED.quantity_milli,
                 status='OPEN',
                 reason='INSUFFICIENT_ATP',
                 updated_at=now()`,
              [
                context.tenantId,
                oms.id,
                line.line_id,
                line.sku_id,
                remaining.toString()
              ]
            );
          } else {
            await client.query(
              `UPDATE oms_backorder_line
               SET status='ALLOCATED',
                   updated_at=now()
               WHERE tenant_id=$1
                 AND oms_order_id=$2
                 AND sales_order_line_id=$3
                 AND status <> 'CANCELLED'`,
              [context.tenantId, oms.id, line.line_id]
            );
          }
        }

        const activeReservations = await client.query<{
          count: string;
          total_milli: string;
        }>(
          `SELECT count(*)::text AS count,
                  COALESCE(sum(quantity_milli),0)::text AS total_milli
           FROM inventory_reservation
           WHERE tenant_id=$1
             AND sales_order_id=$2
             AND status='ACTIVE'`,
          [context.tenantId, salesOrderId]
        );

        const reservationCount = Number(
          activeReservations.rows[0]?.count ?? "0"
        );

        let fulfillmentStatus:
          | "READY"
          | "UNALLOCATED"
          | "PARTIALLY_RESERVED"
          | "RESERVED";

        if (stockLines.length === 0) {
          fulfillmentStatus = "READY";
        } else if (totalBackorderMilli === 0n) {
          fulfillmentStatus = "RESERVED";
        } else if (reservationCount > 0) {
          fulfillmentStatus = "PARTIALLY_RESERVED";
        } else {
          fulfillmentStatus = "UNALLOCATED";
        }

        const singleWarehouse =
          usedWarehouses.size === 1
            ? Array.from(usedWarehouses)[0]
            : null;

        await client.query(
          `UPDATE sales_order
           SET fulfillment_status=$3,
               warehouse_id=$4,
               version=version+1,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,
            salesOrderId,
            fulfillmentStatus,
            singleWarehouse
          ]
        );

        const state =
          totalBackorderMilli === 0n
            ? "ALLOCATED"
            : reservationCount > 0
              ? "PARTIALLY_ALLOCATED"
              : "BACKORDER";

        const summary = {
          strategy: "PRIORITY_ATP",
          split: usedWarehouses.size > 1,
          warehouses: Array.from(usedWarehouses),
          reservationCount,
          newlyReserved,
          allocationCount: decisions.filter((x) => !("skipped" in x)).length,
          backorderMilli: totalBackorderMilli.toString(),
          lines: stockLines.length
        };

        await client.query(
          `UPDATE oms_sourcing_run
           SET status='SUCCEEDED',
               decision_snapshot=$3,
               finished_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, run.rows[0]!.id, JSON.stringify(decisions)]
        );

        await client.query(
          `UPDATE oms_order
           SET state=$3,
               allocation_version=$4,
               last_sourcing_summary=$5,
               last_error=NULL,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,
            oms.id,
            state,
            runNumber,
            JSON.stringify(summary)
          ]
        );

        await this.audit(
          client,
          context,
          "oms.order_sourced",
          "oms_order",
          oms.id,
          { state, ...summary }
        );

        return {
          omsOrderId: oms.id,
          salesOrderId,
          state,
          fulfillmentStatus,
          ...summary,
          decisions
        };
      });
    } catch (error) {
      if (salesOrderId) {
        await this.database.withTenantTransaction(context, async (client) => {
          await client.query(
            `UPDATE oms_order
             SET state='ALLOCATION_FAILED',
                 last_error=$3,
                 updated_at=now()
             WHERE tenant_id=$1 AND id=$2`,
            [
              context.tenantId,
              omsOrderId,
              (error instanceof Error ? error.message : String(error)).slice(0, 2000)
            ]
          );
        });
      }
      throw error;
    }
  }

  async markFulfillment(
    context: TenantContext,
    omsOrderId: string
  ): Promise<void> {
    await this.transition(context, omsOrderId, "ALLOCATED", "FULFILLMENT");
  }

  async markShipped(
    context: TenantContext,
    omsOrderId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE oms_order oo
         SET state='SHIPPED',updated_at=now()
         FROM sales_order so
         WHERE oo.tenant_id=$1
           AND oo.id=$2
           AND so.tenant_id=oo.tenant_id
           AND so.id=oo.sales_order_id
           AND oo.state='FULFILLMENT'
           AND so.fulfillment_status='SHIPPED'
         RETURNING oo.id`,
        [context.tenantId, omsOrderId]
      );

      if (!result.rowCount) {
        throw new ConflictException(
          "OMS можно перевести в SHIPPED только после фактической отгрузки Sales/Inventory"
        );
      }
    });
  }

  private async transition(
    context: TenantContext,
    omsOrderId: string,
    from: string,
    to: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE oms_order
         SET state=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND state=$3
         RETURNING id`,
        [context.tenantId, omsOrderId, from, to]
      );

      if (!result.rowCount) {
        throw new ConflictException(
          "Недопустимый переход OMS: " + from + " → " + to
        );
      }
    });
  }

  private async candidates(
    client: PoolClient,
    tenantId: string,
    skuId: string
  ): Promise<Candidate[]> {
    const result = await client.query<{
      warehouse_id: string;
      warehouse_name: string;
      is_default: boolean;
      physical_milli: string;
      reserved_milli: string;
      safety_stock_milli: string;
      sourcing_priority: number;
      atp_milli: string;
    }>(
      `SELECT
         w.id AS warehouse_id,
         w.name AS warehouse_name,
         w.is_default,
         COALESCE(b.physical_milli,0)::text AS physical_milli,
         COALESCE(b.reserved_milli,0)::text AS reserved_milli,
         COALESCE(ip.safety_stock_milli,0)::text AS safety_stock_milli,
         COALESCE(ip.sourcing_priority,100)::int AS sourcing_priority,
         GREATEST(
           COALESCE(b.physical_milli,0)
           - COALESCE(b.reserved_milli,0)
           - COALESCE(ip.safety_stock_milli,0),
           0
         )::text AS atp_milli
       FROM warehouse w
       LEFT JOIN inventory_balance b
         ON b.tenant_id=w.tenant_id
        AND b.warehouse_id=w.id
        AND b.sku_id=$2
       LEFT JOIN inventory_policy ip
         ON ip.tenant_id=w.tenant_id
        AND ip.warehouse_id=w.id
        AND ip.sku_id=$2
       WHERE w.tenant_id=$1
         AND w.status='ACTIVE'
         AND COALESCE(ip.enabled,true)=true
       ORDER BY
         COALESCE(ip.sourcing_priority,100) ASC,
         w.is_default DESC,
         GREATEST(
           COALESCE(b.physical_milli,0)
           - COALESCE(b.reserved_milli,0)
           - COALESCE(ip.safety_stock_milli,0),
           0
         ) DESC,
         w.id`,
      [tenantId, skuId]
    );

    return result.rows.map((row) => ({
      warehouseId: row.warehouse_id,
      warehouseName: row.warehouse_name,
      isDefault: row.is_default,
      physicalMilli: BigInt(row.physical_milli),
      reservedMilli: BigInt(row.reserved_milli),
      safetyStockMilli: BigInt(row.safety_stock_milli),
      sourcingPriority: row.sourcing_priority,
      atpMilli: BigInt(row.atp_milli)
    }));
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id,actor_user_id,actor_membership_id,
         action,resource_type,resource_id,after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        data ? JSON.stringify(data) : null
      ]
    );
  }
}
