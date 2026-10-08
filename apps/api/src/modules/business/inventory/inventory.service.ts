import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";

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
};

@Injectable()
export class InventoryService {
  constructor(private readonly database: DatabaseService) {}

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

    return this.database.withTenantTransaction(context, (client) =>
      this.postMovement(client, context, {
        warehouseId: input.warehouseId,
        skuId: input.skuId,
        movementType: "ADJUSTMENT",
        quantityDeltaMilli: delta,
        reason: input.reason.trim(),
        idempotencyKey: input.idempotencyKey
      })
    );
  }

  async postGoodsReceipt(
    client: PoolClient,
    context: TenantContext,
    input: {
      receiptId: string;
      warehouseId: string;
      lines: InventoryReceiptLine[];
    }
  ): Promise<void> {
    await this.assertWarehouse(client, context.tenantId, input.warehouseId);

    for (const line of input.lines) {
      await this.postMovement(client, context, {
        warehouseId: input.warehouseId,
        skuId: line.skuId,
        movementType: "RECEIPT",
        quantityDeltaMilli: line.quantityMilli,
        unitCostMinor: line.unitCostMinor,
        sourceType: "GOODS_RECEIPT",
        sourceId: input.receiptId,
        sourceLineId: line.sourceLineId,
        idempotencyKey:
          `goods-receipt:${input.receiptId}:line:${line.sourceLineId}`
      });
    }
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
      }>(
        `SELECT id, order_status, fulfillment_status, warehouse_id
         FROM sales_order
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, input.orderId]
      );

      const order = orderResult.rows[0];
      if (!order) throw new NotFoundException("Заказ не найден");
      if (order.order_status !== "CONFIRMED") {
        throw new BadRequestException("Сначала подтвердите заказ");
      }

      if (["RESERVED", "READY", "PARTIALLY_SHIPPED", "SHIPPED"].includes(
        order.fulfillment_status
      )) {
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
            order.fulfillment_status === "RESERVED" ? "RESERVED" : "READY",
          reservations: Number(count.rows[0]?.count ?? "0")
        };
      }

      const warehouseId =
        input.warehouseId ??
        order.warehouse_id ??
        (await this.getDefaultWarehouseId(client, context.tenantId));

      await this.assertWarehouse(client, context.tenantId, warehouseId);

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
             warehouse_id, sku_id, quantity_milli,
             idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            context.tenantId,
            input.orderId,
            line.line_id,
            warehouseId,
            line.sku_id,
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

  async shipOrder(
    context: TenantContext,
    input: {
      orderId: string;
      idempotencyKey: string;
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
        warehouse_id: string | null;
      }>(
        `SELECT id, order_status, fulfillment_status, warehouse_id
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

      if (row.fulfillment_status !== "RESERVED" || !row.warehouse_id) {
        throw new BadRequestException("Заказ должен быть полностью зарезервирован");
      }

      const reservations = await client.query<{
        id: string;
        sales_order_line_id: string;
        sku_id: string;
        quantity_milli: string;
      }>(
        `SELECT
           id,
           sales_order_line_id,
           sku_id,
           quantity_milli::text
         FROM inventory_reservation
         WHERE tenant_id = $1
           AND sales_order_id = $2
           AND status = 'ACTIVE'
         ORDER BY created_at
         FOR UPDATE`,
        [context.tenantId, input.orderId]
      );

      if (!reservations.rowCount) {
        throw new ConflictException("Активные резервы заказа не найдены");
      }

      for (const reservation of reservations.rows) {
        await this.lockBalance(
          client,
          context.tenantId,
          row.warehouse_id,
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
          [context.tenantId, row.warehouse_id, reservation.sku_id]
        );

        const current = balance.rows[0]!;
        if (
          BigInt(current.physical_milli) < quantity ||
          BigInt(current.reserved_milli) < quantity
        ) {
          throw new ConflictException("Складской баланс изменился и требует проверки");
        }

        await client.query(
          `UPDATE inventory_balance
           SET physical_milli = physical_milli - $4::bigint,
               reserved_milli = reserved_milli - $4::bigint,
               updated_at = now()
           WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3`,
          [
            context.tenantId,
            row.warehouse_id,
            reservation.sku_id,
            quantity.toString()
          ]
        );

        await this.insertMovementOnly(client, context, {
          warehouseId: row.warehouse_id,
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
      }

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
        input.orderId
      );

      return {
        orderId: input.orderId,
        fulfillmentStatus: "SHIPPED"
      };
    });
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
    const result = await client.query<{ id: string }>(
      `INSERT INTO inventory_transaction(
         tenant_id, warehouse_id, sku_id, movement_type,
         quantity_delta_milli, unit_cost_minor,
         source_type, source_id, source_line_id,
         reason, idempotency_key, actor_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        context.tenantId,
        input.warehouseId,
        input.skuId,
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
