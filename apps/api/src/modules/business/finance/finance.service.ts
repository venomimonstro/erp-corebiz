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
import { AttributionService } from "../growth/attribution.service";

@Injectable()
export class FinanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: DomainEventService,
    private readonly attribution: AttributionService
  ) {}

  async summary(context: TenantContext): Promise<{
    accounts: Array<{
      id: string;
      name: string;
      kind: string;
      currency: string;
      balanceMinor: string;
      isDefault: boolean;
    }>;
    receivableMinor: string;
    payableMinor: string;
    overdueReceivableMinor: string;
    overduePayableMinor: string;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const accounts = await client.query<{
        id: string;
        name: string;
        kind: string;
        currency: string;
        opening_balance_minor: string;
        is_default: boolean;
        movement_minor: string;
      }>(
        `SELECT
           a.id,
           a.name,
           a.kind,
           a.currency,
           a.opening_balance_minor::text,
           a.is_default,
           COALESCE(sum(
             CASE
               WHEN p.status <> 'POSTED' THEN 0
               WHEN p.direction = 'IN' THEN p.amount_minor
               ELSE -p.amount_minor
             END
           ), 0)::text AS movement_minor
         FROM cash_account a
         LEFT JOIN payment p
           ON p.tenant_id = a.tenant_id
          AND p.cash_account_id = a.id
         WHERE a.tenant_id = $1
           AND a.status = 'ACTIVE'
         GROUP BY a.id
         ORDER BY a.is_default DESC, a.name`,
        [context.tenantId]
      );

      const obligations = await client.query<{
        direction: "RECEIVABLE" | "PAYABLE";
        open_minor: string;
        overdue_minor: string;
      }>(
        `SELECT
           direction,
           sum(amount_minor - settled_minor)::text AS open_minor,
           sum(
             CASE
               WHEN due_at IS NOT NULL AND due_at < now()
                 THEN amount_minor - settled_minor
               ELSE 0
             END
           )::text AS overdue_minor
         FROM financial_obligation
         WHERE tenant_id = $1
           AND status IN ('OPEN','PARTIALLY_SETTLED')
         GROUP BY direction`,
        [context.tenantId]
      );

      const receivable = obligations.rows.find(
        (row) => row.direction === "RECEIVABLE"
      );
      const payable = obligations.rows.find(
        (row) => row.direction === "PAYABLE"
      );

      return {
        accounts: accounts.rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          currency: row.currency,
          balanceMinor: (
            BigInt(row.opening_balance_minor) + BigInt(row.movement_minor)
          ).toString(),
          isDefault: row.is_default
        })),
        receivableMinor: receivable?.open_minor ?? "0",
        payableMinor: payable?.open_minor ?? "0",
        overdueReceivableMinor: receivable?.overdue_minor ?? "0",
        overduePayableMinor: payable?.overdue_minor ?? "0"
      };
    });
  }

  async listObligations(
    context: TenantContext,
    direction?: "RECEIVABLE" | "PAYABLE"
  ): Promise<Array<{
    id: string;
    direction: string;
    partyName: string | null;
    sourceType: string;
    sourceId: string;
    amountMinor: string;
    settledMinor: string;
    remainingMinor: string;
    currency: string;
    status: string;
    dueAt: string | null;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        direction: string;
        party_name: string | null;
        source_type: string;
        source_id: string;
        amount_minor: string;
        settled_minor: string;
        remaining_minor: string;
        currency: string;
        status: string;
        due_at: Date | null;
      }>(
        `SELECT
           o.id,
           o.direction,
           p.display_name AS party_name,
           o.source_type,
           o.source_id,
           o.amount_minor::text,
           o.settled_minor::text,
           (o.amount_minor - o.settled_minor)::text AS remaining_minor,
           o.currency,
           o.status,
           o.due_at
         FROM financial_obligation o
         LEFT JOIN party p
           ON p.tenant_id = o.tenant_id
          AND p.id = o.party_id
         WHERE o.tenant_id = $1
           AND ($2::text IS NULL OR o.direction = $2)
         ORDER BY
           CASE WHEN o.status IN ('OPEN','PARTIALLY_SETTLED') THEN 0 ELSE 1 END,
           o.due_at ASC NULLS LAST,
           o.created_at DESC
         LIMIT 1000`,
        [context.tenantId, direction ?? null]
      );

      return result.rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        partyName: row.party_name,
        sourceType: row.source_type,
        sourceId: row.source_id,
        amountMinor: row.amount_minor,
        settledMinor: row.settled_minor,
        remainingMinor: row.remaining_minor,
        currency: row.currency,
        status: row.status,
        dueAt: row.due_at?.toISOString() ?? null
      }));
    });
  }

  async listPayments(context: TenantContext): Promise<Array<{
    id: string;
    number: string;
    accountName: string;
    partyName: string | null;
    direction: string;
    kind: string;
    amountMinor: string;
    currency: string;
    status: string;
    postedAt: string;
    note: string | null;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        business_number: string;
        account_name: string;
        party_name: string | null;
        direction: string;
        kind: string;
        amount_minor: string;
        currency: string;
        status: string;
        posted_at: Date;
        note: string | null;
      }>(
        `SELECT
           p.id,
           p.business_number,
           a.name AS account_name,
           party.display_name AS party_name,
           p.direction,
           p.kind,
           p.amount_minor::text,
           p.currency,
           p.status,
           p.posted_at,
           p.note
         FROM payment p
         JOIN cash_account a
           ON a.tenant_id = p.tenant_id
          AND a.id = p.cash_account_id
         LEFT JOIN party
           ON party.tenant_id = p.tenant_id
          AND party.id = p.party_id
         WHERE p.tenant_id = $1
         ORDER BY p.posted_at DESC
         LIMIT 1000`,
        [context.tenantId]
      );

      return result.rows.map((row) => ({
        id: row.id,
        number: row.business_number,
        accountName: row.account_name,
        partyName: row.party_name,
        direction: row.direction,
        kind: row.kind,
        amountMinor: row.amount_minor,
        currency: row.currency,
        status: row.status,
        postedAt: row.posted_at.toISOString(),
        note: row.note
      }));
    });
  }

  async listInvoices(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           i.id,i.business_number,i.party_id,p.display_name AS party_name,
           i.source_type,i.source_id,i.obligation_id,
           i.period_from,i.period_to,i.currency,i.amount_minor::text,i.status,
           i.issued_at,i.due_at,i.updated_at,
           o.settled_minor::text,
           (o.amount_minor-o.settled_minor)::text AS remaining_minor
         FROM finance_invoice i
         JOIN financial_obligation o
           ON o.tenant_id=i.tenant_id AND o.id=i.obligation_id
         JOIN party p
           ON p.tenant_id=i.tenant_id AND p.id=i.party_id
         WHERE i.tenant_id=$1
         ORDER BY i.issued_at DESC
         LIMIT 1000`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async create3plStatementInvoice(
    context: TenantContext,
    statementId: string,
    input?: { dueAt?: string }
  ): Promise<{ invoiceId: string; obligationId: string; number: string }> {
    const dueAt = input?.dueAt ? new Date(input.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      throw new BadRequestException("Некорректный срок оплаты");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const statement = await client.query<{
        id: string;
        status: string;
        owner_id: string;
        period_from: string;
        period_to: string;
        currency: string;
        total_minor: string;
        party_id: string | null;
        finance_invoice_id: string | null;
      }>(
        `SELECT
           s.id,s.status,s.owner_id,s.period_from::text,s.period_to::text,
           s.currency,s.total_minor::text,
           io.party_id,s.finance_invoice_id
         FROM wms_3pl_statement s
         JOIN inventory_owner io
           ON io.tenant_id=s.tenant_id AND io.id=s.owner_id
         WHERE s.tenant_id=$1 AND s.id=$2
         FOR UPDATE OF s`,
        [context.tenantId, statementId]
      );

      const row = statement.rows[0];
      if (!row) throw new NotFoundException("3PL statement не найден");
      if (row.status !== "FINALIZED") {
        throw new BadRequestException(
          "В Finance можно передать только FINALIZED statement"
        );
      }
      if (!row.party_id) {
        throw new ConflictException(
          "3PL-владелец не связан с клиентом CRM"
        );
      }

      if (row.finance_invoice_id) {
        const existing = await client.query<{
          id: string;
          business_number: string;
          obligation_id: string;
        }>(
          `SELECT id,business_number,obligation_id
           FROM finance_invoice
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, row.finance_invoice_id]
        );
        const invoice = existing.rows[0];
        if (!invoice) {
          throw new ConflictException("Finance link statement повреждён");
        }
        return {
          invoiceId: invoice.id,
          obligationId: invoice.obligation_id,
          number: invoice.business_number
        };
      }

      const obligation = await client.query<{ id: string }>(
        `INSERT INTO financial_obligation(
           tenant_id,direction,party_id,source_type,source_id,
           currency,amount_minor,due_at
         ) VALUES ($1,'RECEIVABLE',$2,'WMS_3PL_STATEMENT',$3,$4,$5,$6)
         ON CONFLICT (tenant_id,direction,source_type,source_id)
         DO UPDATE SET
           party_id=EXCLUDED.party_id,
           due_at=EXCLUDED.due_at,
           updated_at=now()
         RETURNING id`,
        [
          context.tenantId,
          row.party_id,
          row.id,
          row.currency,
          row.total_minor,
          dueAt
        ]
      );

      const obligationId = obligation.rows[0]!.id;
      const number = await this.nextNumber(
        client,
        context.tenantId,
        "finance_invoice",
        "INV"
      );

      const invoice = await client.query<{ id: string }>(
        `INSERT INTO finance_invoice(
           tenant_id,business_number,party_id,source_type,source_id,
           obligation_id,period_from,period_to,currency,amount_minor,due_at,
           created_by_membership_id
         ) VALUES ($1,$2,$3,'WMS_3PL_STATEMENT',$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id,source_type,source_id)
         DO UPDATE SET updated_at=finance_invoice.updated_at
         RETURNING id`,
        [
          context.tenantId,
          number,
          row.party_id,
          row.id,
          obligationId,
          row.period_from,
          row.period_to,
          row.currency,
          row.total_minor,
          dueAt,
          context.membershipId
        ]
      );

      const invoiceId = invoice.rows[0]!.id;

      await client.query(
        `UPDATE wms_3pl_statement
         SET finance_invoice_id=$3,
             finance_handed_off_at=COALESCE(finance_handed_off_at,now()),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, row.id, invoiceId]
      );

      await this.audit(
        client,
        context,
        "finance.3pl_invoice_issued",
        "finance_invoice",
        invoiceId,
        {
          statementId: row.id,
          obligationId,
          amountMinor: row.total_minor,
          currency: row.currency
        }
      );

      await this.events.enqueue(client, context, {
        eventName: "finance.invoice_issued",
        entityType: "FINANCE_INVOICE",
        entityId: invoiceId,
        payload: {
          invoiceId,
          sourceType: "WMS_3PL_STATEMENT",
          sourceId: row.id,
          partyId: row.party_id,
          obligationId,
          amountMinor: row.total_minor,
          currency: row.currency,
          periodFrom: row.period_from,
          periodTo: row.period_to
        }
      });

      return { invoiceId, obligationId, number };
    });
  }

  async receiveInvoicePayment(
    context: TenantContext,
    input: {
      invoiceId: string;
      amountMinor: string;
      cashAccountId?: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<{ paymentId: string; number: string; invoiceStatus: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        const state = await client.query<{ status: string }>(
          `SELECT status FROM finance_invoice
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, input.invoiceId]
        );
        return {
          paymentId: existing.id,
          number: existing.business_number,
          invoiceStatus: state.rows[0]?.status ?? "ISSUED"
        };
      }

      const amount = this.parsePositiveAmount(input.amountMinor);

      const invoice = await client.query<{
        id: string;
        party_id: string;
        obligation_id: string;
        currency: string;
        amount_minor: string;
        status: string;
        settled_minor: string;
      }>(
        `SELECT
           i.id,i.party_id,i.obligation_id,i.currency,i.amount_minor::text,
           i.status,o.settled_minor::text
         FROM finance_invoice i
         JOIN financial_obligation o
           ON o.tenant_id=i.tenant_id AND o.id=i.obligation_id
         WHERE i.tenant_id=$1 AND i.id=$2
         FOR UPDATE OF i,o`,
        [context.tenantId, input.invoiceId]
      );

      const row = invoice.rows[0];
      if (!row) throw new NotFoundException("Счёт не найден");
      if (["CANCELLED","CREDITED"].includes(row.status)) {
        throw new BadRequestException("Счёт не принимает оплату");
      }

      const remaining =
        BigInt(row.amount_minor) - BigInt(row.settled_minor);
      if (amount > remaining) {
        throw new ConflictException("Платёж превышает остаток по счёту");
      }

      const accountId =
        input.cashAccountId ??
        (await this.getDefaultCashAccountId(
          client,
          context.tenantId,
          row.currency
        ));
      const categoryId = await this.getCategoryId(
        client,
        context.tenantId,
        "CUSTOMER_PAYMENT"
      );

      const payment = await this.insertPayment(client, context, {
        cashAccountId: accountId,
        categoryId,
        partyId: row.party_id,
        obligationId: row.obligation_id,
        direction: "IN",
        kind: "PAYMENT",
        amountMinor: amount,
        currency: row.currency,
        sourceType: "FINANCE_INVOICE",
        sourceId: row.id,
        idempotencyKey: input.idempotencyKey,
        note: input.note
      });

      const settled = BigInt(row.settled_minor) + amount;
      const obligationStatus =
        settled === BigInt(row.amount_minor)
          ? "SETTLED"
          : "PARTIALLY_SETTLED";

      await client.query(
        `UPDATE financial_obligation
         SET settled_minor=$3,status=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,
          row.obligation_id,
          settled.toString(),
          obligationStatus
        ]
      );

      const state = await client.query<{ status: string }>(
        `SELECT status FROM finance_invoice
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, row.id]
      );

      await this.audit(
        client,
        context,
        "finance.invoice_payment_posted",
        "payment",
        payment.id,
        {
          invoiceId: row.id,
          amountMinor: amount.toString()
        }
      );

      await this.events.enqueue(client, context, {
        eventName: "finance.invoice_payment_posted",
        entityType: "PAYMENT",
        entityId: payment.id,
        payload: {
          paymentId: payment.id,
          invoiceId: row.id,
          obligationId: row.obligation_id,
          amountMinor: amount.toString(),
          currency: row.currency,
          invoiceStatus: state.rows[0]?.status
        }
      });

      return {
        paymentId: payment.id,
        number: payment.business_number,
        invoiceStatus: state.rows[0]?.status ?? "PARTIALLY_PAID"
      };
    });
  }

  async createCashAccount(
    context: TenantContext,
    input: {
      name: string;
      kind?: "BANK" | "CASH" | "ACQUIRING" | "OTHER";
      currency?: string;
      openingBalanceMinor?: string;
    }
  ): Promise<{ id: string; name: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название счёта");
    }

    const opening = input.openingBalanceMinor ?? "0";
    if (!/^-?\d+$/.test(opening)) {
      throw new BadRequestException("Некорректный начальный баланс");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string; name: string }>(
        `INSERT INTO cash_account(
           tenant_id, name, kind, currency, opening_balance_minor
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name`,
        [
          context.tenantId,
          name,
          input.kind ?? "BANK",
          input.currency?.trim().toUpperCase() || "RUB",
          opening
        ]
      );

      const row = result.rows[0];
      if (!row) throw new Error("CASH_ACCOUNT_CREATE_FAILED");

      await this.audit(
        client,
        context,
        "finance.cash_account_created",
        "cash_account",
        row.id
      );

      return row;
    });
  }

  async createSalesReceivable(
    client: PoolClient,
    context: TenantContext,
    orderId: string
  ): Promise<string> {
    const order = await client.query<{
      id: string;
      party_id: string | null;
      total_minor: string;
      currency: string;
      order_status: string;
    }>(
      `SELECT id, party_id, total_minor::text, currency, order_status
       FROM sales_order
       WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, orderId]
    );

    const row = order.rows[0];
    if (!row) throw new NotFoundException("Заказ не найден");
    if (row.order_status !== "CONFIRMED") {
      throw new BadRequestException("Дебиторка создаётся только по подтверждённому заказу");
    }

    const result = await client.query<{ id: string }>(
      `INSERT INTO financial_obligation(
         tenant_id, direction, party_id, source_type, source_id,
         currency, amount_minor
       ) VALUES ($1,'RECEIVABLE',$2,'SALES_ORDER',$3,$4,$5)
       ON CONFLICT (tenant_id, direction, source_type, source_id)
       DO UPDATE SET
         party_id = EXCLUDED.party_id,
         currency = EXCLUDED.currency,
         amount_minor = EXCLUDED.amount_minor,
         updated_at = now()
       RETURNING id`,
      [
        context.tenantId,
        row.party_id,
        row.id,
        row.currency,
        row.total_minor
      ]
    );

    return result.rows[0]!.id;
  }

  async createPurchasePayable(
    client: PoolClient,
    context: TenantContext,
    purchaseOrderId: string
  ): Promise<string> {
    const order = await client.query<{
      id: string;
      supplier_party_id: string;
      total_minor: string;
      currency: string;
      status: string;
    }>(
      `SELECT id, supplier_party_id, total_minor::text, currency, status
       FROM purchase_order
       WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, purchaseOrderId]
    );

    const row = order.rows[0];
    if (!row) throw new NotFoundException("Закупка не найдена");
    if (row.status !== "CONFIRMED") {
      throw new BadRequestException("Кредиторка создаётся только по подтверждённой закупке");
    }

    const result = await client.query<{ id: string }>(
      `INSERT INTO financial_obligation(
         tenant_id, direction, party_id, source_type, source_id,
         currency, amount_minor
       ) VALUES ($1,'PAYABLE',$2,'PURCHASE_ORDER',$3,$4,$5)
       ON CONFLICT (tenant_id, direction, source_type, source_id)
       DO UPDATE SET
         party_id = EXCLUDED.party_id,
         currency = EXCLUDED.currency,
         amount_minor = EXCLUDED.amount_minor,
         updated_at = now()
       RETURNING id`,
      [
        context.tenantId,
        row.supplier_party_id,
        row.id,
        row.currency,
        row.total_minor
      ]
    );

    return result.rows[0]!.id;
  }

  async receiveSalesPayment(
    context: TenantContext,
    input: {
      orderId: string;
      amountMinor: string;
      cashAccountId?: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<{ paymentId: string; number: string; paymentStatus: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        const orderStatus = await this.salesPaymentStatus(
          client,
          context.tenantId,
          input.orderId
        );
        return {
          paymentId: existing.id,
          number: existing.business_number,
          paymentStatus: orderStatus
        };
      }

      const amount = this.parsePositiveAmount(input.amountMinor);
      const order = await client.query<{
        id: string;
        party_id: string | null;
        total_minor: string;
        currency: string;
        order_status: string;
      }>(
        `SELECT id, party_id, total_minor::text, currency, order_status
         FROM sales_order
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, input.orderId]
      );

      const row = order.rows[0];
      if (!row) throw new NotFoundException("Заказ не найден");
      if (row.order_status === "CANCELLED") {
        throw new BadRequestException("Нельзя оплатить отменённый заказ");
      }

      let obligation = await client.query<{
        id: string;
        amount_minor: string;
        settled_minor: string;
      }>(
        `SELECT id, amount_minor::text, settled_minor::text
         FROM financial_obligation
         WHERE tenant_id = $1
           AND direction = 'RECEIVABLE'
           AND source_type = 'SALES_ORDER'
           AND source_id = $2
         FOR UPDATE`,
        [context.tenantId, input.orderId]
      );

      if (!obligation.rows[0]) {
        if (row.order_status !== "CONFIRMED" && row.order_status !== "COMPLETED") {
          throw new BadRequestException("Сначала подтвердите заказ");
        }
        await this.createSalesReceivable(client, context, input.orderId);
        obligation = await client.query(
          `SELECT id, amount_minor::text, settled_minor::text
           FROM financial_obligation
           WHERE tenant_id = $1
             AND direction = 'RECEIVABLE'
             AND source_type = 'SALES_ORDER'
             AND source_id = $2
           FOR UPDATE`,
          [context.tenantId, input.orderId]
        );
      }

      const debt = obligation.rows[0]!;
      const remaining =
        BigInt(debt.amount_minor) - BigInt(debt.settled_minor);

      if (amount > remaining) {
        throw new ConflictException("Платёж превышает остаток дебиторской задолженности");
      }

      const accountId =
        input.cashAccountId ??
        (await this.getDefaultCashAccountId(client, context.tenantId, row.currency));

      const categoryId = await this.getCategoryId(
        client,
        context.tenantId,
        "CUSTOMER_PAYMENT"
      );

      const payment = await this.insertPayment(client, context, {
        cashAccountId: accountId,
        categoryId,
        partyId: row.party_id,
        obligationId: debt.id,
        direction: "IN",
        kind: "PAYMENT",
        amountMinor: amount,
        currency: row.currency,
        sourceType: "SALES_ORDER",
        sourceId: row.id,
        idempotencyKey: input.idempotencyKey,
        note: input.note
      });

      const settled = BigInt(debt.settled_minor) + amount;
      const obligationStatus =
        settled === BigInt(debt.amount_minor) ? "SETTLED" : "PARTIALLY_SETTLED";

      await client.query(
        `UPDATE financial_obligation
         SET settled_minor = $3,
             status = $4,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, debt.id, settled.toString(), obligationStatus]
      );

      const paymentStatus =
        settled === BigInt(debt.amount_minor) ? "PAID" : "PARTIALLY_PAID";

      await client.query(
        `UPDATE sales_order
         SET payment_status = $3,
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, row.id, paymentStatus]
      );

      await this.audit(
        client,
        context,
        "finance.customer_payment_posted",
        "payment",
        payment.id,
        { orderId: row.id, amountMinor: amount.toString() }
      );

      await this.attribution.recordConversion(client, context, {
        partyId: row.party_id,
        sourceType: "PAYMENT",
        sourceId: payment.id,
        conversionType: "PAYMENT",
        revenueMinor: amount,
        currency: row.currency,
        metadata: {
          orderId: row.id,
          paymentStatus
        }
      });

      await this.events.enqueue(client, context, {
        eventName: "finance.payment_posted",
        entityType: "PAYMENT",
        entityId: payment.id,
        payload: {
          paymentId: payment.id,
          orderId: row.id,
          direction: "IN",
          kind: "PAYMENT",
          amountMinor: amount.toString(),
          currency: row.currency,
          paymentStatus
        }
      });

      return {
        paymentId: payment.id,
        number: payment.business_number,
        paymentStatus
      };
    });
  }

  async paySupplier(
    context: TenantContext,
    input: {
      purchaseOrderId: string;
      amountMinor: string;
      cashAccountId?: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<{ paymentId: string; number: string; obligationStatus: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        return {
          paymentId: existing.id,
          number: existing.business_number,
          obligationStatus: "POSTED"
        };
      }

      const amount = this.parsePositiveAmount(input.amountMinor);
      const order = await client.query<{
        id: string;
        supplier_party_id: string;
        total_minor: string;
        currency: string;
        status: string;
      }>(
        `SELECT id, supplier_party_id, total_minor::text, currency, status
         FROM purchase_order
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, input.purchaseOrderId]
      );

      const row = order.rows[0];
      if (!row) throw new NotFoundException("Закупка не найдена");
      if (row.status === "DRAFT" || row.status === "CANCELLED") {
        throw new BadRequestException("Закупка не готова к оплате");
      }

      let obligation = await client.query<{
        id: string;
        amount_minor: string;
        settled_minor: string;
      }>(
        `SELECT id, amount_minor::text, settled_minor::text
         FROM financial_obligation
         WHERE tenant_id = $1
           AND direction = 'PAYABLE'
           AND source_type = 'PURCHASE_ORDER'
           AND source_id = $2
         FOR UPDATE`,
        [context.tenantId, row.id]
      );

      if (!obligation.rows[0]) {
        await this.createPurchasePayable(client, context, row.id);
        obligation = await client.query(
          `SELECT id, amount_minor::text, settled_minor::text
           FROM financial_obligation
           WHERE tenant_id = $1
             AND direction = 'PAYABLE'
             AND source_type = 'PURCHASE_ORDER'
             AND source_id = $2
           FOR UPDATE`,
          [context.tenantId, row.id]
        );
      }

      const debt = obligation.rows[0]!;
      const remaining =
        BigInt(debt.amount_minor) - BigInt(debt.settled_minor);

      if (amount > remaining) {
        throw new ConflictException("Платёж превышает остаток кредиторской задолженности");
      }

      const accountId =
        input.cashAccountId ??
        (await this.getDefaultCashAccountId(client, context.tenantId, row.currency));

      const categoryId = await this.getCategoryId(
        client,
        context.tenantId,
        "SUPPLIER_PAYMENT"
      );

      const payment = await this.insertPayment(client, context, {
        cashAccountId: accountId,
        categoryId,
        partyId: row.supplier_party_id,
        obligationId: debt.id,
        direction: "OUT",
        kind: "PAYMENT",
        amountMinor: amount,
        currency: row.currency,
        sourceType: "PURCHASE_ORDER",
        sourceId: row.id,
        idempotencyKey: input.idempotencyKey,
        note: input.note
      });

      const settled = BigInt(debt.settled_minor) + amount;
      const obligationStatus =
        settled === BigInt(debt.amount_minor) ? "SETTLED" : "PARTIALLY_SETTLED";

      await client.query(
        `UPDATE financial_obligation
         SET settled_minor = $3,
             status = $4,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, debt.id, settled.toString(), obligationStatus]
      );

      await this.audit(
        client,
        context,
        "finance.supplier_payment_posted",
        "payment",
        payment.id,
        { purchaseOrderId: row.id, amountMinor: amount.toString() }
      );

      await this.events.enqueue(client, context, {
        eventName: "finance.payment_posted",
        entityType: "PAYMENT",
        entityId: payment.id,
        payload: {
          paymentId: payment.id,
          purchaseOrderId: row.id,
          direction: "OUT",
          kind: "PAYMENT",
          amountMinor: amount.toString(),
          currency: row.currency,
          obligationStatus
        }
      });

      return {
        paymentId: payment.id,
        number: payment.business_number,
        obligationStatus
      };
    });
  }

  async refundSalesPayment(
    context: TenantContext,
    input: {
      orderId: string;
      amountMinor: string;
      cashAccountId?: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<{ paymentId: string; number: string; paymentStatus: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        return {
          paymentId: existing.id,
          number: existing.business_number,
          paymentStatus: await this.salesPaymentStatus(
            client,
            context.tenantId,
            input.orderId
          )
        };
      }

      const amount = this.parsePositiveAmount(input.amountMinor);
      const order = await client.query<{
        id: string;
        party_id: string | null;
        currency: string;
      }>(
        `SELECT id, party_id, currency
         FROM sales_order
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, input.orderId]
      );

      const row = order.rows[0];
      if (!row) throw new NotFoundException("Заказ не найден");

      const obligation = await client.query<{
        id: string;
        amount_minor: string;
        settled_minor: string;
      }>(
        `SELECT id, amount_minor::text, settled_minor::text
         FROM financial_obligation
         WHERE tenant_id = $1
           AND direction = 'RECEIVABLE'
           AND source_type = 'SALES_ORDER'
           AND source_id = $2
         FOR UPDATE`,
        [context.tenantId, row.id]
      );

      const debt = obligation.rows[0];
      if (!debt || BigInt(debt.settled_minor) < amount) {
        throw new ConflictException("Сумма возврата превышает полученные средства");
      }

      const accountId =
        input.cashAccountId ??
        (await this.getDefaultCashAccountId(client, context.tenantId, row.currency));
      const categoryId = await this.getCategoryId(
        client,
        context.tenantId,
        "CUSTOMER_REFUND"
      );

      const payment = await this.insertPayment(client, context, {
        cashAccountId: accountId,
        categoryId,
        partyId: row.party_id,
        obligationId: debt.id,
        direction: "OUT",
        kind: "REFUND",
        amountMinor: amount,
        currency: row.currency,
        sourceType: "SALES_ORDER",
        sourceId: row.id,
        idempotencyKey: input.idempotencyKey,
        note: input.note
      });

      const settled = BigInt(debt.settled_minor) - amount;
      const total = BigInt(debt.amount_minor);
      const obligationStatus =
        settled === 0n
          ? "OPEN"
          : settled === total
            ? "SETTLED"
            : "PARTIALLY_SETTLED";

      await client.query(
        `UPDATE financial_obligation
         SET settled_minor = $3,
             status = $4,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, debt.id, settled.toString(), obligationStatus]
      );

      const paymentStatus =
        settled === 0n
          ? "REFUNDED"
          : settled === total
            ? "PAID"
            : "PARTIALLY_REFUNDED";

      await client.query(
        `UPDATE sales_order
         SET payment_status = $3,
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, row.id, paymentStatus]
      );

      await this.audit(
        client,
        context,
        "finance.customer_refund_posted",
        "payment",
        payment.id,
        { orderId: row.id, amountMinor: amount.toString() }
      );

      await this.attribution.recordConversion(client, context, {
        partyId: row.party_id,
        sourceType: "PAYMENT",
        sourceId: payment.id,
        conversionType: "REFUND",
        revenueMinor: -amount,
        currency: row.currency,
        metadata: {
          orderId: row.id,
          paymentStatus
        }
      });

      await this.events.enqueue(client, context, {
        eventName: "finance.refund_posted",
        entityType: "PAYMENT",
        entityId: payment.id,
        payload: {
          paymentId: payment.id,
          orderId: row.id,
          direction: "OUT",
          kind: "REFUND",
          amountMinor: amount.toString(),
          currency: row.currency,
          paymentStatus
        }
      });

      return {
        paymentId: payment.id,
        number: payment.business_number,
        paymentStatus
      };
    });
  }

  private parsePositiveAmount(value: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException("Некорректная сумма");
    }
    const amount = BigInt(value);
    if (amount <= 0n) {
      throw new BadRequestException("Сумма должна быть больше нуля");
    }
    return amount;
  }

  private async insertPayment(
    client: PoolClient,
    context: TenantContext,
    input: {
      cashAccountId: string;
      categoryId: string | null;
      partyId: string | null;
      obligationId: string | null;
      direction: "IN" | "OUT";
      kind: "PAYMENT" | "REFUND";
      amountMinor: bigint;
      currency: string;
      sourceType: string;
      sourceId: string;
      idempotencyKey: string;
      note?: string;
    }
  ): Promise<{ id: string; business_number: string }> {
    const account = await client.query<{ currency: string }>(
      `SELECT currency
       FROM cash_account
       WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [context.tenantId, input.cashAccountId]
    );

    const accountRow = account.rows[0];
    if (!accountRow) throw new NotFoundException("Денежный счёт не найден");
    if (accountRow.currency !== input.currency) {
      throw new BadRequestException("Валюта счёта не совпадает с валютой платежа");
    }

    const number = await this.nextNumber(
      client,
      context.tenantId,
      "payment",
      "PAY"
    );

    const result = await client.query<{
      id: string;
      business_number: string;
    }>(
      `INSERT INTO payment(
         tenant_id, business_number, cash_account_id, category_id,
         party_id, obligation_id, direction, kind,
         amount_minor, currency, source_type, source_id,
         idempotency_key, note, posted_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, business_number`,
      [
        context.tenantId,
        number,
        input.cashAccountId,
        input.categoryId,
        input.partyId,
        input.obligationId,
        input.direction,
        input.kind,
        input.amountMinor.toString(),
        input.currency,
        input.sourceType,
        input.sourceId,
        input.idempotencyKey,
        input.note?.trim() || null,
        context.membershipId
      ]
    );

    const row = result.rows[0];
    if (!row) throw new Error("PAYMENT_CREATE_FAILED");
    return row;
  }

  private async getDefaultCashAccountId(
    client: PoolClient,
    tenantId: string,
    currency: string
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM cash_account
       WHERE tenant_id = $1
         AND currency = $2
         AND status = 'ACTIVE'
       ORDER BY is_default DESC, created_at ASC
       LIMIT 1`,
      [tenantId, currency]
    );

    const row = result.rows[0];
    if (!row) throw new NotFoundException("Денежный счёт не настроен");
    return row.id;
  }

  private async getCategoryId(
    client: PoolClient,
    tenantId: string,
    code: string
  ): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM cash_flow_category
       WHERE tenant_id = $1 AND code = $2 AND status = 'ACTIVE'
       LIMIT 1`,
      [tenantId, code]
    );
    return result.rows[0]?.id ?? null;
  }

  private async findPaymentByKey(
    client: PoolClient,
    tenantId: string,
    key: string
  ): Promise<{ id: string; business_number: string } | null> {
    if (!key?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    const result = await client.query<{
      id: string;
      business_number: string;
    }>(
      `SELECT id, business_number
       FROM payment
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key.trim()]
    );

    return result.rows[0] ?? null;
  }

  private async salesPaymentStatus(
    client: PoolClient,
    tenantId: string,
    orderId: string
  ): Promise<string> {
    const result = await client.query<{ payment_status: string }>(
      `SELECT payment_status
       FROM sales_order
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, orderId]
    );
    return result.rows[0]?.payment_status ?? "UNPAID";
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
