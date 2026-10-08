import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";
import { InventoryService } from "../inventory/inventory.service";

type CreateLineInput = {
  skuId?: string;
  description?: string;
  quantityMilli?: string;
  unitPriceMinor?: string;
  discountMinor?: string;
};

@Injectable()
export class SalesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService,
    private readonly inventory: InventoryService
  ) {}

  async list(context: TenantContext): Promise<Array<{
    id: string;
    number: string;
    partyName: string | null;
    totalMinor: string;
    currency: string;
    orderStatus: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    responsibleMembershipId: string | null;
    createdAt: string;
    version: number;
  }>> {
    const scope = await this.authorization.resolveScope(context, "sales.read");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId];
      let scopeSql = "";

      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql = "AND o.responsible_membership_id = ANY($2::uuid[])";
      }

      const result = await client.query<{
        id: string;
        business_number: string;
        party_name: string | null;
        total_minor: string;
        currency: string;
        order_status: string;
        payment_status: string;
        fulfillment_status: string;
        responsible_membership_id: string | null;
        created_at: Date;
        version: number;
      }>(
        `SELECT
           o.id,
           o.business_number,
           p.display_name AS party_name,
           o.total_minor::text,
           o.currency,
           o.order_status,
           o.payment_status,
           o.fulfillment_status,
           o.responsible_membership_id,
           o.created_at,
           o.version
         FROM sales_order o
         LEFT JOIN party p
           ON p.tenant_id = o.tenant_id
          AND p.id = o.party_id
         WHERE o.tenant_id = $1
           ${scopeSql}
         ORDER BY o.created_at DESC
         LIMIT 500`,
        values
      );

      return result.rows.map((row) => ({
        id: row.id,
        number: row.business_number,
        partyName: row.party_name,
        totalMinor: row.total_minor,
        currency: row.currency,
        orderStatus: row.order_status,
        paymentStatus: row.payment_status,
        fulfillmentStatus: row.fulfillment_status,
        responsibleMembershipId: row.responsible_membership_id,
        createdAt: row.created_at.toISOString(),
        version: row.version
      }));
    });
  }

  async create(
    context: TenantContext,
    input: {
      partyId?: string;
      responsibleMembershipId?: string;
      currency?: string;
      notes?: string;
      idempotencyKey?: string;
      lines: CreateLineInput[];
      sourceDealId?: string;
    }
  ): Promise<{ id: string; number: string; version: number }> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new BadRequestException("Добавьте хотя бы одну позицию");
    }

    if (input.lines.length > 200) {
      throw new BadRequestException("Слишком много позиций в одном заказе");
    }

    const responsible =
      input.responsibleMembershipId ?? context.membershipId;

    if (
      scopedMembershipIds &&
      !scopedMembershipIds.includes(responsible)
    ) {
      throw new BadRequestException("Ответственный сотрудник недоступен");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.idempotencyKey) {
        const existing = await client.query<{
          id: string;
          business_number: string;
          version: number;
        }>(
          `SELECT id, business_number, version
           FROM sales_order
           WHERE tenant_id = $1 AND idempotency_key = $2`,
          [context.tenantId, input.idempotencyKey]
        );

        const row = existing.rows[0];
        if (row) {
          return {
            id: row.id,
            number: row.business_number,
            version: row.version
          };
        }
      }

      await this.assertMembership(client, context.tenantId, responsible);

      if (input.partyId) {
        await this.assertParty(client, context.tenantId, input.partyId);
      }

      if (input.sourceDealId) {
        await this.assertDeal(
          client,
          context.tenantId,
          input.sourceDealId,
          scopedMembershipIds
        );
      }

      const preparedLines = [];
      let subtotal = 0n;

      for (const line of input.lines) {
        const prepared = await this.prepareLine(
          client,
          context.tenantId,
          line
        );
        preparedLines.push(prepared);
        subtotal += prepared.lineTotalMinor;
      }

      const counter = await client.query<{ value: string }>(
        `INSERT INTO tenant_counter(tenant_id, counter_key, value)
         VALUES ($1, 'sales_order', 1)
         ON CONFLICT (tenant_id, counter_key)
         DO UPDATE SET
           value = tenant_counter.value + 1,
           updated_at = now()
         RETURNING value::text`,
        [context.tenantId]
      );

      const sequence = BigInt(counter.rows[0]?.value ?? "0");
      const year = new Date().getUTCFullYear();
      const number = `ORD-${year}-${sequence.toString().padStart(6, "0")}`;

      let orderResult;
      try {
        orderResult = await client.query<{
          id: string;
          business_number: string;
          version: number;
        }>(
          `INSERT INTO sales_order(
             tenant_id, business_number, source_deal_id, party_id,
             responsible_membership_id, currency,
             subtotal_minor, total_minor, notes, idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)
           RETURNING id, business_number, version`,
          [
            context.tenantId,
            number,
            input.sourceDealId ?? null,
            input.partyId ?? null,
            responsible,
            input.currency?.trim().toUpperCase() || "RUB",
            subtotal.toString(),
            input.notes?.trim() || null,
            input.idempotencyKey?.trim() || null
          ]
        );
      } catch (error) {
        if (
          input.idempotencyKey &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        ) {
          const existing = await client.query<{
            id: string;
            business_number: string;
            version: number;
          }>(
            `SELECT id, business_number, version
             FROM sales_order
             WHERE tenant_id = $1 AND idempotency_key = $2`,
            [context.tenantId, input.idempotencyKey]
          );
          const row = existing.rows[0];
          if (row) {
            return {
              id: row.id,
              number: row.business_number,
              version: row.version
            };
          }
        }
        throw error;
      }

      const order = orderResult.rows[0];
      if (!order) throw new Error("ORDER_CREATE_FAILED");

      for (const line of preparedLines) {
        await client.query(
          `INSERT INTO sales_order_line(
             tenant_id, order_id, sku_id, description,
             quantity_milli, unit_price_minor, discount_minor, line_total_minor
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            context.tenantId,
            order.id,
            line.skuId,
            line.description,
            line.quantityMilli.toString(),
            line.unitPriceMinor.toString(),
            line.discountMinor.toString(),
            line.lineTotalMinor.toString()
          ]
        );
      }

      await this.audit(
        client,
        context,
        "sales.order_created",
        order.id,
        { number: order.business_number, totalMinor: subtotal.toString() }
      );

      return {
        id: order.id,
        number: order.business_number,
        version: order.version
      };
    });
  }

  async createFromDeal(
    context: TenantContext,
    dealId: string,
    idempotencyKey: string
  ): Promise<{ id: string; number: string; version: number }> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    const deal = await this.database.withTenantTransaction(
      context,
      async (client) => {
        const result = await client.query<{
          id: string;
          title: string;
          amount_minor: string;
          party_id: string | null;
          responsible_membership_id: string | null;
        }>(
          `SELECT
             id, title, amount_minor::text, party_id, responsible_membership_id
           FROM crm_deal
           WHERE tenant_id = $1 AND id = $2`,
          [context.tenantId, dealId]
        );

        const row = result.rows[0];
        if (!row) throw new NotFoundException("Сделка не найдена");

        if (
          scopedMembershipIds &&
          (!row.responsible_membership_id ||
            !scopedMembershipIds.includes(row.responsible_membership_id))
        ) {
          throw new NotFoundException("Сделка не найдена");
        }

        return row;
      }
    );

    return this.create(context, {
      partyId: deal.party_id ?? undefined,
      responsibleMembershipId:
        deal.responsible_membership_id ?? context.membershipId,
      sourceDealId: deal.id,
      idempotencyKey,
      lines: [
        {
          description: deal.title,
          quantityMilli: "1000",
          unitPriceMinor: deal.amount_minor
        }
      ]
    });
  }

  async confirm(
    context: TenantContext,
    orderId: string,
    version: number
  ): Promise<{ id: string; orderStatus: string; version: number }> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId, orderId, version];
      let scopeSql = "";

      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql = "AND responsible_membership_id = ANY($4::uuid[])";
      }

      const result = await client.query<{
        id: string;
        order_status: string;
        version: number;
      }>(
        `UPDATE sales_order
         SET order_status = 'CONFIRMED',
             confirmed_at = now(),
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2
           AND version = $3
           AND order_status = 'DRAFT'
           ${scopeSql}
         RETURNING id, order_status, version`,
        values
      );

      const order = result.rows[0];
      if (!order) {
        throw new ConflictException(
          "Заказ уже изменён или не может быть подтверждён"
        );
      }

      await this.audit(
        client,
        context,
        "sales.order_confirmed",
        order.id
      );

      return {
        id: order.id,
        orderStatus: order.order_status,
        version: order.version
      };
    });
  }

  async reserve(
    context: TenantContext,
    orderId: string,
    idempotencyKey: string,
    warehouseId?: string
  ): Promise<unknown> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    return this.inventory.reserveOrder(context, {
      orderId,
      warehouseId,
      idempotencyKey
    });
  }

  async ship(
    context: TenantContext,
    orderId: string,
    idempotencyKey: string
  ): Promise<unknown> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    return this.inventory.shipOrder(context, {
      orderId,
      idempotencyKey
    });
  }

  private async prepareLine(
    client: PoolClient,
    tenantId: string,
    input: CreateLineInput
  ): Promise<{
    skuId: string | null;
    description: string;
    quantityMilli: bigint;
    unitPriceMinor: bigint;
    discountMinor: bigint;
    lineTotalMinor: bigint;
  }> {
    const quantityMilli = BigInt(input.quantityMilli ?? "1000");
    if (quantityMilli <= 0n) {
      throw new BadRequestException("Количество должно быть больше нуля");
    }

    let description = input.description?.trim() ?? "";
    let unitPriceMinor: bigint;
    let skuId: string | null = null;

    if (input.skuId) {
      const skuResult = await client.query<{
        id: string;
        code: string;
        sale_price_minor: string;
        product_name: string;
      }>(
        `SELECT
           s.id,
           s.code,
           s.sale_price_minor::text,
           p.name AS product_name
         FROM sku s
         JOIN product_variant v
           ON v.tenant_id = s.tenant_id AND v.id = s.variant_id
         JOIN product p
           ON p.tenant_id = v.tenant_id AND p.id = v.product_id
         WHERE s.tenant_id = $1
           AND s.id = $2
           AND s.status = 'ACTIVE'
           AND p.status = 'ACTIVE'`,
        [tenantId, input.skuId]
      );

      const sku = skuResult.rows[0];
      if (!sku) throw new NotFoundException("SKU не найден");

      skuId = sku.id;
      description ||= sku.product_name;
      unitPriceMinor = BigInt(input.unitPriceMinor ?? sku.sale_price_minor);
    } else {
      if (!description) {
        throw new BadRequestException("Для строки без SKU нужно описание");
      }
      if (!input.unitPriceMinor || !/^\d+$/.test(input.unitPriceMinor)) {
        throw new BadRequestException("Укажите цену позиции");
      }
      unitPriceMinor = BigInt(input.unitPriceMinor);
    }

    if (input.unitPriceMinor && !/^\d+$/.test(input.unitPriceMinor)) {
      throw new BadRequestException("Некорректная цена позиции");
    }

    const discountMinor = BigInt(input.discountMinor ?? "0");
    if (discountMinor < 0n) {
      throw new BadRequestException("Некорректная скидка");
    }

    const gross = (unitPriceMinor * quantityMilli + 500n) / 1000n;
    if (discountMinor > gross) {
      throw new BadRequestException("Скидка превышает сумму позиции");
    }

    return {
      skuId,
      description,
      quantityMilli,
      unitPriceMinor,
      discountMinor,
      lineTotalMinor: gross - discountMinor
    };
  }

  private async assertMembership(
    client: PoolClient,
    tenantId: string,
    membershipId: string
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM tenant_membership
       WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [tenantId, membershipId]
    );

    if (!result.rowCount) {
      throw new BadRequestException("Ответственный сотрудник недоступен");
    }
  }

  private async assertParty(
    client: PoolClient,
    tenantId: string,
    partyId: string
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM party
       WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [tenantId, partyId]
    );

    if (!result.rowCount) {
      throw new BadRequestException("Клиент недоступен");
    }
  }

  private async assertDeal(
    client: PoolClient,
    tenantId: string,
    dealId: string,
    scopedMembershipIds: string[] | null
  ): Promise<void> {
    const result = await client.query<{
      responsible_membership_id: string | null;
    }>(
      `SELECT responsible_membership_id
       FROM crm_deal
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, dealId]
    );

    const deal = result.rows[0];
    if (!deal) throw new NotFoundException("Сделка не найдена");

    if (
      scopedMembershipIds &&
      (!deal.responsible_membership_id ||
        !scopedMembershipIds.includes(deal.responsible_membership_id))
    ) {
      throw new NotFoundException("Сделка не найдена");
    }
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceId: string,
    afterData?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id, actor_user_id, actor_membership_id,
         action, resource_type, resource_id, after_data
       ) VALUES ($1,$2,$3,$4,'sales_order',$5,$6)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceId,
        afterData ? JSON.stringify(afterData) : null
      ]
    );
  }
}
