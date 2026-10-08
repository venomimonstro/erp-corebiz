import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { DomainEventService } from "../../platform/events/domain-event.service";

export type InventoryReceiptLine = {
  skuId: string;
  quantityMilli: bigint;
  unitCostMinor: bigint;
  sourceLineId: string;
};

type MovementInput = {
  warehouseId: string;
  skuId: string;
  movementType:
    | "RECEIPT"
    | "SHIPMENT"
    | "TRANSFER_IN"
    | "TRANSFER_OUT"
    | "RETURN"
    | "ADJUSTMENT"
    | "DAMAGE"
    | "WRITE_OFF";
  quantityDeltaMilli: bigint;
  unitCostMinor?: bigint;
  sourceType?: string;
  sourceId?: string;
  sourceLineId?: string;
  reason?: string;
  idempotencyKey: string;
  ownerId?: string;
};

@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: DomainEventService
  ) {}

  async listWarehouses(context: TenantContext): Promise<Array<{
    id: string;
    name: string;
    code: string;
    isDefault: boolean;
    branchId: string | null;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        code: string;
        is_default: boolean;
        branch_id: string | null;
      }>(
        `SELECT id, name, code, is_default, branch_id
         FROM warehouse
         WHERE tenant_id = $1 AND status = 'ACTIVE'
         ORDER BY is_default DESC, name`,
        [context.tenantId]
      );

      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        code: row.code,
        isDefault: row.is_default,
        branchId: row.branch_id
      }));
    });
  }

  async createWarehouse(
    context: TenantContext,
    input: { name: string; code?: string; branchId?: string }
  ): Promise<{ id: string; name: string; code: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название склада");
    }

    const code = (
      input.code?.trim() ||
      name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")
    ).toUpperCase().slice(0, 40);

    if (!code) throw new BadRequestException("Некорректный код склада");

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.branchId) {
        const branch = await client.query(
          `SELECT 1 FROM branch
           WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
          [context.tenantId, input.branchId]
        );
        if (!branch.rowCount) throw new NotFoundException("Филиал не найден");
      }

      try {
        const result = await client.query<{
          id: string;
          name: string;
          code: string;
        }>(
          `INSERT INTO warehouse(tenant_id, branch_id, name, code)
           VALUES ($1,$2,$3,$4)
           RETURNING id, name, code`,
          [context.tenantId, input.branchId ?? null, name, code]
        );

        const row = result.rows[0];
        if (!row) throw new Error("WAREHOUSE_CREATE_FAILED");

        await this.audit(
          client,
          context,
          "inventory.warehouse_created",
          "warehouse",
          row.id,
          { name, code }
        );

        return row;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException("Склад с таким кодом уже существует");
        }
        throw error;
      }
    });
  }

  async balances(context: TenantContext): Promise<Array<{
    warehouseId: string;
    warehouseName: string;
    skuId: string;
    sku: string;
    productName: string;
    physicalMilli: string;
    reservedMilli: string;
    availableMilli: string;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        warehouse_id: string;
        warehouse_name: string;
        sku_id: string;
        sku_code: string;
        product_name: string;
        physical_milli: string;
        reserved_milli: string;
        available_milli: string;
      }>(
        `SELECT
           b.warehouse_id,
           w.name AS warehouse_name,
           b.sku_id,
           s.code AS sku_code,
           p.name AS product_name,
           b.physical_milli::text,
           b.reserved_milli::text,
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
         ORDER BY w.is_default DESC, w.name, p.name, s.code`,
        [context.tenantId]
      );

      return result.rows.map((row) => ({
        warehouseId: row.warehouse_id,
        warehouseName: row.warehouse_name,
        skuId: row.sku_id,
        sku: row.sku_code,
        productName: row.product_name,
        physicalMilli: row.physical_milli,
        reservedMilli: row.reserved_milli,
        availableMilli: row.available_milli
      }));
    });
  }

  async adjust(
    context: TenantContext,
    input: {
      warehouseId: string;
      skuId: string;
      quantityDeltaMilli: string;
      reason: string;
      idempotencyKey: string;
    },
    options?: {
      wmsLocationId?: string;
    }
  ): Promise<{ movementId: string; applied: boolean }> {
    if (!/^-?\d+$/.test(input.quantityDeltaMilli)) {
      throw new BadRequestException("Некорректное количество");
    }

    const delta = BigInt(input.quantityDeltaMilli);
    if (delta === 0n) {
      throw new BadRequestException("Изменение количества не может быть нулём");
    }

    if (!input.reason?.trim()) {
      throw new BadRequestException("Укажите причину корректировки");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (options?.wmsLocationId) {
        const profile = await client.query(
          `SELECT 1
           FROM warehouse_wms_profile
           WHERE tenant_id=$1
             AND warehouse_id=$2
             AND status='ACTIVE'
             AND stock_tracking_state='LOCATION_LEDGER'`,
          [context.tenantId, input.warehouseId]
        );
        if (!profile.rowCount) {
          throw new ConflictException(
            "WMS location adjustment доступен только при активном ячеечном учёте"
          );
        }

        const location = await client.query(
          `SELECT 1
           FROM warehouse_location
           WHERE tenant_id=$1
             AND warehouse_id=$2
             AND id=$3
             AND status='ACTIVE'
           FOR UPDATE`,
          [
            context.tenantId,
            input.warehouseId,
            options.wmsLocationId
          ]
        );

        if (!location.rowCount) {
          throw new NotFoundException("WMS-ячейка не найдена");
        }

        const locationBalance = await client.query<{
          physical_milli: string;
        }>(
          `SELECT physical_milli::text
           FROM warehouse_location_balance
           WHERE tenant_id=$1
             AND warehouse_id=$2
             AND location_id=$3
             AND sku_id=$4
           FOR UPDATE`,
          [
            context.tenantId,
            input.warehouseId,
            options.wmsLocationId,
            input.skuId
          ]
        );

        const locationPhysical =
          BigInt(locationBalance.rows[0]?.physical_milli ?? "0");

        if (locationPhysical + delta < 0n) {
          throw new ConflictException(
            "Корректировка создаст отрицательный остаток в ячейке"
          );
        }
      }

      const movement = await this.postMovement(client, context, {
        warehouseId: input.warehouseId,
        skuId: input.skuId,
        movementType: "ADJUSTMENT",
        quantityDeltaMilli: delta,
        reason: input.reason.trim(),
        idempotencyKey: input.idempotencyKey
      });

      if (options?.wmsLocationId && movement.applied) {
        await client.query(
          `INSERT INTO warehouse_location_balance(
             tenant_id,warehouse_id,location_id,sku_id,physical_milli
           ) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id,warehouse_id,location_id,sku_id)
           DO UPDATE SET
             physical_milli=
               warehouse_location_balance.physical_milli+
               EXCLUDED.physical_milli,
             updated_at=now()`,
          [
            context.tenantId,
            input.warehouseId,
            options.wmsLocationId,
            input.skuId,
            delta.toString()
          ]
        );

        await client.query(
          `INSERT INTO wms_location_movement(
             tenant_id,warehouse_id,sku_id,movement_type,
             from_location_id,to_location_id,quantity_milli,
             source_type,idempotency_key,actor_membership_id
           ) VALUES (
             $1,$2,$3,'ADJUSTMENT',
             $4,$5,$6,
             'CYCLE_COUNT',$7,$8
           )
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
          [
            context.tenantId,
            input.warehouseId,
            input.skuId,
            delta < 0n ? options.wmsLocationId : null,
            delta > 0n ? options.wmsLocationId : null,
            (delta < 0n ? -delta : delta).toString(),
            "wms-adjustment:" + input.idempotencyKey,
            context.membershipId
          ]
        );
      }

      return movement;
    });
  }

  async applyWmsCountAdjustment(
    client: PoolClient,
    context: TenantContext,
    input: {
      warehouseId: string;
      skuId: string;
      quantityDeltaMilli: bigint;
      countId: string;
      countLineId: string;
      reason: string;
      idempotencyKey: string;
    }
  ): Promise<{ movementId: string | null; applied: boolean }> {
    if (input.quantityDeltaMilli === 0n) {
      return { movementId: null, applied: false };
    }
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности WMS count");
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM inventory_transaction
       WHERE tenant_id=$1 AND idempotency_key=$2`,
      [context.tenantId,input.idempotencyKey.trim()]
    );
    if (existing.rows[0]) {
      return { movementId: existing.rows[0].id, applied: false };
    }

    const wms = await client.query(
      `SELECT 1
       FROM warehouse_wms_profile
       WHERE tenant_id=$1 AND warehouse_id=$2
         AND status='ACTIVE'
         AND stock_tracking_state='LOCATION_LEDGER'`,
      [context.tenantId,input.warehouseId]
    );
    if (!wms.rowCount) {
      throw new ConflictException("Cycle count разрешён только для активного адресного WMS");
    }

    await this.assertWarehouse(client,context.tenantId,input.warehouseId);
    await this.assertSku(client,context.tenantId,input.skuId);
    await this.lockBalance(
      client,context.tenantId,input.warehouseId,input.skuId
    );

    const balance = await client.query<{
      physical_milli:string;
      reserved_milli:string;
    }>(
      `SELECT physical_milli::text,reserved_milli::text
       FROM inventory_balance
       WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3
       FOR UPDATE`,
      [context.tenantId,input.warehouseId,input.skuId]
    );

    const row=balance.rows[0]!;
    const nextPhysical=
      BigInt(row.physical_milli)+input.quantityDeltaMilli;
    const reserved=BigInt(row.reserved_milli);

    if(nextPhysical<0n||nextPhysical<reserved){
      throw new ConflictException(
        "Результат пересчёта ниже зарезервированного остатка; сначала разберите резервы"
      );
    }

    const movement=await this.insertMovementOnly(client,context,{
      warehouseId:input.warehouseId,
      skuId:input.skuId,
      movementType:"ADJUSTMENT",
      quantityDeltaMilli:input.quantityDeltaMilli,
      sourceType:"WMS_CYCLE_COUNT",
      sourceId:input.countId,
      sourceLineId:input.countLineId,
      reason:input.reason,
      idempotencyKey:input.idempotencyKey.trim()
    });

    await client.query(
      `UPDATE inventory_balance
       SET physical_milli=$4::bigint,updated_at=now()
       WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3`,
      [
        context.tenantId,input.warehouseId,input.skuId,
        nextPhysical.toString()
      ]
    );

    await this.audit(
      client,context,"inventory.wms_count_adjusted","sku",input.skuId,{
        warehouseId:input.warehouseId,
        countId:input.countId,
        countLineId:input.countLineId,
        deltaMilli:input.quantityDeltaMilli.toString()
      }
    );

    return {movementId:movement.id,applied:true};
  }

  async postGoodsReceipt(
    client: PoolClient,
    context: TenantContext,
    input: {
      receiptId: string;
      warehouseId: string;
      ownerId: string;
      lines: InventoryReceiptLine[];
    }
  ): Promise<void> {
    await this.assertWarehouse(client, context.tenantId, input.warehouseId);

    for (const line of input.lines) {
      const movement=await this.postMovement(client, context, {
        warehouseId: input.warehouseId,
        skuId: line.skuId,
        movementType: "RECEIPT",
        quantityDeltaMilli: line.quantityMilli,
        unitCostMinor: line.unitCostMinor,
        sourceType: "GOODS_RECEIPT",
        sourceId: input.receiptId,
        sourceLineId: line.sourceLineId,
        idempotencyKey:
          `goods-receipt:${input.receiptId}:line:${line.sourceLineId}`,
        ownerId:input.ownerId
      });

      await client.query(
        `SELECT corebiz_wms_receive_unassigned(
           $1,$2,$3,$4,$5,$6,$7,$8,$9
         )`,
        [
          context.tenantId,
          input.warehouseId,
          line.skuId,
          line.quantityMilli.toString(),
          "GOODS_RECEIPT",
          input.receiptId,
          line.sourceLineId,
          `wms-goods-receipt:${input.receiptId}:line:${line.sourceLineId}`,
          context.membershipId
        ]
      );

      if(movement.applied){
        await this.receiveOwnerIntoUnassigned(
          client,context,{
            warehouseId:input.warehouseId,
            ownerId:input.ownerId,
            skuId:line.skuId,
            quantityMilli:line.quantityMilli,
            receiptId:input.receiptId,
            sourceLineId:line.sourceLineId
          }
        );
      }
    }
  }

  async reserveAllocation(
    client: PoolClient,
    context: TenantContext,
    input: {
      salesOrderId: string;
      salesOrderLineId: string;
      warehouseId: string;
      skuId: string;
      quantityMilli: bigint;
      safetyStockMilli?: bigint;
      idempotencyKey: string;
    }
  ): Promise<{ reservationId: string; applied: boolean }> {
    if (input.quantityMilli <= 0n) {
      throw new BadRequestException("Количество резерва должно быть больше нуля");
    }
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM inventory_reservation
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [context.tenantId, input.idempotencyKey.trim()]
    );

    if (existing.rows[0]) {
      return {
        reservationId: existing.rows[0].id,
        applied: false
      };
    }

    await this.assertWarehouse(
      client,
      context.tenantId,
      input.warehouseId
    );
    await this.assertSku(client, context.tenantId, input.skuId);

    const line = await client.query<{
      inventory_owner_id:string;
      owner_type:string;
    }>(
      `SELECT so.inventory_owner_id,o.owner_type
       FROM sales_order_line l
       JOIN sales_order so
         ON so.tenant_id=l.tenant_id AND so.id=l.order_id
       JOIN inventory_owner o
         ON o.tenant_id=so.tenant_id AND o.id=so.inventory_owner_id
       WHERE l.tenant_id = $1
         AND l.id = $2
         AND l.order_id = $3
         AND l.sku_id = $4
         AND o.status='ACTIVE'`,
      [
        context.tenantId,
        input.salesOrderLineId,
        input.salesOrderId,
        input.skuId
      ]
    );

    const owner=line.rows[0];
    if (!owner) {
      throw new NotFoundException("Строка заказа или владелец товара не найдены");
    }

    if(owner.owner_type==="CLIENT"){
      await this.assertOwnerContract(
        client,context.tenantId,input.warehouseId,owner.inventory_owner_id
      );
      await this.assertOwnerLedgerEnabled(
        client,context.tenantId,input.warehouseId
      );
    }

    await this.lockBalance(
      client,
      context.tenantId,
      input.warehouseId,
      input.skuId
    );

    const balance = await client.query<{
      physical_milli: string;
      reserved_milli: string;
    }>(
      `SELECT physical_milli::text, reserved_milli::text
       FROM inventory_balance
       WHERE tenant_id = $1
         AND warehouse_id = $2
         AND sku_id = $3
       FOR UPDATE`,
      [context.tenantId, input.warehouseId, input.skuId]
    );

    const row = balance.rows[0]!;
    const available =
      BigInt(row.physical_milli) - BigInt(row.reserved_milli);
    const safety = input.safetyStockMilli ?? 0n;

    if (safety < 0n) {
      throw new BadRequestException("Safety stock не может быть отрицательным");
    }

    if (available - input.quantityMilli < safety) {
      throw new ConflictException(
        "Недостаточно ATP с учётом страхового остатка"
      );
    }

    const activeSameLineWarehouse = await client.query<{ id: string }>(
      `SELECT id
       FROM inventory_reservation
       WHERE tenant_id = $1
         AND sales_order_line_id = $2
         AND warehouse_id = $3
         AND status = 'ACTIVE'
       FOR UPDATE`,
      [
        context.tenantId,
        input.salesOrderLineId,
        input.warehouseId
      ]
    );

    if (activeSameLineWarehouse.rows[0]) {
      throw new ConflictException(
        "Для строки и склада уже существует активный резерв"
      );
    }

    const ownerLedger=await this.ownerLedgerEnabled(
      client,context.tenantId,input.warehouseId
    );
    if(ownerLedger){
      await this.applyOwnerBalanceDelta(
        client,context,{
          warehouseId:input.warehouseId,
          ownerId:owner.inventory_owner_id,
          skuId:input.skuId,
          physicalDelta:0n,
          reservedDelta:input.quantityMilli,
          movementType:"RESERVE",
          sourceType:"SALES_ORDER",
          sourceId:input.salesOrderId,
          sourceLineId:input.salesOrderLineId,
          idempotencyKey:
            "owner-reserve:"+input.idempotencyKey.trim()
        }
      );
    }

    await client.query(
      `UPDATE inventory_balance
       SET reserved_milli = reserved_milli + $4::bigint,
           updated_at = now()
       WHERE tenant_id = $1
         AND warehouse_id = $2
         AND sku_id = $3`,
      [
        context.tenantId,
        input.warehouseId,
        input.skuId,
        input.quantityMilli.toString()
      ]
    );

    const reservation = await client.query<{ id: string }>(
      `INSERT INTO inventory_reservation(
         tenant_id, sales_order_id, sales_order_line_id,
         warehouse_id, sku_id, owner_id, quantity_milli, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        context.tenantId,
        input.salesOrderId,
        input.salesOrderLineId,
        input.warehouseId,
        input.skuId,
        owner.inventory_owner_id,
        input.quantityMilli.toString(),
        input.idempotencyKey.trim()
      ]
    );

    return {
      reservationId: reservation.rows[0]!.id,
      applied: true
    };
  }

  async reserveOrder(
    context: TenantContext,
    input: {
      orderId: string;
      warehouseId?: string;
      idempotencyKey: string;
    }
  ): Promise<{
    orderId: string;
    fulfillmentStatus: "RESERVED" | "READY";
    reservations: number;
  }> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const orderResult = await client.query<{
        id: string;
        order_status: string;
        fulfillment_status: string;
        warehouse_id: string | null;
        inventory_owner_id: string;
        owner_type: "INTERNAL"|"CLIENT";
      }>(
        `SELECT so.id,so.order_status,so.fulfillment_status,so.warehouse_id,
                so.inventory_owner_id,o.owner_type
         FROM sales_order so
         JOIN inventory_owner o
           ON o.tenant_id=so.tenant_id AND o.id=so.inventory_owner_id
         WHERE so.tenant_id = $1 AND so.id = $2
         FOR UPDATE OF so`,
        [context.tenantId, input.orderId]
      );

      const order = orderResult.rows[0];
      if (!order) throw new NotFoundException("Заказ не найден");
      if (order.order_status !== "CONFIRMED") {
        throw new BadRequestException("Сначала подтвердите заказ");
      }

      if (["RESERVED", "READY"].includes(order.fulfillment_status)) {
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM inventory_reservation
           WHERE tenant_id = $1
             AND sales_order_id = $2
             AND status = 'ACTIVE'`,
          [context.tenantId, input.orderId]
        );

        return {
          orderId: input.orderId,
          fulfillmentStatus:
            order.fulfillment_status as "RESERVED" | "READY",
          reservations: Number(count.rows[0]?.count ?? "0")
        };
      }

      if (["PARTIALLY_SHIPPED", "SHIPPED"].includes(order.fulfillment_status)) {
        throw new ConflictException("Заказ уже передан в отгрузку");
      }

      const warehouseId =
        input.warehouseId ??
        order.warehouse_id ??
        (await this.getDefaultWarehouseId(client, context.tenantId));

      await this.assertWarehouse(client, context.tenantId, warehouseId);

      if(order.owner_type==="CLIENT"){
        await this.assertOwnerContract(
          client,context.tenantId,warehouseId,order.inventory_owner_id
        );
        await this.assertOwnerLedgerEnabled(
          client,context.tenantId,warehouseId
        );
      }

      const ownerLedger=await this.ownerLedgerEnabled(
        client,context.tenantId,warehouseId
      );

      const lines = await client.query<{
        line_id: string;
        sku_id: string | null;
        quantity_milli: string;
        track_inventory: boolean | null;
      }>(
        `SELECT
           l.id AS line_id,
           l.sku_id,
           l.quantity_milli::text,
           s.track_inventory
         FROM sales_order_line l
         LEFT JOIN sku s
           ON s.tenant_id = l.tenant_id AND s.id = l.sku_id
         WHERE l.tenant_id = $1
           AND l.order_id = $2
         ORDER BY l.created_at
         FOR UPDATE OF l`,
        [context.tenantId, input.orderId]
      );

      const stockLines = lines.rows.filter(
        (line) => line.sku_id && line.track_inventory
      );

      if (stockLines.length === 0) {
        await client.query(
          `UPDATE sales_order
           SET warehouse_id = $3,
               fulfillment_status = 'READY',
               version = version + 1,
               updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [context.tenantId, input.orderId, warehouseId]
        );

        return {
          orderId: input.orderId,
          fulfillmentStatus: "READY",
          reservations: 0
        };
      }

      for (const line of stockLines) {
        const quantity = BigInt(line.quantity_milli);
        await this.lockBalance(
          client,
          context.tenantId,
          warehouseId,
          line.sku_id!
        );

        const balance = await client.query<{
          physical_milli: string;
          reserved_milli: string;
        }>(
          `SELECT physical_milli::text, reserved_milli::text
           FROM inventory_balance
           WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
           FOR UPDATE`,
          [context.tenantId, warehouseId, line.sku_id]
        );

        const row = balance.rows[0]!;
        const available =
          BigInt(row.physical_milli) - BigInt(row.reserved_milli);

        if (available < quantity) {
          throw new ConflictException(
            "Недостаточно доступного остатка для резервирования заказа"
          );
        }

        if(ownerLedger){
          const ownerBalance=await client.query<{
            physical_milli:string;
            reserved_milli:string;
          }>(
            `SELECT physical_milli::text,reserved_milli::text
             FROM inventory_owner_balance
             WHERE tenant_id=$1
               AND warehouse_id=$2
               AND owner_id=$3
               AND sku_id=$4
             FOR UPDATE`,
            [
              context.tenantId,warehouseId,
              order.inventory_owner_id,line.sku_id
            ]
          );
          const ownerRow=ownerBalance.rows[0];
          const ownerAvailable=ownerRow
            ? BigInt(ownerRow.physical_milli)-BigInt(ownerRow.reserved_milli)
            : 0n;
          if(ownerAvailable<quantity){
            throw new ConflictException(
              "Недостаточно остатка выбранного владельца товара"
            );
          }
        }
      }

      let reservations = 0;

      for (const line of stockLines) {
        const quantity = BigInt(line.quantity_milli);
        const reservationKey =
          `${input.idempotencyKey}:line:${line.line_id}:warehouse:${warehouseId}`;

        const existing = await client.query<{ id: string }>(
          `SELECT id
           FROM inventory_reservation
           WHERE tenant_id = $1 AND idempotency_key = $2`,
          [context.tenantId, reservationKey]
        );

        if (existing.rowCount) {
          reservations += 1;
          continue;
        }

        if(ownerLedger){
          await this.applyOwnerBalanceDelta(
            client,context,{
              warehouseId,
              ownerId:order.inventory_owner_id,
              skuId:line.sku_id!,
              physicalDelta:0n,
              reservedDelta:quantity,
              movementType:"RESERVE",
              sourceType:"SALES_ORDER",
              sourceId:input.orderId,
              sourceLineId:line.line_id,
              idempotencyKey:"owner-reserve:"+reservationKey
            }
          );
        }

        await client.query(
          `UPDATE inventory_balance
           SET reserved_milli = reserved_milli + $4::bigint,
               updated_at = now()
           WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3`,
          [
            context.tenantId,
            warehouseId,
            line.sku_id,
            quantity.toString()
          ]
        );

        await client.query(
          `INSERT INTO inventory_reservation(
             tenant_id, sales_order_id, sales_order_line_id,
             warehouse_id, sku_id, owner_id, quantity_milli,
             idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            context.tenantId,
            input.orderId,
            line.line_id,
            warehouseId,
            line.sku_id,
            order.inventory_owner_id,
            quantity.toString(),
            reservationKey
          ]
        );

        reservations += 1;
      }

      await client.query(
        `UPDATE sales_order
         SET warehouse_id = $3,
             fulfillment_status = 'RESERVED',
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, input.orderId, warehouseId]
      );

      await this.audit(
        client,
        context,
        "inventory.order_reserved",
        "sales_order",
        input.orderId,
        { warehouseId, reservations }
      );

      return {
        orderId: input.orderId,
        fulfillmentStatus: "RESERVED",
        reservations
      };
    });
  }

  async consumeWmsReservation(
    client: PoolClient,
    context: TenantContext,
    input: {
      reservationId: string;
      idempotencyKey: string;
    }
  ): Promise<{
    applied: boolean;
    orderId: string;
    warehouseId: string;
    skuId: string;
    quantityMilli: string;
  }> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности WMS");
    }

    const reservation = await client.query<{
      id: string;
      sales_order_id: string;
      sales_order_line_id: string;
      warehouse_id: string;
      sku_id: string;
      quantity_milli: string;
      status: string;
      owner_id:string;
    }>(
      `SELECT id,sales_order_id,sales_order_line_id,warehouse_id,sku_id,
              quantity_milli::text,status,owner_id
       FROM inventory_reservation
       WHERE tenant_id=$1 AND id=$2
       FOR UPDATE`,
      [context.tenantId,input.reservationId]
    );

    const row=reservation.rows[0];
    if(!row) throw new NotFoundException("Резерв WMS не найден");

    if(row.status==="CONSUMED"){
      return {
        applied:false,
        orderId:row.sales_order_id,
        warehouseId:row.warehouse_id,
        skuId:row.sku_id,
        quantityMilli:row.quantity_milli
      };
    }
    if(row.status!=="ACTIVE"){
      throw new ConflictException("Резерв WMS уже недоступен для отгрузки");
    }

    const wms=await client.query(
      `SELECT 1
       FROM warehouse_wms_profile
       WHERE tenant_id=$1 AND warehouse_id=$2
         AND status='ACTIVE'
         AND stock_tracking_state='LOCATION_LEDGER'`,
      [context.tenantId,row.warehouse_id]
    );
    if(!wms.rowCount){
      throw new ConflictException("Склад не находится под активным адресным WMS");
    }

    await this.lockBalance(
      client,context.tenantId,row.warehouse_id,row.sku_id
    );

    const balance=await client.query<{
      physical_milli:string;
      reserved_milli:string;
    }>(
      `SELECT physical_milli::text,reserved_milli::text
       FROM inventory_balance
       WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3
       FOR UPDATE`,
      [context.tenantId,row.warehouse_id,row.sku_id]
    );

    const current=balance.rows[0];
    const quantity=BigInt(row.quantity_milli);
    if(
      !current ||
      BigInt(current.physical_milli)<quantity ||
      BigInt(current.reserved_milli)<quantity
    ){
      throw new ConflictException(
        "Inventory Balance не позволяет завершить WMS-отгрузку"
      );
    }

    if(await this.ownerLedgerEnabled(
      client,context.tenantId,row.warehouse_id
    )){
      await this.applyOwnerBalanceDelta(
        client,context,{
          warehouseId:row.warehouse_id,
          ownerId:row.owner_id,
          skuId:row.sku_id,
          physicalDelta:-quantity,
          reservedDelta:-quantity,
          movementType:"SHIPMENT",
          sourceType:"SALES_ORDER",
          sourceId:row.sales_order_id,
          sourceLineId:row.sales_order_line_id,
          idempotencyKey:
            "owner-shipment:"+input.idempotencyKey.trim()
        }
      );
    }

    await client.query(
      `UPDATE inventory_balance
       SET physical_milli=physical_milli-$4::bigint,
           reserved_milli=reserved_milli-$4::bigint,
           updated_at=now()
       WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3`,
      [
        context.tenantId,row.warehouse_id,row.sku_id,quantity.toString()
      ]
    );

    await this.insertMovementOnly(client,context,{
      warehouseId:row.warehouse_id,
      skuId:row.sku_id,
      movementType:"SHIPMENT",
      quantityDeltaMilli:-quantity,
      sourceType:"SALES_ORDER",
      sourceId:row.sales_order_id,
      sourceLineId:row.sales_order_line_id,
      idempotencyKey:input.idempotencyKey.trim(),
      ownerId:row.owner_id
    });

    await client.query(
      `UPDATE inventory_reservation
       SET status='CONSUMED',consumed_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId,row.id]
    );

    return {
      applied:true,
      orderId:row.sales_order_id,
      warehouseId:row.warehouse_id,
      skuId:row.sku_id,
      quantityMilli:row.quantity_milli
    };
  }

  async finalizeWmsOrderShipment(
    client: PoolClient,
    context: TenantContext,
    orderId: string
  ): Promise<{
    fulfillmentStatus:"PARTIALLY_SHIPPED"|"SHIPPED";
    remainingReservations:number;
  }> {
    const order=await client.query<{fulfillment_status:string}>(
      `SELECT fulfillment_status
       FROM sales_order
       WHERE tenant_id=$1 AND id=$2
       FOR UPDATE`,
      [context.tenantId,orderId]
    );
    const row=order.rows[0];
    if(!row) throw new NotFoundException("Заказ не найден");

    const remaining=await client.query<{count:string}>(
      `SELECT count(*)::text AS count
       FROM inventory_reservation
       WHERE tenant_id=$1 AND sales_order_id=$2 AND status='ACTIVE'`,
      [context.tenantId,orderId]
    );

    const remainingReservations=Number(remaining.rows[0]?.count??"0");
    const fulfillmentStatus=
      remainingReservations===0 ? "SHIPPED" : "PARTIALLY_SHIPPED";

    if(row.fulfillment_status!==fulfillmentStatus){
      await client.query(
        `UPDATE sales_order
         SET fulfillment_status=$3,version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,orderId,fulfillmentStatus]
      );

      await this.audit(
        client,
        context,
        fulfillmentStatus==="SHIPPED"
          ? "inventory.order_shipped"
          : "inventory.order_partially_shipped",
        "sales_order",
        orderId,
        {remainingReservations,source:"WMS"}
      );

      await this.events.enqueue(client,context,{
        eventName:
          fulfillmentStatus==="SHIPPED"
            ? "inventory.order_shipped"
            : "inventory.order_partially_shipped",
        entityType:"SALES_ORDER",
        entityId:orderId,
        payload:{
          orderId,
          fulfillmentStatus,
          remainingReservations,
          source:"WMS"
        }
      });
    }

    return {fulfillmentStatus,remainingReservations};
  }

  async shipOrder(
    context: TenantContext,
    input: {
      orderId: string;
      idempotencyKey: string;
    },
    options?: {
      allowWms?: boolean;
    }
  ): Promise<{ orderId: string; fulfillmentStatus: "SHIPPED" }> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const order = await client.query<{
        id: string;
        order_status: string;
        fulfillment_status: string;
      }>(
        `SELECT id, order_status, fulfillment_status
         FROM sales_order
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, input.orderId]
      );

      const row = order.rows[0];
      if (!row) throw new NotFoundException("Заказ не найден");

      if (row.fulfillment_status === "SHIPPED") {
        return { orderId: input.orderId, fulfillmentStatus: "SHIPPED" };
      }

      if (row.fulfillment_status === "READY") {
        await client.query(
          `UPDATE sales_order
           SET fulfillment_status = 'SHIPPED',
               version = version + 1,
               updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [context.tenantId, input.orderId]
        );

        await this.audit(
          client,
          context,
          "inventory.order_shipped",
          "sales_order",
          input.orderId,
          { inventoryMovements: 0, warehouses: [] }
        );

        await this.events.enqueue(client, context, {
          eventName: "inventory.order_shipped",
          entityType: "SALES_ORDER",
          entityId: input.orderId,
          payload: {
            orderId: input.orderId,
            warehouseIds: [],
            fulfillmentStatus: "SHIPPED"
          }
        });

        return {
          orderId: input.orderId,
          fulfillmentStatus: "SHIPPED"
        };
      }

      if (row.fulfillment_status !== "RESERVED") {
        throw new BadRequestException("Заказ должен быть зарезервирован");
      }

      const reservations = await client.query<{
        id: string;
        sales_order_line_id: string;
        warehouse_id: string;
        sku_id: string;
        quantity_milli: string;
      }>(
        `SELECT
           id,
           sales_order_line_id,
           warehouse_id,
           sku_id,
           quantity_milli::text
         FROM inventory_reservation
         WHERE tenant_id = $1
           AND sales_order_id = $2
           AND status = 'ACTIVE'
         ORDER BY warehouse_id, created_at
         FOR UPDATE`,
        [context.tenantId, input.orderId]
      );

      if (!reservations.rowCount) {
        throw new ConflictException("Активные резервы заказа не найдены");
      }

      const reservationWarehouseIds = Array.from(
        new Set(reservations.rows.map((reservation) => reservation.warehouse_id))
      );

      const wmsWarehouses = await client.query<{ warehouse_id: string }>(
        `SELECT warehouse_id
         FROM warehouse_wms_profile
         WHERE tenant_id=$1
           AND warehouse_id=ANY($2::uuid[])
           AND status='ACTIVE'
           AND stock_tracking_state='LOCATION_LEDGER'`,
        [context.tenantId, reservationWarehouseIds]
      );

      if (wmsWarehouses.rowCount && !options?.allowWms) {
        throw new ConflictException(
          "Адресный WMS требует отбор и отгрузку через WMS-задачи"
        );
      }

      const wmsWarehouseIds = new Set(
        wmsWarehouses.rows.map((item) => item.warehouse_id)
      );

      const warehouseIds = new Set<string>();

      for (const reservation of reservations.rows) {
        warehouseIds.add(reservation.warehouse_id);

        await this.lockBalance(
          client,
          context.tenantId,
          reservation.warehouse_id,
          reservation.sku_id
        );

        const quantity = BigInt(reservation.quantity_milli);

        const balance = await client.query<{
          physical_milli: string;
          reserved_milli: string;
        }>(
          `SELECT physical_milli::text, reserved_milli::text
           FROM inventory_balance
           WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
           FOR UPDATE`,
          [
            context.tenantId,
            reservation.warehouse_id,
            reservation.sku_id
          ]
        );

        const current = balance.rows[0]!;
        if (
          BigInt(current.physical_milli) < quantity ||
          BigInt(current.reserved_milli) < quantity
        ) {
          throw new ConflictException(
            "Складской баланс изменился и требует повторного allocation"
          );
        }

        if (
          options?.allowWms &&
          wmsWarehouseIds.has(reservation.warehouse_id)
        ) {
          const allocations = await client.query<{
            id: string;
            outbound_location_id: string;
            quantity_milli: string;
            status: string;
          }>(
            `SELECT
               id,outbound_location_id,quantity_milli::text,status
             FROM wms_pick_allocation
             WHERE tenant_id=$1
               AND reservation_id=$2
             ORDER BY created_at
             FOR UPDATE`,
            [context.tenantId, reservation.id]
          );

          if (!allocations.rowCount) {
            throw new ConflictException(
              "WMS allocation для резерва отсутствует"
            );
          }

          const packedQuantity = allocations.rows.reduce(
            (sum, allocation) => {
              if (allocation.status !== "PACKED") {
                throw new ConflictException(
                  "Не все WMS allocations упакованы"
                );
              }
              return sum + BigInt(allocation.quantity_milli);
            },
            0n
          );

          if (packedQuantity !== quantity) {
            throw new ConflictException(
              "Количество WMS allocations не совпадает с резервом"
            );
          }

          for (const allocation of allocations.rows) {
            const outbound = await client.query<{
              physical_milli: string;
            }>(
              `SELECT physical_milli::text
               FROM warehouse_location_balance
               WHERE tenant_id=$1
                 AND warehouse_id=$2
                 AND location_id=$3
                 AND sku_id=$4
               FOR UPDATE`,
              [
                context.tenantId,
                reservation.warehouse_id,
                allocation.outbound_location_id,
                reservation.sku_id
              ]
            );

            const allocationQuantity = BigInt(
              allocation.quantity_milli
            );

            if (
              BigInt(outbound.rows[0]?.physical_milli ?? "0") <
              allocationQuantity
            ) {
              throw new ConflictException(
                "В зоне отгрузки недостаточно товара"
              );
            }
          }
        }

        await client.query(
          `UPDATE inventory_balance
           SET physical_milli = physical_milli - $4::bigint,
               reserved_milli = reserved_milli - $4::bigint,
               updated_at = now()
           WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3`,
          [
            context.tenantId,
            reservation.warehouse_id,
            reservation.sku_id,
            quantity.toString()
          ]
        );

        await this.insertMovementOnly(client, context, {
          warehouseId: reservation.warehouse_id,
          skuId: reservation.sku_id,
          movementType: "SHIPMENT",
          quantityDeltaMilli: -quantity,
          sourceType: "SALES_ORDER",
          sourceId: input.orderId,
          sourceLineId: reservation.sales_order_line_id,
          idempotencyKey:
            `${input.idempotencyKey}:reservation:${reservation.id}`
        });

        await client.query(
          `UPDATE inventory_reservation
           SET status = 'CONSUMED', consumed_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [context.tenantId, reservation.id]
        );

        if (
          options?.allowWms &&
          wmsWarehouseIds.has(reservation.warehouse_id)
        ) {
          const allocations = await client.query<{
            id: string;
            outbound_location_id: string;
            quantity_milli: string;
          }>(
            `SELECT id,outbound_location_id,quantity_milli::text
             FROM wms_pick_allocation
             WHERE tenant_id=$1
               AND reservation_id=$2
               AND status='PACKED'
             ORDER BY created_at
             FOR UPDATE`,
            [context.tenantId, reservation.id]
          );

          for (const allocation of allocations.rows) {
            await client.query(
              `UPDATE warehouse_location_balance
               SET physical_milli=physical_milli-$5::bigint,
                   updated_at=now()
               WHERE tenant_id=$1
                 AND warehouse_id=$2
                 AND location_id=$3
                 AND sku_id=$4`,
              [
                context.tenantId,
                reservation.warehouse_id,
                allocation.outbound_location_id,
                reservation.sku_id,
                allocation.quantity_milli
              ]
            );

            await client.query(
              `INSERT INTO wms_location_movement(
                 tenant_id,warehouse_id,sku_id,movement_type,
                 from_location_id,quantity_milli,
                 source_type,source_id,idempotency_key,
                 actor_membership_id
               ) VALUES (
                 $1,$2,$3,'SHIP',
                 $4,$5,
                 'SALES_ORDER',$6,$7,$8
               )
               ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
              [
                context.tenantId,
                reservation.warehouse_id,
                reservation.sku_id,
                allocation.outbound_location_id,
                allocation.quantity_milli,
                input.orderId,
                "wms-ship-allocation:" + allocation.id,
                context.membershipId
              ]
            );

            await client.query(
              `UPDATE wms_pick_allocation
               SET status='SHIPPED',shipped_at=now()
               WHERE tenant_id=$1 AND id=$2`,
              [context.tenantId, allocation.id]
            );
          }
        }
      }

      await client.query(
        `UPDATE sales_order
         SET fulfillment_status = 'SHIPPED',
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, input.orderId]
      );

      const warehouses = Array.from(warehouseIds);

      await this.audit(
        client,
        context,
        "inventory.order_shipped",
        "sales_order",
        input.orderId,
        {
          inventoryMovements: reservations.rowCount ?? 0,
          warehouses
        }
      );

      await this.events.enqueue(client, context, {
        eventName: "inventory.order_shipped",
        entityType: "SALES_ORDER",
        entityId: input.orderId,
        payload: {
          orderId: input.orderId,
          warehouseIds: warehouses,
          fulfillmentStatus: "SHIPPED"
        }
      });

      return {
        orderId: input.orderId,
        fulfillmentStatus: "SHIPPED"
      };
    });
  }

  async transfer(
    context: TenantContext,
    input: {
      fromWarehouseId: string;
      toWarehouseId: string;
      idempotencyKey: string;
      lines: Array<{ skuId: string; quantityMilli: string }>;
    }
  ): Promise<{ transferId: string; number: string; applied: boolean }> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new BadRequestException("Склады отправления и назначения совпадают");
    }
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }
    if (!input.lines?.length) {
      throw new BadRequestException("Добавьте позиции перемещения");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await client.query<{ id: string; business_number: string; status: string }>(
        `SELECT id, business_number, status
         FROM inventory_transfer
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [context.tenantId, input.idempotencyKey.trim()]
      );

      if (existing.rows[0]) {
        return {
          transferId: existing.rows[0].id,
          number: existing.rows[0].business_number,
          applied: existing.rows[0].status === "POSTED"
        };
      }

      await this.assertWarehouse(client, context.tenantId, input.fromWarehouseId);
      await this.assertWarehouse(client, context.tenantId, input.toWarehouseId);

      const prepared = input.lines.map((line) => {
        if (!/^\d+$/.test(line.quantityMilli)) {
          throw new BadRequestException("Некорректное количество");
        }
        const quantity = BigInt(line.quantityMilli);
        if (quantity <= 0n) {
          throw new BadRequestException("Количество должно быть больше нуля");
        }
        return { ...line, quantity };
      });

      for (const line of prepared) {
        await this.assertSku(client, context.tenantId, line.skuId);
        await this.lockBalance(
          client,
          context.tenantId,
          input.fromWarehouseId,
          line.skuId
        );

        const balance = await client.query<{
          physical_milli: string;
          reserved_milli: string;
        }>(
          `SELECT physical_milli::text, reserved_milli::text
           FROM inventory_balance
           WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
           FOR UPDATE`,
          [context.tenantId, input.fromWarehouseId, line.skuId]
        );

        const row = balance.rows[0]!;
        const available =
          BigInt(row.physical_milli) - BigInt(row.reserved_milli);

        if (available < line.quantity) {
          throw new ConflictException(
            "Недостаточно доступного остатка для перемещения"
          );
        }
      }

      const number = await this.nextNumber(
        client,
        context.tenantId,
        "inventory_transfer",
        "TR"
      );

      const transferResult = await client.query<{ id: string }>(
        `INSERT INTO inventory_transfer(
           tenant_id, business_number, from_warehouse_id, to_warehouse_id,
           status, idempotency_key, created_by_membership_id,
           posted_by_membership_id, posted_at
         ) VALUES ($1,$2,$3,$4,'POSTED',$5,$6,$6,now())
         RETURNING id`,
        [
          context.tenantId,
          number,
          input.fromWarehouseId,
          input.toWarehouseId,
          input.idempotencyKey.trim(),
          context.membershipId
        ]
      );

      const transfer = transferResult.rows[0];
      if (!transfer) throw new Error("INVENTORY_TRANSFER_CREATE_FAILED");

      for (const line of prepared) {
        const lineResult = await client.query<{ id: string }>(
          `INSERT INTO inventory_transfer_line(
             tenant_id, transfer_id, sku_id, quantity_milli
           ) VALUES ($1,$2,$3,$4)
           RETURNING id`,
          [
            context.tenantId,
            transfer.id,
            line.skuId,
            line.quantity.toString()
          ]
        );

        const transferLine = lineResult.rows[0];
        if (!transferLine) throw new Error("INVENTORY_TRANSFER_LINE_CREATE_FAILED");

        await this.postMovement(client, context, {
          warehouseId: input.fromWarehouseId,
          skuId: line.skuId,
          movementType: "TRANSFER_OUT",
          quantityDeltaMilli: -line.quantity,
          sourceType: "INVENTORY_TRANSFER",
          sourceId: transfer.id,
          sourceLineId: transferLine.id,
          idempotencyKey: `transfer:${transfer.id}:line:${transferLine.id}:out`
        });

        await this.postMovement(client, context, {
          warehouseId: input.toWarehouseId,
          skuId: line.skuId,
          movementType: "TRANSFER_IN",
          quantityDeltaMilli: line.quantity,
          sourceType: "INVENTORY_TRANSFER",
          sourceId: transfer.id,
          sourceLineId: transferLine.id,
          idempotencyKey: `transfer:${transfer.id}:line:${transferLine.id}:in`
        });
      }

      await this.audit(
        client,
        context,
        "inventory.transfer_posted",
        "inventory_transfer",
        transfer.id,
        {
          number,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId
        }
      );

      await this.events.enqueue(client, context, {
        eventName: "inventory.transfer_posted",
        entityType: "INVENTORY_TRANSFER",
        entityId: transfer.id,
        payload: {
          transferId: transfer.id,
          number,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId
        }
      });

      return {
        transferId: transfer.id,
        number,
        applied: true
      };
    });
  }

  async createStockCount(
    context: TenantContext,
    warehouseId: string
  ): Promise<{
    stockCountId: string;
    number: string;
    lines: number;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertWarehouse(client, context.tenantId, warehouseId);

      const number = await this.nextNumber(
        client,
        context.tenantId,
        "stock_count",
        "SC"
      );

      const result = await client.query<{ id: string }>(
        `INSERT INTO stock_count(
           tenant_id, warehouse_id, business_number,
           status, created_by_membership_id
         ) VALUES ($1,$2,$3,'IN_PROGRESS',$4)
         RETURNING id`,
        [context.tenantId, warehouseId, number, context.membershipId]
      );

      const count = result.rows[0];
      if (!count) throw new Error("STOCK_COUNT_CREATE_FAILED");

      const linesResult = await client.query<{ count: string }>(
        `WITH inserted AS (
           INSERT INTO stock_count_line(
             tenant_id, stock_count_id, sku_id, expected_milli
           )
           SELECT $1, $2, s.id, COALESCE(b.physical_milli, 0)
           FROM sku s
           LEFT JOIN inventory_balance b
             ON b.tenant_id = s.tenant_id
            AND b.sku_id = s.id
            AND b.warehouse_id = $3
           WHERE s.tenant_id = $1
             AND s.status = 'ACTIVE'
             AND s.track_inventory = true
           RETURNING 1
         )
         SELECT count(*)::text AS count FROM inserted`,
        [context.tenantId, count.id, warehouseId]
      );

      await this.audit(
        client,
        context,
        "inventory.stock_count_started",
        "stock_count",
        count.id,
        { number, warehouseId }
      );

      return {
        stockCountId: count.id,
        number,
        lines: Number(linesResult.rows[0]?.count ?? "0")
      };
    });
  }

  async stockCountLines(
    context: TenantContext,
    stockCountId: string
  ): Promise<Array<{
    id: string;
    skuId: string;
    sku: string;
    productName: string;
    expectedMilli: string;
    countedMilli: string | null;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        sku_id: string;
        sku_code: string;
        product_name: string;
        expected_milli: string;
        counted_milli: string | null;
      }>(
        `SELECT
           l.id,
           l.sku_id,
           s.code AS sku_code,
           p.name AS product_name,
           l.expected_milli::text,
           l.counted_milli::text
         FROM stock_count_line l
         JOIN stock_count c
           ON c.tenant_id = l.tenant_id AND c.id = l.stock_count_id
         JOIN sku s
           ON s.tenant_id = l.tenant_id AND s.id = l.sku_id
         JOIN product_variant v
           ON v.tenant_id = s.tenant_id AND v.id = s.variant_id
         JOIN product p
           ON p.tenant_id = v.tenant_id AND p.id = v.product_id
         WHERE l.tenant_id = $1
           AND l.stock_count_id = $2
         ORDER BY p.name, s.code`,
        [context.tenantId, stockCountId]
      );

      return result.rows.map((row) => ({
        id: row.id,
        skuId: row.sku_id,
        sku: row.sku_code,
        productName: row.product_name,
        expectedMilli: row.expected_milli,
        countedMilli: row.counted_milli
      }));
    });
  }

  async updateStockCountLine(
    context: TenantContext,
    stockCountId: string,
    lineId: string,
    countedMilli: string
  ): Promise<void> {
    if (!/^\d+$/.test(countedMilli)) {
      throw new BadRequestException("Некорректное фактическое количество");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE stock_count_line l
         SET counted_milli = $4::bigint
         FROM stock_count c
         WHERE l.tenant_id = $1
           AND l.stock_count_id = $2
           AND l.id = $3
           AND c.tenant_id = l.tenant_id
           AND c.id = l.stock_count_id
           AND c.status = 'IN_PROGRESS'
         RETURNING l.id`,
        [context.tenantId, stockCountId, lineId, countedMilli]
      );

      if (!result.rowCount) {
        throw new NotFoundException("Строка инвентаризации недоступна");
      }
    });
  }

  async postStockCount(
    context: TenantContext,
    stockCountId: string
  ): Promise<{ stockCountId: string; adjustments: number }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const countResult = await client.query<{
        id: string;
        warehouse_id: string;
        status: string;
      }>(
        `SELECT id, warehouse_id, status
         FROM stock_count
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, stockCountId]
      );

      const count = countResult.rows[0];
      if (!count) throw new NotFoundException("Инвентаризация не найдена");
      if (count.status === "POSTED") {
        return { stockCountId, adjustments: 0 };
      }
      if (count.status !== "IN_PROGRESS") {
        throw new BadRequestException("Инвентаризацию нельзя провести");
      }

      const lines = await client.query<{
        id: string;
        sku_id: string;
        expected_milli: string;
        counted_milli: string | null;
      }>(
        `SELECT id, sku_id, expected_milli::text, counted_milli::text
         FROM stock_count_line
         WHERE tenant_id = $1 AND stock_count_id = $2
         FOR UPDATE`,
        [context.tenantId, stockCountId]
      );

      const uncounted = lines.rows.find((line) => line.counted_milli === null);
      if (uncounted) {
        throw new BadRequestException(
          "Заполните фактическое количество по всем позициям"
        );
      }

      let adjustments = 0;

      for (const line of lines.rows) {
        const counted = BigInt(line.counted_milli!);

        await this.lockBalance(
          client,
          context.tenantId,
          count.warehouse_id,
          line.sku_id
        );

        const currentBalance = await client.query<{ physical_milli: string }>(
          `SELECT physical_milli::text
           FROM inventory_balance
           WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
           FOR UPDATE`,
          [context.tenantId, count.warehouse_id, line.sku_id]
        );

        const currentPhysical =
          BigInt(currentBalance.rows[0]?.physical_milli ?? "0");
        const delta = counted - currentPhysical;

        if (delta === 0n) continue;

        await this.postMovement(client, context, {
          warehouseId: count.warehouse_id,
          skuId: line.sku_id,
          movementType: "ADJUSTMENT",
          quantityDeltaMilli: delta,
          sourceType: "STOCK_COUNT",
          sourceId: stockCountId,
          sourceLineId: line.id,
          reason: "Инвентаризация",
          idempotencyKey: `stock-count:${stockCountId}:line:${line.id}`
        });

        adjustments += 1;
      }

      await client.query(
        `UPDATE stock_count
         SET status = 'POSTED',
             posted_by_membership_id = $3,
             posted_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, stockCountId, context.membershipId]
      );

      await this.audit(
        client,
        context,
        "inventory.stock_count_posted",
        "stock_count",
        stockCountId,
        { adjustments }
      );

      await this.events.enqueue(client, context, {
        eventName: "inventory.stock_count_posted",
        entityType: "STOCK_COUNT",
        entityId: stockCountId,
        payload: {
          stockCountId,
          warehouseId: count.warehouse_id,
          adjustments
        }
      });

      return { stockCountId, adjustments };
    });
  }


  async receiveCustomerReturn(
    client: PoolClient,
    context: TenantContext,
    input: {
      returnRequestId: string;
      returnLineId: string;
      warehouseId: string;
      skuId: string;
      quantityMilli: bigint;
      idempotencyKey: string;
    }
  ): Promise<{ movementId: string; applied: boolean }> {
    if (input.quantityMilli <= 0n) {
      throw new BadRequestException("Количество возврата должно быть больше нуля");
    }
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return this.postMovement(client, context, {
      warehouseId: input.warehouseId,
      skuId: input.skuId,
      movementType: "RETURN",
      quantityDeltaMilli: input.quantityMilli,
      sourceType: "RETURN_REQUEST",
      sourceId: input.returnRequestId,
      sourceLineId: input.returnLineId,
      reason: "Возврат клиента в доступный остаток",
      idempotencyKey:
        "return-request:" +
        input.returnRequestId +
        ":line:" +
        input.returnLineId +
        ":" +
        input.idempotencyKey.trim()
    });
  }

  async releaseOrderReservations(
    client: PoolClient,
    context: TenantContext,
    input: {
      orderId: string;
      reason: string;
    }
  ): Promise<number> {
    const reservations = await client.query<{
      id: string;
      warehouse_id: string;
      sku_id: string;
      quantity_milli: string;
    }>(
      `SELECT id,warehouse_id,sku_id,quantity_milli::text
       FROM inventory_reservation
       WHERE tenant_id=$1
         AND sales_order_id=$2
         AND status='ACTIVE'
       ORDER BY warehouse_id,id
       FOR UPDATE`,
      [context.tenantId, input.orderId]
    );

    let released = 0;

    for (const reservation of reservations.rows) {
      await this.lockBalance(
        client,
        context.tenantId,
        reservation.warehouse_id,
        reservation.sku_id
      );

      const quantity = BigInt(reservation.quantity_milli);
      const balance = await client.query<{ reserved_milli: string }>(
        `SELECT reserved_milli::text
         FROM inventory_balance
         WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3
         FOR UPDATE`,
        [
          context.tenantId,
          reservation.warehouse_id,
          reservation.sku_id
        ]
      );

      if (BigInt(balance.rows[0]?.reserved_milli ?? "0") < quantity) {
        throw new ConflictException(
          "Резерв склада меньше reservation; требуется ручная сверка"
        );
      }

      await client.query(
        `UPDATE inventory_balance
         SET reserved_milli=reserved_milli-$4::bigint,
             updated_at=now()
         WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3`,
        [
          context.tenantId,
          reservation.warehouse_id,
          reservation.sku_id,
          quantity.toString()
        ]
      );

      await client.query(
        `UPDATE inventory_reservation
         SET status='RELEASED',released_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, reservation.id]
      );

      released += 1;
    }

    if (released > 0) {
      await this.audit(
        client,
        context,
        "inventory.order_reservations_released",
        "sales_order",
        input.orderId,
        { released, reason: input.reason }
      );
    }

    return released;
  }


  async consumeForService(
    client: PoolClient,
    context: TenantContext,
    input: {
      bookingId: string;
      warehouseId: string;
      materialLineId: string;
      skuId: string;
      quantityMilli: bigint;
      idempotencyKey: string;
    }
  ): Promise<{ applied: boolean }> {
    if (input.quantityMilli <= 0n) {
      throw new BadRequestException("Количество расхода должно быть больше нуля");
    }
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    const movement = await this.postMovement(client, context, {
      warehouseId: input.warehouseId,
      skuId: input.skuId,
      movementType: "WRITE_OFF",
      quantityDeltaMilli: -input.quantityMilli,
      sourceType: "SERVICE_BOOKING",
      sourceId: input.bookingId,
      sourceLineId: input.materialLineId,
      reason: "Расход материала по услуге",
      idempotencyKey:
        "service-booking:" +
        input.bookingId +
        ":material:" +
        input.materialLineId +
        ":" +
        input.idempotencyKey.trim()
    });

    return { applied: movement.applied };
  }

  private async nextNumber(
    client: PoolClient,
    tenantId: string,
    counterKey: string,
    prefix: string
  ): Promise<string> {
    const counter = await client.query<{ value: string }>(
      `INSERT INTO tenant_counter(tenant_id, counter_key, value)
       VALUES ($1,$2,1)
       ON CONFLICT (tenant_id, counter_key)
       DO UPDATE SET
         value = tenant_counter.value + 1,
         updated_at = now()
       RETURNING value::text`,
      [tenantId, counterKey]
    );

    const sequence = BigInt(counter.rows[0]?.value ?? "0");
    const year = new Date().getUTCFullYear();
    return `${prefix}-${year}-${sequence.toString().padStart(6, "0")}`;
  }

  private async postMovement(
    client: PoolClient,
    context: TenantContext,
    input: MovementInput
  ): Promise<{ movementId: string; applied: boolean }> {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM inventory_transaction
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [context.tenantId, input.idempotencyKey]
    );

    if (existing.rows[0]) {
      return {
        movementId: existing.rows[0].id,
        applied: false
      };
    }

    await this.assertWarehouse(client, context.tenantId, input.warehouseId);
    await this.assertSku(client, context.tenantId, input.skuId);

    const owner=await this.resolveOwner(
      client,context.tenantId,input.ownerId
    );
    input.ownerId=owner.id;

    if(owner.ownerType==="CLIENT"){
      await this.assertOwnerContract(
        client,context.tenantId,input.warehouseId,owner.id
      );
      await this.assertOwnerLedgerEnabled(
        client,context.tenantId,input.warehouseId
      );
    }

    if (input.movementType !== "RECEIPT") {
      const wms = await client.query(
        `SELECT 1
         FROM warehouse_wms_profile
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND status='ACTIVE'
           AND stock_tracking_state='LOCATION_LEDGER'`,
        [context.tenantId, input.warehouseId]
      );

      if (wms.rowCount) {
        throw new ConflictException(
          "Для адресного WMS эта операция должна выполняться через WMS-задачу"
        );
      }
    }
    await this.lockBalance(
      client,
      context.tenantId,
      input.warehouseId,
      input.skuId
    );

    const balance = await client.query<{
      physical_milli: string;
      reserved_milli: string;
    }>(
      `SELECT physical_milli::text, reserved_milli::text
       FROM inventory_balance
       WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
       FOR UPDATE`,
      [context.tenantId, input.warehouseId, input.skuId]
    );

    const current = balance.rows[0]!;
    const nextPhysical =
      BigInt(current.physical_milli) + input.quantityDeltaMilli;
    const reserved = BigInt(current.reserved_milli);

    if (nextPhysical < 0n || nextPhysical < reserved) {
      throw new ConflictException(
        "Операция приведёт к отрицательному или зарезервированному остатку"
      );
    }

    if(await this.ownerLedgerEnabled(
      client,context.tenantId,input.warehouseId
    )){
      await this.applyOwnerBalanceDelta(
        client,context,{
          warehouseId:input.warehouseId,
          ownerId:owner.id,
          skuId:input.skuId,
          physicalDelta:input.quantityDeltaMilli,
          reservedDelta:0n,
          movementType:this.ownerPhysicalMovementType(input.movementType),
          sourceType:input.sourceType??"INVENTORY",
          sourceId:input.sourceId,
          sourceLineId:input.sourceLineId,
          idempotencyKey:"owner-movement:"+input.idempotencyKey
        }
      );
    }

    const movement = await this.insertMovementOnly(client, context, input);

    await client.query(
      `UPDATE inventory_balance
       SET physical_milli = $4::bigint,
           updated_at = now()
       WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3`,
      [
        context.tenantId,
        input.warehouseId,
        input.skuId,
        nextPhysical.toString()
      ]
    );

    return {
      movementId: movement.id,
      applied: true
    };
  }

  private async insertMovementOnly(
    client: PoolClient,
    context: TenantContext,
    input: MovementInput
  ): Promise<{ id: string }> {
    const owner=await this.resolveOwner(
      client,context.tenantId,input.ownerId
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO inventory_transaction(
         tenant_id, warehouse_id, sku_id, owner_id, movement_type,
         quantity_delta_milli, unit_cost_minor,
         source_type, source_id, source_line_id,
         reason, idempotency_key, actor_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        context.tenantId,
        input.warehouseId,
        input.skuId,
        owner.id,
        input.movementType,
        input.quantityDeltaMilli.toString(),
        input.unitCostMinor?.toString() ?? null,
        input.sourceType ?? null,
        input.sourceId ?? null,
        input.sourceLineId ?? null,
        input.reason ?? null,
        input.idempotencyKey,
        context.membershipId
      ]
    );

    const row = result.rows[0];
    if (!row) throw new Error("INVENTORY_MOVEMENT_CREATE_FAILED");
    return row;
  }

  private async resolveOwner(
    client:PoolClient,
    tenantId:string,
    requestedOwnerId?:string
  ):Promise<{id:string;ownerType:"INTERNAL"|"CLIENT"}>{
    const result=await client.query<{
      id:string;
      owner_type:"INTERNAL"|"CLIENT";
    }>(
      requestedOwnerId
        ? `SELECT id,owner_type
           FROM inventory_owner
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`
        : `SELECT id,owner_type
           FROM inventory_owner
           WHERE tenant_id=$1
             AND is_default=true
             AND status='ACTIVE'
           LIMIT 1`,
      requestedOwnerId
        ? [tenantId,requestedOwnerId]
        : [tenantId]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Владелец товара не найден");
    return {id:row.id,ownerType:row.owner_type};
  }

  private async ownerLedgerEnabled(
    client:PoolClient,
    tenantId:string,
    warehouseId:string
  ):Promise<boolean>{
    const result=await client.query<{owner_tracking_state:string}>(
      `SELECT owner_tracking_state
       FROM warehouse_wms_profile
       WHERE tenant_id=$1 AND warehouse_id=$2 AND status='ACTIVE'`,
      [tenantId,warehouseId]
    );
    return result.rows[0]?.owner_tracking_state==="OWNER_LEDGER";
  }

  private async assertOwnerLedgerEnabled(
    client:PoolClient,
    tenantId:string,
    warehouseId:string
  ):Promise<void>{
    if(!await this.ownerLedgerEnabled(client,tenantId,warehouseId)){
      throw new ConflictException(
        "Для операций 3PL сначала включите OWNER_LEDGER на складе"
      );
    }
  }

  private async assertOwnerContract(
    client:PoolClient,
    tenantId:string,
    warehouseId:string,
    ownerId:string
  ):Promise<void>{
    const result=await client.query(
      `SELECT 1
       FROM warehouse_3pl_contract
       WHERE tenant_id=$1
         AND warehouse_id=$2
         AND owner_id=$3
         AND status='ACTIVE'`,
      [tenantId,warehouseId,ownerId]
    );
    if(!result.rowCount){
      throw new ConflictException(
        "Для владельца товара нет активного 3PL-контракта на этом складе"
      );
    }
  }

  private ownerPhysicalMovementType(
    movementType:MovementInput["movementType"]
  ):
    |"RECEIPT"|"SHIPMENT"|"RETURN"|"ADJUSTMENT"
    |"TRANSFER_IN"|"TRANSFER_OUT"{
    if(movementType==="RECEIPT") return "RECEIPT";
    if(movementType==="SHIPMENT") return "SHIPMENT";
    if(movementType==="RETURN") return "RETURN";
    if(movementType==="TRANSFER_IN") return "TRANSFER_IN";
    if(movementType==="TRANSFER_OUT") return "TRANSFER_OUT";
    return "ADJUSTMENT";
  }

  private async applyOwnerBalanceDelta(
    client:PoolClient,
    context:TenantContext,
    input:{
      warehouseId:string;
      ownerId:string;
      skuId:string;
      physicalDelta:bigint;
      reservedDelta:bigint;
      movementType:
        |"BOOTSTRAP"|"RECEIPT"|"RESERVE"|"RELEASE"|"SHIPMENT"
        |"RETURN"|"ADJUSTMENT"|"TRANSFER_IN"|"TRANSFER_OUT";
      sourceType:string;
      sourceId?:string;
      sourceLineId?:string;
      idempotencyKey:string;
    }
  ):Promise<void>{
    const existing=await client.query(
      `SELECT 1 FROM inventory_owner_movement
       WHERE tenant_id=$1 AND idempotency_key=$2`,
      [context.tenantId,input.idempotencyKey]
    );
    if(existing.rowCount) return;

    await client.query(
      `INSERT INTO inventory_owner_balance(
         tenant_id,warehouse_id,owner_id,sku_id,
         physical_milli,reserved_milli
       ) VALUES ($1,$2,$3,$4,0,0)
       ON CONFLICT (tenant_id,warehouse_id,owner_id,sku_id) DO NOTHING`,
      [
        context.tenantId,input.warehouseId,input.ownerId,input.skuId
      ]
    );

    const balance=await client.query<{
      physical_milli:string;
      reserved_milli:string;
    }>(
      `SELECT physical_milli::text,reserved_milli::text
       FROM inventory_owner_balance
       WHERE tenant_id=$1
         AND warehouse_id=$2
         AND owner_id=$3
         AND sku_id=$4
       FOR UPDATE`,
      [
        context.tenantId,input.warehouseId,input.ownerId,input.skuId
      ]
    );
    const row=balance.rows[0]!;
    const nextPhysical=
      BigInt(row.physical_milli)+input.physicalDelta;
    const nextReserved=
      BigInt(row.reserved_milli)+input.reservedDelta;

    if(
      nextPhysical<0n ||
      nextReserved<0n ||
      nextReserved>nextPhysical
    ){
      throw new ConflictException(
        "Owner balance не позволяет выполнить операцию"
      );
    }

    await client.query(
      `UPDATE inventory_owner_balance
       SET physical_milli=$5,
           reserved_milli=$6,
           updated_at=now()
       WHERE tenant_id=$1
         AND warehouse_id=$2
         AND owner_id=$3
         AND sku_id=$4`,
      [
        context.tenantId,input.warehouseId,input.ownerId,input.skuId,
        nextPhysical.toString(),nextReserved.toString()
      ]
    );

    await client.query(
      `INSERT INTO inventory_owner_movement(
         tenant_id,warehouse_id,owner_id,sku_id,movement_type,
         physical_delta_milli,reserved_delta_milli,
         source_type,source_id,source_line_id,
         idempotency_key,actor_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        context.tenantId,input.warehouseId,input.ownerId,input.skuId,
        input.movementType,input.physicalDelta.toString(),
        input.reservedDelta.toString(),input.sourceType,
        input.sourceId??null,input.sourceLineId??null,
        input.idempotencyKey,context.membershipId
      ]
    );
  }

  private async receiveOwnerIntoUnassigned(
    client:PoolClient,
    context:TenantContext,
    input:{
      warehouseId:string;
      ownerId:string;
      skuId:string;
      quantityMilli:bigint;
      receiptId:string;
      sourceLineId:string;
    }
  ):Promise<void>{
    if(!await this.ownerLedgerEnabled(
      client,context.tenantId,input.warehouseId
    )) return;

    const location=await client.query<{id:string}>(
      `SELECT id
       FROM warehouse_location
       WHERE tenant_id=$1
         AND warehouse_id=$2
         AND is_system=true
         AND code='UNASSIGNED'
         AND status='ACTIVE'
       LIMIT 1
       FOR UPDATE`,
      [context.tenantId,input.warehouseId]
    );
    const locationId=location.rows[0]?.id;
    if(!locationId){
      throw new ConflictException(
        "Owner receipt требует системную WMS-ячейку UNASSIGNED"
      );
    }

    await client.query(
      `INSERT INTO warehouse_location_owner_balance(
         tenant_id,warehouse_id,owner_id,location_id,sku_id,physical_milli
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (
         tenant_id,warehouse_id,owner_id,location_id,sku_id
       )
       DO UPDATE SET
         physical_milli=
           warehouse_location_owner_balance.physical_milli+
           EXCLUDED.physical_milli,
         updated_at=now()`,
      [
        context.tenantId,input.warehouseId,input.ownerId,
        locationId,input.skuId,input.quantityMilli.toString()
      ]
    );

    await client.query(
      `INSERT INTO warehouse_location_owner_movement(
         tenant_id,warehouse_id,owner_id,sku_id,movement_type,
         to_location_id,quantity_milli,
         source_type,source_id,source_line_id,
         idempotency_key,actor_membership_id
       ) VALUES (
         $1,$2,$3,$4,'RECEIPT',
         $5,$6,
         'GOODS_RECEIPT',$7,$8,$9,$10
       )
       ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
      [
        context.tenantId,input.warehouseId,input.ownerId,input.skuId,
        locationId,input.quantityMilli.toString(),
        input.receiptId,input.sourceLineId,
        "owner-wms-receipt:"+input.receiptId+":"+input.sourceLineId,
        context.membershipId
      ]
    );
  }

  private async lockBalance(
    client: PoolClient,
    tenantId: string,
    warehouseId: string,
    skuId: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO inventory_balance(
         tenant_id, warehouse_id, sku_id, physical_milli, reserved_milli
       ) VALUES ($1,$2,$3,0,0)
       ON CONFLICT (tenant_id, warehouse_id, sku_id) DO NOTHING`,
      [tenantId, warehouseId, skuId]
    );

    await client.query(
      `SELECT 1
       FROM inventory_balance
       WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
       FOR UPDATE`,
      [tenantId, warehouseId, skuId]
    );
  }

  private async getDefaultWarehouseId(
    client: PoolClient,
    tenantId: string
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM warehouse
       WHERE tenant_id = $1
         AND status = 'ACTIVE'
         AND is_default = true
       LIMIT 1`,
      [tenantId]
    );

    const row = result.rows[0];
    if (!row) throw new NotFoundException("Основной склад не настроен");
    return row.id;
  }

  private async assertWarehouse(
    client: PoolClient,
    tenantId: string,
    warehouseId: string
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM warehouse
       WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [tenantId, warehouseId]
    );

    if (!result.rowCount) throw new NotFoundException("Склад не найден");
  }

  private async assertSku(
    client: PoolClient,
    tenantId: string,
    skuId: string
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM sku
       WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [tenantId, skuId]
    );

    if (!result.rowCount) throw new NotFoundException("SKU не найден");
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    afterData?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id, actor_user_id, actor_membership_id,
         action, resource_type, resource_id, after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        afterData ? JSON.stringify(afterData) : null
      ]
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
    );
  }
}
