import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class AccountingService {
  constructor(private readonly database: DatabaseService) {}

  async accounts(context: TenantContext) {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT id,code,name,category,active FROM accounting_account WHERE tenant_id=$1 ORDER BY code",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createAccount(context:TenantContext,input:{
    code:string;name:string;category:"ASSET"|"LIABILITY"|"EQUITY"|"INCOME"|"EXPENSE"|"OFF_BALANCE";
  }) {
    if (!input.code?.trim() || !input.name?.trim() || !["ASSET","LIABILITY","EQUITY","INCOME","EXPENSE","OFF_BALANCE"].includes(input.category)) {
      throw new BadRequestException("Invalid accounting account");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `INSERT INTO accounting_account(tenant_id,code,name,category)
         VALUES($1,$2,$3,$4) RETURNING id,code,name,category,active`,
        [context.tenantId,input.code.trim(),input.name.trim(),input.category]
      );
      return result.rows[0];
    });
  }

  async createPeriod(context:TenantContext,input:{
    legalEntityId:string;dateFrom:string;dateTo:string;
  }) {
    if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(input.dateFrom) ||
       !/^\\d{4}-\\d{2}-\\d{2}$/.test(input.dateTo) ||
       input.dateFrom>input.dateTo) {
      throw new BadRequestException("Invalid accounting period dates");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `INSERT INTO accounting_period(tenant_id,legal_entity_id,date_from,date_to)
         VALUES($1,$2,$3,$4) RETURNING id,legal_entity_id,date_from,date_to,state`,
        [context.tenantId,input.legalEntityId,input.dateFrom,input.dateTo]
      );
      return result.rows[0];
    });
  }

  async periods(context: TenantContext, legalEntityId: string) {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT id,legal_entity_id,date_from,date_to,state
         FROM accounting_period WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY date_from DESC`,
        [context.tenantId, legalEntityId]
      );
      return result.rows;
    });
  }

  async entries(context: TenantContext, legalEntityId: string) {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT id,period_id,business_date,source_type,source_id,posting_key,
                rule_code,rule_version,currency,debit_account_id,credit_account_id,
                amount_minor::text,reversal_of_id,posted_at
         FROM accounting_journal_entry
         WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY posted_at DESC,id DESC LIMIT 500`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
    });
  }

  async post(context: TenantContext, input: {
    legalEntityId: string;
    periodId: string;
    businessDate: string;
    sourceType: string;
    sourceId: string;
    postingKey: string;
    ruleCode: string;
    ruleVersion: number;
    amountMinor: string;
  }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
        !Number.isInteger(input.ruleVersion) || input.ruleVersion <= 0 ||
        !/^\d+$/.test(input.amountMinor) || BigInt(input.amountMinor) <= 0n ||
        !input.postingKey?.trim() || !input.ruleCode?.trim() ||
        !input.sourceType?.trim()) {
      throw new BadRequestException("Invalid accounting posting request");
    }
    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await client.query<{id:string}>(
        "SELECT id FROM accounting_journal_entry WHERE tenant_id=$1 AND posting_key=$2",
        [context.tenantId,input.postingKey.trim()]
      );
      if (existing.rows[0]) return {id:existing.rows[0].id,created:false};

      const period = await client.query(
        `SELECT 1 FROM accounting_period
         WHERE tenant_id=$1 AND id=$2 AND legal_entity_id=$3
           AND state='OPEN' AND $4::date BETWEEN date_from AND date_to
         FOR UPDATE`,
        [context.tenantId,input.periodId,input.legalEntityId,input.businessDate]
      );
      if (!period.rowCount) throw new ConflictException("Accounting period unavailable");

      const rule = await client.query<{debit_account_id:string;credit_account_id:string}>(
        `SELECT r.debit_account_id,r.credit_account_id
         FROM accounting_posting_rule r
         JOIN accounting_policy p ON p.id=r.policy_id AND p.tenant_id=r.tenant_id
         WHERE r.tenant_id=$1 AND p.legal_entity_id=$2
           AND r.code=$3 AND r.version=$4 AND r.source_type=$5
           AND r.status='APPROVED' AND p.status='APPROVED'
           AND $6::date BETWEEN r.valid_from AND coalesce(r.valid_to,'infinity'::date)
           AND $6::date BETWEEN p.valid_from AND coalesce(p.valid_to,'infinity'::date)`,
        [context.tenantId,input.legalEntityId,input.ruleCode,input.ruleVersion,input.sourceType,input.businessDate]
      );
      if (rule.rows.length !== 1) throw new NotFoundException("Unique approved posting rule not found");
      const row=rule.rows[0]!;
      const inserted=await client.query<{id:string}>(
        `INSERT INTO accounting_journal_entry(
          tenant_id,legal_entity_id,period_id,business_date,source_type,source_id,
          posting_key,rule_code,rule_version,currency,debit_account_id,
          credit_account_id,amount_minor,reversal_of_id,posted_by_membership_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RUB',$10,$11,$12,$13,$14)
        RETURNING id`,
        [context.tenantId,input.legalEntityId,input.periodId,input.businessDate,
         input.sourceType,input.sourceId,input.postingKey.trim(),input.ruleCode,
         input.ruleVersion,row.debit_account_id,row.credit_account_id,
         input.amountMinor,null,context.membershipId]
      );
      return {id:inserted.rows[0]!.id,created:true};
    });
  }
}
