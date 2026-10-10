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
import { DomainEventService } from "../../platform/events/domain-event.service";
import { AttributionService } from "../growth/attribution.service";
import { InventoryService } from "../inventory/inventory.service";
import { FinanceService } from "../finance/finance.service";

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
    private readonly inventory: InventoryService,
    private readonly finance: FinanceService,
    private readonly events: DomainEventService,
    private readonly attribution: AttributionService
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
    inventoryOwnerId: string;
    inventoryOwnerName: string;
    inventoryOwnerType: string;
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
        inventory_owner_id: string;
        inventory_owner_name: string;
        inventory_owner_type: string;
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
           o.inventory_owner_id,
           io.name AS inventory_owner_name,
           io.owner_type AS inventory_owner_type,
           o.created_at,
           o.version
         FROM sales_order o
         JOIN inventory_owner io
           ON io.tenant_id=o.tenant_id
          AND io.id=o.inventory_owner_id
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
        inventoryOwnerId: row.inventory_owner_id,
        inventoryOwnerName: row.inventory_owner_name,
        inventoryOwnerType: row.inventory_owner_type,
        createdAt: row.created_at.toISOString(),
        version: row.version
      }));
    });
  }

  async commercialTerms(
    context: TenantContext,
    partyId: string
  ): Promise<Record<string, unknown> | null> {
    const scope = await this.authorization.resolveScope(context, "sales.read");
    if (!scope) throw new BadRequestException("Недостаточно прав");
    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertParty(
        client,
        context.tenantId,
        partyId,
        scopedMembershipIds
      );
      const result = await client.query(
        `SELECT
           party_id,currency,credit_limit_minor::text,payment_term_days,
           default_discount_bps,allow_over_credit,notes,created_at,updated_at
         FROM party_commercial_terms
         WHERE tenant_id=$1 AND party_id=$2`,
        [context.tenantId, partyId]
      );
      return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
    });
  }

  async setCommercialTerms(
    context: TenantContext,
    partyId: string,
    input: {
      currency?: string;
      creditLimitMinor?: string | null;
      paymentTermDays?: number;
      defaultDiscountBps?: number;
      allowOverCredit?: boolean;
      notes?: string;
    }
  ): Promise<void> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");
    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    const currency = input.currency?.trim().toUpperCase() || "RUB";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Некорректная валюта");
    }
    const creditLimit =
      input.creditLimitMinor === null || input.creditLimitMinor === undefined
        ? null
        : input.creditLimitMinor;
    if (creditLimit !== null && !/^\d+$/.test(creditLimit)) {
      throw new BadRequestException("Некорректный кредитный лимит");
    }

    const paymentTermDays = Number(input.paymentTermDays ?? 0);
    const defaultDiscountBps = Number(input.defaultDiscountBps ?? 0);
    if (
      !Number.isSafeInteger(paymentTermDays) ||
      paymentTermDays < 0 ||
      paymentTermDays > 3650
    ) {
      throw new BadRequestException("Некорректная отсрочка платежа");
    }
    if (
      !Number.isSafeInteger(defaultDiscountBps) ||
      defaultDiscountBps < 0 ||
      defaultDiscountBps > 10000
    ) {
      throw new BadRequestException("Некорректная скидка клиента");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      await this.assertParty(
        client,
        context.tenantId,
        partyId,
        scopedMembershipIds
      );
      await client.query(
        `INSERT INTO party_commercial_terms(
           tenant_id,party_id,currency,credit_limit_minor,payment_term_days,
           default_discount_bps,allow_over_credit,notes,
           updated_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id,party_id)
         DO UPDATE SET
           currency=EXCLUDED.currency,
           credit_limit_minor=EXCLUDED.credit_limit_minor,
           payment_term_days=EXCLUDED.payment_term_days,
           default_discount_bps=EXCLUDED.default_discount_bps,
           allow_over_credit=EXCLUDED.allow_over_credit,
           notes=EXCLUDED.notes,
           updated_by_membership_id=EXCLUDED.updated_by_membership_id,
           updated_at=now()`,
        [
          context.tenantId,
          partyId,
          currency,
          creditLimit,
          paymentTermDays,
          defaultDiscountBps,
          Boolean(input.allowOverCredit),
          input.notes?.trim() || null,
          context.membershipId
        ]
      );
      await this.auditEntity(
        client,
        context,
        "sales.commercial_terms_changed",
        "party",
        partyId,
        {
          currency,
          creditLimitMinor: creditLimit,
          paymentTermDays,
          defaultDiscountBps,
          allowOverCredit: Boolean(input.allowOverCredit)
        }
      );
    });
  }

  async partyPrices(
    context: TenantContext,
    partyId: string
  ): Promise<Array<Record<string, unknown>>> {
    const scope = await this.authorization.resolveScope(context, "sales.read");
    if (!scope) throw new BadRequestException("Недостаточно прав");
    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertParty(
        client,
        context.tenantId,
        partyId,
        scopedMembershipIds
      );
      const result = await client.query(
        `SELECT
           pp.id,pp.sku_id,s.code AS sku_code,p.name AS product_name,
           pp.currency,pp.min_quantity_milli::text,
           pp.unit_price_minor::text,pp.valid_from,pp.valid_to,pp.status
         FROM party_sku_price pp
         JOIN sku s
           ON s.tenant_id=pp.tenant_id AND s.id=pp.sku_id
         JOIN product_variant v
           ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p
           ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE pp.tenant_id=$1 AND pp.party_id=$2
         ORDER BY pp.status, p.name, pp.min_quantity_milli DESC, pp.valid_from DESC
         LIMIT 1000`,
        [context.tenantId, partyId]
      );
      return result.rows;
    });
  }

  async addPartyPrice(
    context: TenantContext,
    partyId: string,
    input: {
      skuId: string;
      currency?: string;
      minQuantityMilli?: string;
      unitPriceMinor: string;
      validFrom?: string;
      validTo?: string;
    }
  ): Promise<{ id: string }> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");
    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    const currency = input.currency?.trim().toUpperCase() || "RUB";
    const minQuantityMilli = input.minQuantityMilli ?? "1000";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Некорректная валюта");
    }
    if (!/^\d+$/.test(minQuantityMilli) || BigInt(minQuantityMilli) <= 0n) {
      throw new BadRequestException("Некорректный порог количества");
    }
    if (!/^\d+$/.test(input.unitPriceMinor ?? "")) {
      throw new BadRequestException("Некорректная договорная цена");
    }

    const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
    const validTo = input.validTo ? new Date(input.validTo) : null;
    if (
      Number.isNaN(validFrom.getTime()) ||
      (validTo && Number.isNaN(validTo.getTime())) ||
      (validTo && validTo <= validFrom)
    ) {
      throw new BadRequestException("Некорректный период действия цены");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertParty(
        client,
        context.tenantId,
        partyId,
        scopedMembershipIds
      );
      const sku = await client.query(
        `SELECT 1 FROM sku
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, input.skuId]
      );
      if (!sku.rowCount) throw new NotFoundException("SKU не найден");

      const result = await client.query<{ id: string }>(
        `INSERT INTO party_sku_price(
           tenant_id,party_id,sku_id,currency,min_quantity_milli,
           unit_price_minor,valid_from,valid_to,created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          context.tenantId,
          partyId,
          input.skuId,
          currency,
          minQuantityMilli,
          input.unitPriceMinor,
          validFrom,
          validTo,
          context.membershipId
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("PARTY_PRICE_CREATE_FAILED");
      return row;
    });
  }

  async archivePartyPrice(
    context: TenantContext,
    partyId: string,
    priceId: string
  ): Promise<void> {
    const scope = await this.authorization.resolveScope(context, "sales.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");
    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    await this.database.withTenantTransaction(context, async (client) => {
      await this.assertParty(
        client,
        context.tenantId,
        partyId,
        scopedMembershipIds
      );
      const result = await client.query(
        `UPDATE party_sku_price
         SET status='ARCHIVED',updated_at=now()
         WHERE tenant_id=$1 AND party_id=$2 AND id=$3 AND status='ACTIVE'`,
        [context.tenantId, partyId, priceId]
      );
      if (!result.rowCount) {
        throw new NotFoundException("Договорная цена не найдена");
      }
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
      inventoryOwnerId?: string;
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

    const orderCurrency = input.currency?.trim().toUpperCase() || "RUB";
    if (!/^[A-Z]{3}$/.test(orderCurrency)) {
      throw new BadRequestException("Некорректная валюта заказа");
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

      let defaultDiscountBps = 0;
      if (input.partyId) {
        await this.assertParty(client, context.tenantId, input.partyId);
        const terms = await client.query<{
          currency: string;
          default_discount_bps: number;
        }>(
          `SELECT currency,default_discount_bps
           FROM party_commercial_terms
           WHERE tenant_id=$1 AND party_id=$2`,
          [context.tenantId, input.partyId]
        );
        const termRow = terms.rows[0];
        if (termRow) {
          if (termRow.currency !== orderCurrency) {
            throw new ConflictException(
              "Валюта заказа не совпадает с коммерческими условиями клиента"
            );
          }
          defaultDiscountBps = termRow.default_discount_bps;
        }
      }

      if (input.sourceDealId) {
        await this.assertDeal(
          client,
          context.tenantId,
          input.sourceDealId,
          scopedMembershipIds
        );
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

      const preparedLines = [];
      let subtotal = 0n;

      for (const line of input.lines) {
        const prepared = await this.prepareLine(
          client,
          context.tenantId,
          line,
          input.partyId ?? null,
          orderCurrency,
          defaultDiscountBps
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
             responsible_membership_id, inventory_owner_id, currency,
             subtotal_minor, total_minor, notes, idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)
           RETURNING id, business_number, version`,
          [
            context.tenantId,
            number,
            input.sourceDealId ?? null,
            input.partyId ?? null,
            responsible,
            inventoryOwner.id,
            orderCurrency,
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
             quantity_milli, unit_price_minor, cost_price_minor_snapshot,
             discount_minor, line_total_minor,pricing_source,price_rule_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            context.tenantId,
            order.id,
            line.skuId,
            line.description,
            line.quantityMilli.toString(),
            line.unitPriceMinor.toString(),
            line.costPriceMinorSnapshot.toString(),
            line.discountMinor.toString(),
            line.lineTotalMinor.toString(),
            line.pricingSource,
            line.priceRuleId
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

      const draft = await client.query<{
        party_id: string | null;
        total_minor: string;
        currency: string;
        payment_status: string;
      }>(
        `SELECT party_id,total_minor::text,currency,payment_status
         FROM sales_order
         WHERE tenant_id=$1
           AND id=$2
           AND version=$3
           AND order_status='DRAFT'
           ${scopeSql}
         FOR UPDATE`,
        values
      );
      const draftRow = draft.rows[0];
      if (!draftRow) {
        throw new ConflictException(
          "Заказ уже изменён или не может быть подтверждён"
        );
      }

      const paymentTermDays = await this.validateCommercialCredit(
        client,
        context.tenantId,
        draftRow.party_id,
        BigInt(draftRow.total_minor),
        draftRow.currency,
        draftRow.payment_status
      );

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

      const dueAt =
        paymentTermDays === null
          ? null
          : new Date(Date.now() + paymentTermDays * 86400000);
      await this.finance.createSalesReceivable(
        client,
        context,
        order.id,
        dueAt
      );

      const confirmedOrder = await client.query<{
        party_id: string | null;
        currency: string;
      }>(
        "SELECT party_id,currency FROM sales_order WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, order.id]
      );

      await this.attribution.recordConversion(client, context, {
        partyId: confirmedOrder.rows[0]?.party_id ?? null,
        sourceType: "SALES_ORDER",
        sourceId: order.id,
        conversionType: "ORDER",
        revenueMinor: 0n,
        currency: confirmedOrder.rows[0]?.currency ?? "RUB",
        metadata: {
          orderStatus: order.order_status
        }
      });

      await this.audit(
        client,
        context,
        "sales.order_confirmed",
        order.id
      );

      await this.events.enqueue(client, context, {
        eventName: "sales.order_confirmed",
        entityType: "SALES_ORDER",
        entityId: order.id,
        payload: {
          orderId: order.id,
          orderStatus: order.order_status,
          version: order.version
        }
      });

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

  private async validateCommercialCredit(
    client: PoolClient,
    tenantId: string,
    partyId: string | null,
    orderTotalMinor: bigint,
    orderCurrency: string,
    paymentStatus: string
  ): Promise<number | null> {
    if (!partyId) return null;

    const terms = await client.query<{
      currency: string;
      credit_limit_minor: string | null;
      payment_term_days: number;
      allow_over_credit: boolean;
    }>(
      `SELECT
         currency,credit_limit_minor::text,payment_term_days,allow_over_credit
       FROM party_commercial_terms
       WHERE tenant_id=$1 AND party_id=$2
       FOR UPDATE`,
      [tenantId, partyId]
    );
    const row = terms.rows[0];
    if (!row) return null;

    if (row.currency !== orderCurrency) {
      throw new ConflictException(
        "Валюта заказа не совпадает с коммерческими условиями клиента"
      );
    }

    if (
      row.credit_limit_minor !== null &&
      !row.allow_over_credit &&
      paymentStatus !== "PAID"
    ) {
      const exposure = await client.query<{ amount_minor: string }>(
        `SELECT COALESCE(sum(amount_minor-settled_minor),0)::text AS amount_minor
         FROM financial_obligation
         WHERE tenant_id=$1
           AND party_id=$2
           AND direction='RECEIVABLE'
           AND currency=$3
           AND status IN ('OPEN','PARTIALLY_SETTLED')`,
        [tenantId, partyId, orderCurrency]
      );
      const current = BigInt(exposure.rows[0]?.amount_minor ?? "0");
      const limit = BigInt(row.credit_limit_minor);
      if (current + orderTotalMinor > limit) {
        throw new ConflictException(
          "Кредитный лимит клиента превышен"
        );
      }
    }

    return row.payment_term_days;
  }

  private async prepareLine(
    client: PoolClient,
    tenantId: string,
    input: CreateLineInput,
    partyId: string | null,
    orderCurrency: string,
    defaultDiscountBps: number
  ): Promise<{
    skuId: string | null;
    description: string;
    quantityMilli: bigint;
    unitPriceMinor: bigint;
    costPriceMinorSnapshot: bigint;
    discountMinor: bigint;
    lineTotalMinor: bigint;
    pricingSource: "MANUAL" | "LIST" | "PARTY_PRICE" | "DEFAULT_DISCOUNT";
    priceRuleId: string | null;
  }> {
    let quantityMilli: bigint;
    try {
      quantityMilli = BigInt(input.quantityMilli ?? "1000");
    } catch {
      throw new BadRequestException("Некорректное количество");
    }
    if (quantityMilli <= 0n) {
      throw new BadRequestException("Количество должно быть больше нуля");
    }

    let description = input.description?.trim() ?? "";
    let unitPriceMinor: bigint;
    let costPriceMinorSnapshot = 0n;
    let skuId: string | null = null;
    let pricingSource:
      | "MANUAL"
      | "LIST"
      | "PARTY_PRICE"
      | "DEFAULT_DISCOUNT" = "MANUAL";
    let priceRuleId: string | null = null;

    if (input.unitPriceMinor !== undefined && !/^\d+$/.test(input.unitPriceMinor)) {
      throw new BadRequestException("Некорректная цена позиции");
    }
    if (input.discountMinor !== undefined && !/^\d+$/.test(input.discountMinor)) {
      throw new BadRequestException("Некорректная скидка");
    }

    if (input.skuId) {
      const skuResult = await client.query<{
        id: string;
        code: string;
        sale_price_minor: string;
        cost_price_minor: string;
        currency: string;
        product_name: string;
      }>(
        `SELECT
           s.id,s.code,s.sale_price_minor::text,s.cost_price_minor::text,
           s.currency,p.name AS product_name
         FROM sku s
         JOIN product_variant v
           ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p
           ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE s.tenant_id=$1 AND s.id=$2
           AND s.status='ACTIVE' AND p.status='ACTIVE'`,
        [tenantId, input.skuId]
      );
      const sku = skuResult.rows[0];
      if (!sku) throw new NotFoundException("SKU не найден");

      skuId = sku.id;
      description ||= sku.product_name;
      costPriceMinorSnapshot = BigInt(sku.cost_price_minor);

      if (input.unitPriceMinor !== undefined) {
        unitPriceMinor = BigInt(input.unitPriceMinor);
        pricingSource = "MANUAL";
      } else {
        let partyPrice: { id: string; unit_price_minor: string } | undefined;
        if (partyId) {
          const price = await client.query<{
            id: string;
            unit_price_minor: string;
          }>(
            `SELECT id,unit_price_minor::text
             FROM party_sku_price
             WHERE tenant_id=$1
               AND party_id=$2
               AND sku_id=$3
               AND currency=$4
               AND status='ACTIVE'
               AND min_quantity_milli<=$5
               AND valid_from<=now()
               AND (valid_to IS NULL OR valid_to>now())
             ORDER BY min_quantity_milli DESC,valid_from DESC
             LIMIT 1`,
            [tenantId, partyId, sku.id, orderCurrency, quantityMilli.toString()]
          );
          partyPrice = price.rows[0];
        }

        if (partyPrice) {
          unitPriceMinor = BigInt(partyPrice.unit_price_minor);
          pricingSource = "PARTY_PRICE";
          priceRuleId = partyPrice.id;
        } else {
          if (sku.currency !== orderCurrency) {
            throw new ConflictException(
              "Для SKU нет цены в валюте заказа"
            );
          }
          unitPriceMinor = BigInt(sku.sale_price_minor);
          pricingSource = "LIST";
        }
      }
    } else {
      if (!description) {
        throw new BadRequestException("Для строки без SKU нужно описание");
      }
      if (input.unitPriceMinor === undefined) {
        throw new BadRequestException("Укажите цену позиции");
      }
      unitPriceMinor = BigInt(input.unitPriceMinor);
      pricingSource = "MANUAL";
    }

    const gross = (unitPriceMinor * quantityMilli + 500n) / 1000n;
    let discountMinor: bigint;
    if (input.discountMinor !== undefined) {
      discountMinor = BigInt(input.discountMinor);
    } else if (
      pricingSource === "LIST" &&
      defaultDiscountBps > 0
    ) {
      discountMinor =
        (gross * BigInt(defaultDiscountBps) + 5000n) / 10000n;
      pricingSource = "DEFAULT_DISCOUNT";
    } else {
      discountMinor = 0n;
    }

    if (discountMinor > gross) {
      throw new BadRequestException("Скидка превышает сумму позиции");
    }

    return {
      skuId,
      description,
      quantityMilli,
      unitPriceMinor,
      costPriceMinorSnapshot,
      discountMinor,
      lineTotalMinor: gross - discountMinor,
      pricingSource,
      priceRuleId
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
    partyId: string,
    scopedMembershipIds: string[] | null = null
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM party
       WHERE tenant_id = $1
         AND id = $2
         AND status = 'ACTIVE'
         AND (
           $3::uuid[] IS NULL
           OR responsible_membership_id = ANY($3::uuid[])
         )`,
      [tenantId, partyId, scopedMembershipIds]
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

  private async auditEntity(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    afterData?: Record<string, unknown>
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
        afterData ? JSON.stringify(afterData) : null
      ]
    );
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
