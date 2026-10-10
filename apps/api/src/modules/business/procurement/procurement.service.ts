import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";
import { InventoryService } from "../inventory/inventory.service";
import { DomainEventService } from "../../platform/events/domain-event.service";
import { FinanceService } from "../finance/finance.service";

type PurchaseLineInput = {
  skuId: string;
  quantityMilli?: string;
  unitCostMinor?: string;
};

type ReceiptLineInput = {
  purchaseOrderLineId: string;
  quantityMilli: string;
};

@Injectable()
export class ProcurementService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService,
    private readonly inventory: InventoryService,
    private readonly finance: FinanceService,
    private readonly events: DomainEventService
  ) {}

  async listSuppliers(context: TenantContext): Promise<Array<{
    id: string;
    displayName: string;
    phone: string | null;
    email: string | null;
  }>> {
    const scopedMembershipIds = await this.procurementScope(
      context,
      "procurement.read"
    );
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        display_name: string;
        phone: string | null;
        email: string | null;
      }>(
        `SELECT
           p.id,
           p.display_name,
           (
             SELECT value FROM party_contact
             WHERE tenant_id = p.tenant_id
               AND party_id = p.id
               AND type = 'PHONE'
             ORDER BY is_primary DESC, created_at ASC
             LIMIT 1
           ) AS phone,
           (
             SELECT value FROM party_contact
             WHERE tenant_id = p.tenant_id
               AND party_id = p.id
               AND type = 'EMAIL'
             ORDER BY is_primary DESC, created_at ASC
             LIMIT 1
           ) AS email
         FROM party p
         WHERE p.tenant_id = $1
           AND p.status = 'ACTIVE'
           AND (
             $2::uuid[] IS NULL
             OR p.responsible_membership_id = ANY($2::uuid[])
           )
           AND EXISTS (
             SELECT 1 FROM party_role r
             WHERE r.party_id = p.id
               AND r.tenant_id = p.tenant_id
               AND r.role = 'SUPPLIER'
           )
         ORDER BY p.display_name`,
        [context.tenantId, scopedMembershipIds]
      );

      return result.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        phone: row.phone,
        email: row.email
      }));
    });
  }

  async createSupplier(
    context: TenantContext,
    input: {
      displayName: string;
      type?: "PERSON" | "ORGANIZATION";
      phone?: string;
      email?: string;
    }
  ): Promise<{ id: string; displayName: string }> {
    await this.procurementScope(context, "procurement.write");
    const displayName = input.displayName.trim();

    if (displayName.length < 2 || displayName.length > 200) {
      throw new BadRequestException("Некорректное название поставщика");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string; display_name: string }>(
        `INSERT INTO party(
           tenant_id, type, display_name, responsible_membership_id
         ) VALUES ($1,$2,$3,$4)
         RETURNING id, display_name`,
        [
          context.tenantId,
          input.type ?? "ORGANIZATION",
          displayName,
          context.membershipId
        ]
      );

      const supplier = result.rows[0];
      if (!supplier) throw new Error("SUPPLIER_CREATE_FAILED");

      await client.query(
        `INSERT INTO party_role(tenant_id, party_id, role)
         VALUES ($1,$2,'SUPPLIER')`,
        [context.tenantId, supplier.id]
      );

      for (const contact of [
        input.phone ? { type: "PHONE", value: input.phone.trim() } : null,
        input.email
          ? { type: "EMAIL", value: input.email.trim().toLowerCase() }
          : null
      ].filter(Boolean) as Array<{ type: string; value: string }>) {
        await client.query(
          `INSERT INTO party_contact(
             tenant_id, party_id, type, value, is_primary
           ) VALUES ($1,$2,$3,$4,true)`,
          [context.tenantId, supplier.id, contact.type, contact.value]
        );
      }

      await this.audit(
        client,
        context,
        "procurement.supplier_created",
        "party",
        supplier.id
      );

      return {
        id: supplier.id,
        displayName: supplier.display_name
      };
    });
  }

  async listOrders(context: TenantContext): Promise<Array<{
    id: string;
    number: string;
    supplierName: string;
    status: string;
    totalMinor: string;
    currency: string;
    expectedAt: string | null;
    inventoryOwnerId: string;
    inventoryOwnerName: string;
    inventoryOwnerType: string;
    version: number;
  }>> {
    const scopedMembershipIds = await this.procurementScope(
      context,
      "procurement.read"
    );
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        business_number: string;
        supplier_name: string;
        status: string;
        total_minor: string;
        currency: string;
        expected_at: Date | null;
        inventory_owner_id: string;
        inventory_owner_name: string;
        inventory_owner_type: string;
        version: number;
      }>(
        `SELECT
           po.id,
           po.business_number,
           p.display_name AS supplier_name,
           po.status,
           po.total_minor::text,
           po.currency,
           po.expected_at,
           po.inventory_owner_id,
           io.name AS inventory_owner_name,
           io.owner_type AS inventory_owner_type,
           po.version
         FROM purchase_order po
         JOIN inventory_owner io
           ON io.tenant_id=po.tenant_id
          AND io.id=po.inventory_owner_id
         JOIN party p
           ON p.tenant_id = po.tenant_id
          AND p.id = po.supplier_party_id
         WHERE po.tenant_id = $1
           AND (
             $2::uuid[] IS NULL
             OR po.responsible_membership_id = ANY($2::uuid[])
           )
         ORDER BY po.created_at DESC
         LIMIT 500`,
        [context.tenantId, scopedMembershipIds]
      );

      return result.rows.map((row) => ({
        id: row.id,
        number: row.business_number,
        supplierName: row.supplier_name,
        status: row.status,
        totalMinor: row.total_minor,
        currency: row.currency,
        expectedAt: row.expected_at?.toISOString() ?? null,
        inventoryOwnerId: row.inventory_owner_id,
        inventoryOwnerName: row.inventory_owner_name,
        inventoryOwnerType: row.inventory_owner_type,
        version: row.version
      }));
    });
  }

  async createOrder(
    context: TenantContext,
    input: {
      supplierPartyId: string;
      destinationBranchId?: string;
      destinationWarehouseId?: string;
      expectedAt?: string;
      notes?: string;
      inventoryOwnerId?: string;
      lines: PurchaseLineInput[];
    }
  ): Promise<{ id: string; number: string; version: number }> {
    const scopedMembershipIds = await this.procurementScope(
      context,
      "procurement.write"
    );
    if (!input.lines?.length) {
      throw new BadRequestException("Добавьте хотя бы одну позицию");
    }

    if (input.lines.length > 300) {
      throw new BadRequestException("Слишком много позиций в закупке");
    }

    let expectedAt: Date | null = null;
    if (input.expectedAt) {
      expectedAt = new Date(input.expectedAt);
      if (Number.isNaN(expectedAt.getTime())) {
        throw new BadRequestException("Некорректная дата поставки");
      }
    }

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertSupplier(
        client,
        context.tenantId,
        input.supplierPartyId,
        scopedMembershipIds
      );

      if (input.destinationBranchId) {
        const branch = await client.query(
          `SELECT 1 FROM branch
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'ACTIVE'`,
          [context.tenantId, input.destinationBranchId]
        );

        if (!branch.rowCount) {
          throw new NotFoundException("Филиал назначения не найден");
        }
      }

      const destinationWarehouseId =
        input.destinationWarehouseId ??
        (await this.getDefaultWarehouseId(client, context.tenantId));

      const warehouse = await client.query(
        `SELECT 1 FROM warehouse
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'ACTIVE'`,
        [context.tenantId, destinationWarehouseId]
      );

      if (!warehouse.rowCount) {
        throw new NotFoundException("Склад назначения не найден");
      }

      const ownerResult=await client.query<{
        id:string;
        owner_type:string;
      }>(
        input.inventoryOwnerId
          ? `SELECT id,owner_type
             FROM inventory_owner
             WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`
          : `SELECT id,owner_type
             FROM inventory_owner
             WHERE tenant_id=$1
               AND is_default=true
               AND status='ACTIVE'
             LIMIT 1`,
        input.inventoryOwnerId
          ? [context.tenantId,input.inventoryOwnerId]
          : [context.tenantId]
      );
      const inventoryOwner=ownerResult.rows[0];
      if(!inventoryOwner){
        throw new NotFoundException("Владелец товара не найден");
      }

      if(inventoryOwner.owner_type==="CLIENT"){
        const contract=await client.query(
          `SELECT 1
           FROM warehouse_3pl_contract
           WHERE tenant_id=$1
             AND warehouse_id=$2
             AND owner_id=$3
             AND status='ACTIVE'`,
          [context.tenantId,destinationWarehouseId,inventoryOwner.id]
        );
        if(!contract.rowCount){
          throw new ConflictException(
            "Для 3PL-владельца нет активного контракта на складе назначения"
          );
        }
      }

      const preparedLines: Array<{
        skuId: string;
        quantityMilli: bigint;
        unitCostMinor: bigint;
        lineTotalMinor: bigint;
      }> = [];

      let total = 0n;

      for (const line of input.lines) {
        if (!/^\d+$/.test(line.quantityMilli ?? "1000")) {
          throw new BadRequestException("Некорректное количество");
        }

        const quantityMilli = BigInt(line.quantityMilli ?? "1000");
        if (quantityMilli <= 0n) {
          throw new BadRequestException("Количество должно быть больше нуля");
        }

        const skuResult = await client.query<{
          id: string;
          cost_price_minor: string;
        }>(
          `SELECT id, cost_price_minor::text
           FROM sku
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'ACTIVE'`,
          [context.tenantId, line.skuId]
        );

        const sku = skuResult.rows[0];
        if (!sku) throw new NotFoundException("SKU не найден");

        const rawUnitCost = line.unitCostMinor ?? sku.cost_price_minor;
        if (!/^\d+$/.test(rawUnitCost)) {
          throw new BadRequestException("Некорректная закупочная цена");
        }

        const unitCostMinor = BigInt(rawUnitCost);
        const lineTotalMinor =
          (unitCostMinor * quantityMilli + 500n) / 1000n;

        total += lineTotalMinor;

        preparedLines.push({
          skuId: sku.id,
          quantityMilli,
          unitCostMinor,
          lineTotalMinor
        });
      }

      const number = await this.nextNumber(
        client,
        context.tenantId,
        "purchase_order",
        "PO"
      );

      const orderResult = await client.query<{
        id: string;
        business_number: string;
        version: number;
      }>(
        `INSERT INTO purchase_order(
           tenant_id, business_number, supplier_party_id,
           destination_branch_id, destination_warehouse_id,
           responsible_membership_id, inventory_owner_id,
           total_minor, expected_at, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, business_number, version`,
        [
          context.tenantId,
          number,
          input.supplierPartyId,
          input.destinationBranchId ?? null,
          destinationWarehouseId,
          context.membershipId,
          inventoryOwner.id,
          total.toString(),
          expectedAt,
          input.notes?.trim() || null
        ]
      );

      const order = orderResult.rows[0];
      if (!order) throw new Error("PURCHASE_ORDER_CREATE_FAILED");

      for (const line of preparedLines) {
        await client.query(
          `INSERT INTO purchase_order_line(
             tenant_id, purchase_order_id, sku_id,
             ordered_quantity_milli, unit_cost_minor, line_total_minor
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            context.tenantId,
            order.id,
            line.skuId,
            line.quantityMilli.toString(),
            line.unitCostMinor.toString(),
            line.lineTotalMinor.toString()
          ]
        );
      }

      await this.audit(
        client,
        context,
        "procurement.order_created",
        "purchase_order",
        order.id,
        { number }
      );

      return {
        id: order.id,
        number: order.business_number,
        version: order.version
      };
    });
  }

  async confirmOrder(
    context: TenantContext,
    orderId: string,
    version: number
  ): Promise<{ id: string; status: string; version: number }> {
    const scopedMembershipIds = await this.procurementScope(
      context,
      "procurement.write"
    );
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        status: string;
        version: number;
      }>(
        `UPDATE purchase_order
         SET status = 'CONFIRMED',
             confirmed_at = now(),
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2
           AND version = $3
           AND status = 'DRAFT'
           AND (
             $4::uuid[] IS NULL
             OR responsible_membership_id = ANY($4::uuid[])
           )
         RETURNING id, status, version`,
        [context.tenantId, orderId, version, scopedMembershipIds]
      );

      const order = result.rows[0];
      if (!order) {
        throw new ConflictException(
          "Закупка уже изменена или не может быть подтверждена"
        );
      }

      await this.finance.createPurchasePayable(client, context, order.id);

      await this.audit(
        client,
        context,
        "procurement.order_confirmed",
        "purchase_order",
        order.id
      );

      await this.events.enqueue(client, context, {
        eventName: "procurement.order_confirmed",
        entityType: "PURCHASE_ORDER",
        entityId: order.id,
        payload: {
          purchaseOrderId: order.id,
          status: order.status,
          version: order.version
        }
      });

      return order;
    });
  }

  async getOrderLines(
    context: TenantContext,
    orderId: string
  ): Promise<Array<{
    id: string;
    skuId: string;
    sku: string;
    productName: string;
    orderedQuantityMilli: string;
    receivedQuantityMilli: string;
    remainingQuantityMilli: string;
    unitCostMinor: string;
  }>> {
    const scopedMembershipIds = await this.procurementScope(
      context,
      "procurement.read"
    );
    return this.database.withTenantTransaction(context, async (client) => {
      const order = await client.query(
        `SELECT 1 FROM purchase_order
         WHERE tenant_id=$1
           AND id=$2
           AND (
             $3::uuid[] IS NULL
             OR responsible_membership_id = ANY($3::uuid[])
           )`,
        [context.tenantId, orderId, scopedMembershipIds]
      );

      if (!order.rowCount) throw new NotFoundException("Закупка не найдена");

      const result = await client.query<{
        id: string;
        sku_id: string;
        sku_code: string;
        product_name: string;
        ordered_quantity_milli: string;
        received_quantity_milli: string;
        unit_cost_minor: string;
      }>(
        `SELECT
           pol.id,
           pol.sku_id,
           s.code AS sku_code,
           p.name AS product_name,
           pol.ordered_quantity_milli::text,
           pol.received_quantity_milli::text,
           pol.unit_cost_minor::text
         FROM purchase_order_line pol
         JOIN sku s
           ON s.tenant_id = pol.tenant_id
          AND s.id = pol.sku_id
         JOIN product_variant v
           ON v.tenant_id = s.tenant_id
          AND v.id = s.variant_id
         JOIN product p
           ON p.tenant_id = v.tenant_id
          AND p.id = v.product_id
         WHERE pol.tenant_id = $1
           AND pol.purchase_order_id = $2
         ORDER BY pol.created_at`,
        [context.tenantId, orderId]
      );

      return result.rows.map((row) => {
        const ordered = BigInt(row.ordered_quantity_milli);
        const received = BigInt(row.received_quantity_milli);

        return {
          id: row.id,
          skuId: row.sku_id,
          sku: row.sku_code,
          productName: row.product_name,
          orderedQuantityMilli: ordered.toString(),
          receivedQuantityMilli: received.toString(),
          remainingQuantityMilli: (ordered - received).toString(),
          unitCostMinor: row.unit_cost_minor
        };
      });
    });
  }

  async receive(
    context: TenantContext,
    orderId: string,
    lines: ReceiptLineInput[],
    options?: { inboundAsnId?: string }
  ): Promise<{ receiptId: string; number: string; orderStatus: string }> {
    if (!lines.length) {
      throw new BadRequestException("Укажите полученные позиции");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const orderResult = await client.query<{
        id: string;
        status: string;
        destination_warehouse_id: string | null;
        inventory_owner_id: string;
      }>(
        `SELECT id, status, destination_warehouse_id, inventory_owner_id
         FROM purchase_order
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, orderId]
      );

      const order = orderResult.rows[0];
      if (!order) throw new NotFoundException("Закупка не найдена");

      if (!["CONFIRMED", "PARTIALLY_RECEIVED"].includes(order.status)) {
        throw new BadRequestException("Закупка не готова к приёмке");
      }

      const prepared: Array<{
        lineId: string;
        skuId: string;
        quantityMilli: bigint;
        unitCostMinor: bigint;
      }> = [];

      for (const line of lines) {
        if (!/^\d+$/.test(line.quantityMilli)) {
          throw new BadRequestException("Некорректное количество");
        }

        const quantity = BigInt(line.quantityMilli);
        if (quantity <= 0n) {
          throw new BadRequestException("Количество должно быть больше нуля");
        }

        const lineResult = await client.query<{
          id: string;
          sku_id: string;
          ordered_quantity_milli: string;
          received_quantity_milli: string;
          unit_cost_minor: string;
        }>(
          `SELECT
             id,
             sku_id,
             ordered_quantity_milli::text,
             received_quantity_milli::text,
             unit_cost_minor::text
           FROM purchase_order_line
           WHERE tenant_id = $1
             AND purchase_order_id = $2
             AND id = $3
           FOR UPDATE`,
          [context.tenantId, orderId, line.purchaseOrderLineId]
        );

        const purchaseLine = lineResult.rows[0];
        if (!purchaseLine) {
          throw new NotFoundException("Позиция закупки не найдена");
        }

        const remaining =
          BigInt(purchaseLine.ordered_quantity_milli) -
          BigInt(purchaseLine.received_quantity_milli);

        if (quantity > remaining) {
          throw new BadRequestException(
            "Полученное количество превышает остаток по заказу"
          );
        }

        prepared.push({
          lineId: purchaseLine.id,
          skuId: purchaseLine.sku_id,
          quantityMilli: quantity,
          unitCostMinor: BigInt(purchaseLine.unit_cost_minor)
        });
      }

      const number = await this.nextNumber(
        client,
        context.tenantId,
        "goods_receipt",
        "GR"
      );

      const receiptResult = await client.query<{ id: string }>(
        `INSERT INTO goods_receipt(
           tenant_id, purchase_order_id, business_number,
           inventory_owner_id, inbound_asn_id, posted_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,orderId,number,
          order.inventory_owner_id,options?.inboundAsnId??null,
          context.membershipId
        ]
      );

      const receipt = receiptResult.rows[0];
      if (!receipt) throw new Error("GOODS_RECEIPT_CREATE_FAILED");

      const warehouseId =
        order.destination_warehouse_id ??
        (await this.getDefaultWarehouseId(client, context.tenantId));

      const inventoryLines: Array<{
        skuId: string;
        quantityMilli: bigint;
        unitCostMinor: bigint;
        sourceLineId: string;
      }> = [];

      for (const line of prepared) {
        const receiptLineResult = await client.query<{ id: string }>(
          `INSERT INTO goods_receipt_line(
             tenant_id, receipt_id, purchase_order_line_id,
             sku_id, quantity_milli, unit_cost_minor
           ) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            context.tenantId,
            receipt.id,
            line.lineId,
            line.skuId,
            line.quantityMilli.toString(),
            line.unitCostMinor.toString()
          ]
        );

        const receiptLine = receiptLineResult.rows[0];
        if (!receiptLine) throw new Error("GOODS_RECEIPT_LINE_CREATE_FAILED");

        inventoryLines.push({
          skuId: line.skuId,
          quantityMilli: line.quantityMilli,
          unitCostMinor: line.unitCostMinor,
          sourceLineId: receiptLine.id
        });

        await client.query(
          `UPDATE purchase_order_line
           SET received_quantity_milli =
             received_quantity_milli + $4::bigint
           WHERE tenant_id = $1
             AND purchase_order_id = $2
             AND id = $3`,
          [
            context.tenantId,
            orderId,
            line.lineId,
            line.quantityMilli.toString()
          ]
        );
      }

      await this.inventory.postGoodsReceipt(client, context, {
        receiptId: receipt.id,
        warehouseId,
        ownerId: order.inventory_owner_id,
        lines: inventoryLines
      });

      const remaining = await client.query<{ remaining: string }>(
        `SELECT
           sum(ordered_quantity_milli - received_quantity_milli)::text
             AS remaining
         FROM purchase_order_line
         WHERE tenant_id = $1
           AND purchase_order_id = $2`,
        [context.tenantId, orderId]
      );

      const remainingQuantity = BigInt(remaining.rows[0]?.remaining ?? "0");
      const newStatus =
        remainingQuantity === 0n ? "RECEIVED" : "PARTIALLY_RECEIVED";

      await client.query(
        `UPDATE purchase_order
         SET status = $3,
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, orderId, newStatus]
      );

      await this.audit(
        client,
        context,
        "procurement.receipt_posted",
        "goods_receipt",
        receipt.id,
        {
          purchaseOrderId: orderId,
          number,
          inboundAsnId: options?.inboundAsnId ?? null
        }
      );

      await this.events.enqueue(client, context, {
        eventName: "procurement.receipt_posted",
        entityType: "GOODS_RECEIPT",
        entityId: receipt.id,
        payload: {
          receiptId: receipt.id,
          purchaseOrderId: orderId,
          number,
          warehouseId,
          orderStatus: newStatus,
          inboundAsnId: options?.inboundAsnId ?? null
        }
      });

      return {
        receiptId: receipt.id,
        number,
        orderStatus: newStatus
      };
    });
  }

  private async procurementScope(
    context: TenantContext,
    permission: "procurement.read" | "procurement.write"
  ): Promise<string[] | null> {
    const scope = await this.authorization.resolveScope(context, permission);
    if (!scope) throw new ForbiddenException("Недостаточно прав");
    return this.authorization.membershipIdsForScope(context, scope);
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

  private async assertSupplier(
    client: PoolClient,
    tenantId: string,
    partyId: string,
    scopedMembershipIds: string[] | null
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1
       FROM party p
       WHERE p.tenant_id = $1
         AND p.id = $2
         AND p.status = 'ACTIVE'
         AND (
           $3::uuid[] IS NULL
           OR p.responsible_membership_id = ANY($3::uuid[])
         )
         AND EXISTS (
           SELECT 1 FROM party_role r
           WHERE r.tenant_id = p.tenant_id
             AND r.party_id = p.id
             AND r.role = 'SUPPLIER'
         )`,
      [tenantId, partyId, scopedMembershipIds]
    );

    if (!result.rowCount) {
      throw new NotFoundException("Поставщик не найден");
    }
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
}
