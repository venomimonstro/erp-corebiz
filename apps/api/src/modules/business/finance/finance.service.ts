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

type ExistingPayment = {
  id: string;
  business_number: string;
  source_type: string;
  source_id: string;
  amount_minor: string;
  direction: string;
  kind: string;
  cash_account_id: string;
};

@Injectable()
export class FinanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: DomainEventService,
    private readonly attribution: AttributionService
  ) {}

  async importBankStatement(context:TenantContext,input:{
    cashAccountId:string;sourceName:string;externalStatementId:string;
    currency:string;dateFrom:string;dateTo:string;
    lines:Array<{externalLineId:string;bookedOn:string;direction:"IN"|"OUT";
      amountMinor:string;counterpartyName?:string;purpose?:string}>;
  }) {
    const iso=/^\d{4}-\d{2}-\d{2}$/;
    if(!input?.cashAccountId || !input.sourceName?.trim() ||
       !input.externalStatementId?.trim() || !/^[A-Z]{3}$/.test(input.currency) ||
       !iso.test(input.dateFrom) || !iso.test(input.dateTo) ||
       input.dateFrom>input.dateTo || !Array.isArray(input.lines) ||
       input.lines.length===0 || input.lines.length>500) {
      throw new BadRequestException("Invalid bank statement batch");
    }
    const ids=new Set<string>();
    for(const line of input.lines) {
      if(!line?.externalLineId?.trim() || ids.has(line.externalLineId.trim()) ||
         !iso.test(line.bookedOn) || line.bookedOn<input.dateFrom ||
         line.bookedOn>input.dateTo || !["IN","OUT"].includes(line.direction) ||
         !/^\d+$/.test(line.amountMinor) || BigInt(line.amountMinor)<=0n) {
        throw new BadRequestException("Invalid or duplicate bank statement line");
      }
      ids.add(line.externalLineId.trim());
    }
    return this.database.withTenantTransaction(context,async client=>{
      const account=await client.query(
        `SELECT 1 FROM cash_account WHERE tenant_id=$1 AND id=$2
           AND currency=$3 AND status='ACTIVE' FOR UPDATE`,
        [context.tenantId,input.cashAccountId,input.currency]
      );
      if(!account.rowCount) throw new NotFoundException("Active cash account not found");
      const inserted=await client.query<{id:string}>(
        `INSERT INTO finance_bank_statement(
           tenant_id,cash_account_id,source_name,external_statement_id,currency,
           date_from,date_to,imported_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(tenant_id,cash_account_id,source_name,external_statement_id)
         DO NOTHING RETURNING id`,
        [context.tenantId,input.cashAccountId,input.sourceName.trim(),
         input.externalStatementId.trim(),input.currency,input.dateFrom,
         input.dateTo,context.membershipId]
      );
      if(!inserted.rows[0]) {
        throw new ConflictException("Statement external identifier has already been imported");
      }
      const statementId=inserted.rows[0].id;
      for(const line of input.lines) {
        await client.query(
          `INSERT INTO finance_bank_statement_line(
             tenant_id,statement_id,external_line_id,booked_on,direction,
             amount_minor,counterparty_name,purpose
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [context.tenantId,statementId,line.externalLineId.trim(),
           line.bookedOn,line.direction,line.amountMinor,
           line.counterpartyName?.slice(0,512)??null,line.purpose?.slice(0,2000)??null]
        );
      }
      return {statementId,importedLines:input.lines.length};
    });
  }

  async bankStatements(context:TenantContext) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT s.id,s.cash_account_id,s.source_name,s.external_statement_id,
                s.currency,s.date_from,s.date_to,s.status,s.imported_at,
                count(l.id)::integer AS line_count,
                count(l.id) FILTER (WHERE l.payment_id IS NULL)::integer AS unmatched_count
         FROM finance_bank_statement s
         LEFT JOIN finance_bank_statement_line l
           ON l.tenant_id=s.tenant_id AND l.statement_id=s.id
         WHERE s.tenant_id=$1
         GROUP BY s.id
         ORDER BY s.imported_at DESC LIMIT 200`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async bankStatementLines(context:TenantContext,statementId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const exists=await client.query(
        "SELECT 1 FROM finance_bank_statement WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,statementId]
      );
      if(!exists.rowCount) throw new NotFoundException("Bank statement not found");
      const result=await client.query(
        `SELECT id,external_line_id,booked_on,direction,amount_minor::text,
                counterparty_name,purpose,payment_id
         FROM finance_bank_statement_line
         WHERE tenant_id=$1 AND statement_id=$2 ORDER BY booked_on,id LIMIT 5000`,
        [context.tenantId,statementId]
      );
      return result.rows;
    });
  }

  async matchBankLine(context:TenantContext,input:{lineId:string;paymentId:string}) {
    if(!input?.lineId || !input?.paymentId) throw new BadRequestException("Line and payment required");
    return this.database.withTenantTransaction(context,async client=>{
      const line=await client.query<{id:string;payment_id:string|null;statement_id:string}>(
        `SELECT id,payment_id,statement_id FROM finance_bank_statement_line
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,input.lineId]
      );
      const row=line.rows[0];
      if(!row) throw new NotFoundException("Bank line not found");
      if(row.payment_id===input.paymentId) return {matched:true,alreadyMatched:true};
      if(row.payment_id) throw new ConflictException("Bank line already matched");
      const statement=await client.query<{status:string}>(
        `SELECT status FROM finance_bank_statement
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,row.statement_id]
      );
      if(statement.rows[0]?.status!=="IMPORTED") throw new ConflictException("Statement is finalized");
      const matched=await client.query(
        `UPDATE finance_bank_statement_line
         SET payment_id=$3 WHERE tenant_id=$1 AND id=$2
         RETURNING id`,
        [context.tenantId,input.lineId,input.paymentId]
      );
      return {matched:matched.rowCount===1,alreadyMatched:false};
    });
  }

  async unmatchBankLine(context:TenantContext,input:{
    lineId:string;reason:string;
  }) {
    if(!input?.lineId || typeof input.reason!=="string" ||
       input.reason.trim().length<12) {
      throw new BadRequestException("Correction requires bank line and detailed reason");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const line=await client.query<{payment_id:string|null;statement_id:string}>(
        `SELECT payment_id,statement_id FROM finance_bank_statement_line
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,input.lineId]
      );
      const row=line.rows[0];
      if(!row) throw new NotFoundException("Bank line not found");
      if(!row.payment_id) return {unmatched:true,changed:false};
      const statement=await client.query<{status:string}>(
        `SELECT status FROM finance_bank_statement
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,row.statement_id]
      );
      if(statement.rows[0]?.status!=="IMPORTED") {
        throw new ConflictException("Finalized bank statement cannot be corrected");
      }
      await client.query(
        `SELECT set_config('app.bank_unmatch_actor',$1,true),
                set_config('app.bank_unmatch_reason',$2,true)`,
        [context.membershipId,input.reason.trim()]
      );
      await client.query(
        `UPDATE finance_bank_statement_line SET payment_id=NULL
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,input.lineId]
      );
      return {unmatched:true,changed:true,previousPaymentId:row.payment_id};
    });
  }

  async bankMatchAudit(context:TenantContext,lineId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const row=await client.query(
        "SELECT 1 FROM finance_bank_statement_line WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,lineId]
      );
      if(!row.rowCount) throw new NotFoundException("Bank line not found");
      const result=await client.query(
        `SELECT id,old_payment_id,reason,actor_membership_id,changed_at
         FROM finance_bank_match_audit WHERE tenant_id=$1 AND bank_line_id=$2
         ORDER BY changed_at DESC,id DESC`,
        [context.tenantId,lineId]
      );
      return result.rows;
    });
  }

  async reconcileBankStatement(context:TenantContext,statementId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const statement=await client.query<{status:string}>(
        `SELECT status FROM finance_bank_statement
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,statementId]
      );
      if(!statement.rowCount) throw new NotFoundException("Bank statement not found");
      if(statement.rows[0]!.status==="RECONCILED") return {status:"RECONCILED",changed:false};
      if(statement.rows[0]!.status!=="IMPORTED") throw new ConflictException("Bank statement rejected");
      const result=await client.query(
        `UPDATE finance_bank_statement SET status='RECONCILED'
         WHERE tenant_id=$1 AND id=$2 RETURNING id`,
        [context.tenantId,statementId]
      );
      return {status:"RECONCILED",changed:result.rowCount===1};
    });
  }

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
      await this.lockPaymentIdempotencyKey(client, context.tenantId, input.idempotencyKey);
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        this.assertPaymentRetryMatches(existing, {
          sourceType: "FINANCE_INVOICE",
          sourceId: input.invoiceId,
          amountMinor: input.amountMinor,
          direction: "IN",
          kind: "PAYMENT",
          cashAccountId: input.cashAccountId
        });
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
      await this.lockPaymentIdempotencyKey(client, context.tenantId, input.idempotencyKey);
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        this.assertPaymentRetryMatches(existing, {
          sourceType: "SALES_ORDER",
          sourceId: input.orderId,
          amountMinor: input.amountMinor,
          direction: "IN",
          kind: "PAYMENT",
          cashAccountId: input.cashAccountId
        });
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
      await this.lockPaymentIdempotencyKey(client, context.tenantId, input.idempotencyKey);
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        this.assertPaymentRetryMatches(existing, {
          sourceType: "PURCHASE_ORDER",
          sourceId: input.purchaseOrderId,
          amountMinor: input.amountMinor,
          direction: "OUT",
          kind: "PAYMENT",
          cashAccountId: input.cashAccountId
        });
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
      await this.lockPaymentIdempotencyKey(client, context.tenantId, input.idempotencyKey);
      const existing = await this.findPaymentByKey(
        client,
        context.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        this.assertPaymentRetryMatches(existing, {
          sourceType: "SALES_ORDER",
          sourceId: input.orderId,
          amountMinor: input.amountMinor,
          direction: "OUT",
          kind: "REFUND",
          cashAccountId: input.cashAccountId
        });
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

  async budgets(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           b.id,b.name,b.currency,b.period_from,b.period_to,b.active_version_id,
           published.version_no AS published_version_no,
           published.published_at,
           draft.id AS draft_version_id,
           draft.version_no AS draft_version_no,
           b.updated_at
         FROM finance_budget b
         LEFT JOIN finance_budget_version published
           ON published.tenant_id=b.tenant_id
          AND published.id=b.active_version_id
         LEFT JOIN finance_budget_version draft
           ON draft.tenant_id=b.tenant_id
          AND draft.budget_id=b.id
          AND draft.status='DRAFT'
         WHERE b.tenant_id=$1
         ORDER BY b.period_from DESC,b.name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createBudget(
    context: TenantContext,
    input: {
      name: string;
      periodFrom: string;
      periodTo: string;
      currency?: string;
    }
  ): Promise<{ id: string; draftVersionId: string }> {
    const name = String(input.name ?? "").trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название бюджета");
    }

    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!date.test(input.periodFrom) || !date.test(input.periodTo)) {
      throw new BadRequestException("Период бюджета: YYYY-MM-DD");
    }

    const from = new Date(input.periodFrom + "T00:00:00Z");
    const to = new Date(input.periodTo + "T00:00:00Z");
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to < from ||
      to.getTime() - from.getTime() > 732 * 86400000
    ) {
      throw new BadRequestException("Некорректный период бюджета");
    }

    const currency = String(input.currency ?? "RUB").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Некорректная валюта бюджета");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const budget = await client.query<{ id: string }>(
          `INSERT INTO finance_budget(
             tenant_id,name,currency,period_from,period_to,
             created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            context.tenantId,
            name,
            currency,
            input.periodFrom,
            input.periodTo,
            context.membershipId
          ]
        );

        const budgetId = budget.rows[0]!.id;
        const version = await client.query<{ id: string }>(
          `INSERT INTO finance_budget_version(
             tenant_id,budget_id,version_no,status,created_by_membership_id
           ) VALUES ($1,$2,1,'DRAFT',$3)
           RETURNING id`,
          [context.tenantId, budgetId, context.membershipId]
        );

        return {
          id: budgetId,
          draftVersionId: version.rows[0]!.id
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        ) {
          throw new ConflictException(
            "Бюджет с таким названием и периодом уже существует"
          );
        }
        throw error;
      }
    });
  }

  async budgetCategories(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT id,name,direction,code
         FROM cash_flow_category
         WHERE tenant_id=$1
           AND status='ACTIVE'
           AND direction IN ('IN','OUT')
         ORDER BY direction,name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async setBudgetLine(
    context: TenantContext,
    budgetId: string,
    input: {
      month: string;
      categoryId: string;
      plannedMinor: string;
      note?: string;
    }
  ): Promise<{ id: string }> {
    if (!/^\d+$/.test(input.plannedMinor)) {
      throw new BadRequestException("Некорректная плановая сумма");
    }
    if (!/^\d{4}-\d{2}-01$/.test(input.month)) {
      throw new BadRequestException("Месяц должен быть первым числом YYYY-MM-01");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const budget = await client.query<{
        period_from: string;
        period_to: string;
        draft_version_id: string;
      }>(
        `SELECT
           b.period_from::text,
           b.period_to::text,
           v.id AS draft_version_id
         FROM finance_budget b
         JOIN finance_budget_version v
           ON v.tenant_id=b.tenant_id
          AND v.budget_id=b.id
          AND v.status='DRAFT'
         WHERE b.tenant_id=$1 AND b.id=$2
         FOR UPDATE OF b,v`,
        [context.tenantId, budgetId]
      );

      const row = budget.rows[0];
      if (!row) {
        throw new NotFoundException("Бюджет или его DRAFT не найден");
      }

      const periodFromMonth = row.period_from.slice(0, 7) + "-01";
      const periodToMonth = row.period_to.slice(0, 7) + "-01";
      if (input.month < periodFromMonth || input.month > periodToMonth) {
        throw new BadRequestException("Месяц вне периода бюджета");
      }

      const category = await client.query(
        `SELECT 1 FROM cash_flow_category
         WHERE tenant_id=$1
           AND id=$2
           AND status='ACTIVE'
           AND direction IN ('IN','OUT')`,
        [context.tenantId, input.categoryId]
      );
      if (!category.rowCount) {
        throw new NotFoundException("Категория денежного потока не найдена");
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO finance_budget_line(
           tenant_id,version_id,month,category_id,planned_minor,note
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (version_id,month,category_id)
         DO UPDATE SET
           planned_minor=EXCLUDED.planned_minor,
           note=EXCLUDED.note,
           updated_at=now()
         RETURNING id`,
        [
          context.tenantId,
          row.draft_version_id,
          input.month,
          input.categoryId,
          input.plannedMinor,
          input.note?.trim().slice(0, 1000) || null
        ]
      );

      return result.rows[0]!;
    });
  }

  async publishBudget(
    context: TenantContext,
    budgetId: string
  ): Promise<{
    publishedVersionId: string;
    publishedVersionNo: number;
    nextDraftVersionId: string;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const budget = await client.query<{
        active_version_id: string | null;
        draft_id: string;
        draft_no: number;
      }>(
        `SELECT
           b.active_version_id,
           v.id AS draft_id,
           v.version_no AS draft_no
         FROM finance_budget b
         JOIN finance_budget_version v
           ON v.tenant_id=b.tenant_id
          AND v.budget_id=b.id
          AND v.status='DRAFT'
         WHERE b.tenant_id=$1 AND b.id=$2
         FOR UPDATE OF b,v`,
        [context.tenantId, budgetId]
      );

      const row = budget.rows[0];
      if (!row) throw new NotFoundException("DRAFT бюджета не найден");

      const lines = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM finance_budget_line
         WHERE tenant_id=$1 AND version_id=$2`,
        [context.tenantId, row.draft_id]
      );
      if (Number(lines.rows[0]?.count ?? "0") === 0) {
        throw new BadRequestException("Нельзя опубликовать пустой бюджет");
      }

      if (row.active_version_id) {
        await client.query(
          `UPDATE finance_budget_version
           SET status='SUPERSEDED',updated_at=now()
           WHERE tenant_id=$1
             AND id=$2
             AND status='PUBLISHED'`,
          [context.tenantId, row.active_version_id]
        );
      }

      await client.query(
        `UPDATE finance_budget_version
         SET status='PUBLISHED',
             published_by_membership_id=$3,
             published_at=now(),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='DRAFT'`,
        [context.tenantId, row.draft_id, context.membershipId]
      );

      await client.query(
        `UPDATE finance_budget
         SET active_version_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, budgetId, row.draft_id]
      );

      const nextVersionNo = row.draft_no + 1;
      const next = await client.query<{ id: string }>(
        `INSERT INTO finance_budget_version(
           tenant_id,budget_id,version_no,status,created_by_membership_id
         ) VALUES ($1,$2,$3,'DRAFT',$4)
         RETURNING id`,
        [
          context.tenantId,
          budgetId,
          nextVersionNo,
          context.membershipId
        ]
      );

      await client.query(
        `INSERT INTO finance_budget_line(
           tenant_id,version_id,month,category_id,planned_minor,note
         )
         SELECT tenant_id,$3,month,category_id,planned_minor,note
         FROM finance_budget_line
         WHERE tenant_id=$1 AND version_id=$2
         ORDER BY month,category_id`,
        [context.tenantId, row.draft_id, next.rows[0]!.id]
      );

      return {
        publishedVersionId: row.draft_id,
        publishedVersionNo: row.draft_no,
        nextDraftVersionId: next.rows[0]!.id
      };
    });
  }

  async budgetComparison(
    context: TenantContext,
    budgetId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const budget = await client.query<{
        id: string;
        name: string;
        currency: string;
        period_from: string;
        period_to: string;
        version_id: string;
        version_no: number;
        version_status: string;
      }>(
        `SELECT
           b.id,b.name,b.currency,b.period_from::text,b.period_to::text,
           COALESCE(b.active_version_id,d.id) AS version_id,
           COALESCE(p.version_no,d.version_no) AS version_no,
           COALESCE(p.status,d.status) AS version_status
         FROM finance_budget b
         LEFT JOIN finance_budget_version p
           ON p.tenant_id=b.tenant_id
          AND p.id=b.active_version_id
         LEFT JOIN finance_budget_version d
           ON d.tenant_id=b.tenant_id
          AND d.budget_id=b.id
          AND d.status='DRAFT'
         WHERE b.tenant_id=$1 AND b.id=$2`,
        [context.tenantId, budgetId]
      );

      const head = budget.rows[0];
      if (!head?.version_id) {
        throw new NotFoundException("Бюджет не найден");
      }

      const planned = await client.query<{
        month: string;
        category_id: string;
        category_name: string;
        direction: string;
        planned_minor: string;
      }>(
        `SELECT
           l.month::text,l.category_id,c.name AS category_name,
           c.direction,l.planned_minor::text
         FROM finance_budget_line l
         JOIN cash_flow_category c
           ON c.tenant_id=l.tenant_id AND c.id=l.category_id
         WHERE l.tenant_id=$1 AND l.version_id=$2
         ORDER BY l.month,c.direction,c.name`,
        [context.tenantId, head.version_id]
      );

      const actual = await client.query<{
        month: string;
        category_id: string;
        category_name: string;
        direction: string;
        actual_minor: string;
      }>(
        `SELECT
           date_trunc('month',p.posted_at)::date::text AS month,
           p.category_id,
           c.name AS category_name,
           p.direction,
           COALESCE(sum(p.amount_minor),0)::text AS actual_minor
         FROM payment p
         JOIN cash_flow_category c
           ON c.tenant_id=p.tenant_id AND c.id=p.category_id
         WHERE p.tenant_id=$1
           AND p.status='POSTED'
           AND p.currency=$2
           AND p.posted_at >= $3::date
           AND p.posted_at < ($4::date + 1)
         GROUP BY date_trunc('month',p.posted_at)::date,p.category_id,c.name,p.direction
         ORDER BY month,p.direction,c.name`,
        [
          context.tenantId,
          head.currency,
          head.period_from,
          head.period_to
        ]
      );

      const map = new Map<string, {
        month: string;
        categoryId: string;
        categoryName: string;
        direction: string;
        plannedMinor: bigint;
        actualMinor: bigint;
      }>();

      for (const row of planned.rows) {
        map.set(row.month + ":" + row.category_id, {
          month: row.month,
          categoryId: row.category_id,
          categoryName: row.category_name,
          direction: row.direction,
          plannedMinor: BigInt(row.planned_minor),
          actualMinor: 0n
        });
      }

      for (const row of actual.rows) {
        const key = row.month + ":" + row.category_id;
        const existing = map.get(key);
        if (existing) {
          existing.actualMinor = BigInt(row.actual_minor);
        } else {
          map.set(key, {
            month: row.month,
            categoryId: row.category_id,
            categoryName: row.category_name,
            direction: row.direction,
            plannedMinor: 0n,
            actualMinor: BigInt(row.actual_minor)
          });
        }
      }

      const rows = Array.from(map.values())
        .sort((a,b) =>
          a.month.localeCompare(b.month) ||
          a.direction.localeCompare(b.direction) ||
          a.categoryName.localeCompare(b.categoryName)
        )
        .map((row) => ({
          month: row.month,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          direction: row.direction,
          plannedMinor: row.plannedMinor.toString(),
          actualMinor: row.actualMinor.toString(),
          varianceMinor:
            row.direction === "OUT"
              ? (row.plannedMinor - row.actualMinor).toString()
              : (row.actualMinor - row.plannedMinor).toString()
        }));

      const monthly = new Map<string, {
        plannedIn: bigint;
        actualIn: bigint;
        plannedOut: bigint;
        actualOut: bigint;
      }>();

      for (const row of rows) {
        const bucket = monthly.get(row.month) ?? {
          plannedIn: 0n,
          actualIn: 0n,
          plannedOut: 0n,
          actualOut: 0n
        };
        if (row.direction === "IN") {
          bucket.plannedIn += BigInt(row.plannedMinor);
          bucket.actualIn += BigInt(row.actualMinor);
        } else {
          bucket.plannedOut += BigInt(row.plannedMinor);
          bucket.actualOut += BigInt(row.actualMinor);
        }
        monthly.set(row.month, bucket);
      }

      return {
        budget: {
          id: head.id,
          name: head.name,
          currency: head.currency,
          periodFrom: head.period_from,
          periodTo: head.period_to,
          versionNo: head.version_no,
          versionStatus: head.version_status
        },
        rows,
        monthly: Array.from(monthly.entries())
          .sort(([a],[b]) => a.localeCompare(b))
          .map(([month,row]) => ({
            month,
            plannedInMinor: row.plannedIn.toString(),
            actualInMinor: row.actualIn.toString(),
            plannedOutMinor: row.plannedOut.toString(),
            actualOutMinor: row.actualOut.toString(),
            plannedNetMinor: (row.plannedIn-row.plannedOut).toString(),
            actualNetMinor: (row.actualIn-row.actualOut).toString()
          }))
      };
    });
  }

  async cashForecast(
    context: TenantContext,
    input: { days?: number }
  ): Promise<Record<string, unknown>> {
    const days = Math.floor(input.days ?? 30);
    if (days < 1 || days > 180) {
      throw new BadRequestException("Горизонт прогноза: от 1 до 180 дней");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const openingResult = await client.query<{ balance_minor: string }>(
        `SELECT (
           COALESCE((
             SELECT sum(opening_balance_minor)
             FROM cash_account
             WHERE tenant_id=$1
               AND status='ACTIVE'
               AND currency='RUB'
           ),0)
           +
           COALESCE((
             SELECT sum(
               CASE
                 WHEN direction='IN' THEN amount_minor
                 ELSE -amount_minor
               END
             )
             FROM payment
             WHERE tenant_id=$1
               AND status='POSTED'
               AND currency='RUB'
           ),0)
         )::text AS balance_minor`,
        [context.tenantId]
      );

      const obligationResult = await client.query<{
        id: string;
        direction: "RECEIVABLE" | "PAYABLE";
        remaining_minor: string;
        due_at: Date | null;
        source_type: string;
        source_id: string;
        party_name: string | null;
      }>(
        `SELECT
           o.id,
           o.direction,
           (o.amount_minor-o.settled_minor)::text AS remaining_minor,
           o.due_at,
           o.source_type,
           o.source_id,
           p.display_name AS party_name
         FROM financial_obligation o
         LEFT JOIN party p
           ON p.tenant_id=o.tenant_id AND p.id=o.party_id
         WHERE o.tenant_id=$1
           AND o.status IN ('OPEN','PARTIALLY_SETTLED')
           AND o.currency='RUB'
         ORDER BY o.due_at NULLS LAST,o.created_at`,
        [context.tenantId]
      );

      const today = new Date();
      const start = new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate()
      ));

      const buckets = Array.from({ length: days + 1 }, (_, offset) => ({
        date: new Date(start.getTime() + offset * 86400000)
          .toISOString()
          .slice(0,10),
        inflowMinor: 0n,
        outflowMinor: 0n,
        items: 0
      }));

      let undatedReceivable = 0n;
      let undatedPayable = 0n;
      let overdueReceivable = 0n;
      let overduePayable = 0n;
      const obligations: Array<Record<string, unknown>> = [];

      for (const row of obligationResult.rows) {
        const amount = BigInt(row.remaining_minor);
        if (amount <= 0n) continue;

        let bucketIndex: number | null = null;
        let overdue = false;

        if (row.due_at) {
          const due = new Date(Date.UTC(
            row.due_at.getUTCFullYear(),
            row.due_at.getUTCMonth(),
            row.due_at.getUTCDate()
          ));
          const diff = Math.floor(
            (due.getTime() - start.getTime()) / 86400000
          );
          overdue = diff < 0;
          bucketIndex = Math.max(0, Math.min(days, diff));
        }

        if (row.direction === "RECEIVABLE") {
          if (row.due_at === null) undatedReceivable += amount;
          else {
            buckets[bucketIndex!]!.inflowMinor += amount;
            buckets[bucketIndex!]!.items += 1;
            if (overdue) overdueReceivable += amount;
          }
        } else {
          if (row.due_at === null) undatedPayable += amount;
          else {
            buckets[bucketIndex!]!.outflowMinor += amount;
            buckets[bucketIndex!]!.items += 1;
            if (overdue) overduePayable += amount;
          }
        }

        obligations.push({
          id: row.id,
          direction: row.direction,
          remainingMinor: amount.toString(),
          dueAt: row.due_at?.toISOString() ?? null,
          overdue,
          sourceType: row.source_type,
          sourceId: row.source_id,
          partyName: row.party_name
        });
      }

      let projected = BigInt(
        openingResult.rows[0]?.balance_minor ?? "0"
      );
      let minimumBalance = projected;
      let minimumDate = buckets[0]!.date;
      let firstGapDate: string | null = projected < 0n
        ? buckets[0]!.date
        : null;

      const calendar = buckets.map((bucket) => {
        projected += bucket.inflowMinor - bucket.outflowMinor;

        if (projected < minimumBalance) {
          minimumBalance = projected;
          minimumDate = bucket.date;
        }
        if (firstGapDate === null && projected < 0n) {
          firstGapDate = bucket.date;
        }

        return {
          date: bucket.date,
          inflowMinor: bucket.inflowMinor.toString(),
          outflowMinor: bucket.outflowMinor.toString(),
          netMinor: (bucket.inflowMinor - bucket.outflowMinor).toString(),
          projectedBalanceMinor: projected.toString(),
          items: bucket.items,
          cashGap: projected < 0n
        };
      });

      return {
        currency: "RUB",
        horizonDays: days,
        generatedAt: new Date().toISOString(),
        openingBalanceMinor:
          openingResult.rows[0]?.balance_minor ?? "0",
        endingBalanceMinor: projected.toString(),
        minimumBalanceMinor: minimumBalance.toString(),
        minimumBalanceDate: minimumDate,
        firstCashGapDate: firstGapDate,
        overdueReceivableMinor: overdueReceivable.toString(),
        overduePayableMinor: overduePayable.toString(),
        undatedReceivableMinor: undatedReceivable.toString(),
        undatedPayableMinor: undatedPayable.toString(),
        calendar,
        obligations
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
        input.idempotencyKey.trim(),
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

  private async lockPaymentIdempotencyKey(
    client: PoolClient,
    tenantId: string,
    key: string
  ): Promise<void> {
    if (typeof key !== "string" || !key.trim() || key.length > 160) {
      throw new BadRequestException("Некорректный ключ идемпотентности");
    }
    // Lock the tenant+key across payment types before checking for an existing
    // payment. Concurrent retries now wait and reuse the committed record.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [tenantId, key.trim()]
    );
  }

  private assertPaymentRetryMatches(
    existing: ExistingPayment,
    expected: {
      sourceType: string;
      sourceId: string;
      amountMinor: string;
      direction: string;
      kind: string;
      cashAccountId?: string;
    }
  ): void {
    const amount = this.parsePositiveAmount(expected.amountMinor);
    if (existing.source_type !== expected.sourceType ||
        existing.source_id !== expected.sourceId ||
        existing.amount_minor !== amount.toString() ||
        existing.direction !== expected.direction ||
        existing.kind !== expected.kind ||
        (expected.cashAccountId && existing.cash_account_id !== expected.cashAccountId)) {
      throw new ConflictException(
        "Этот ключ идемпотентности уже использован для другого платежа"
      );
    }
  }

  private async findPaymentByKey(
    client: PoolClient,
    tenantId: string,
    key: string
  ): Promise<ExistingPayment | null> {
    const result = await client.query<ExistingPayment>(
      `SELECT id, business_number, source_type, source_id,
              amount_minor::text, direction, kind, cash_account_id
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
