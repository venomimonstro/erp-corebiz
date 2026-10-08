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
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.dateFrom) ||
       !/^\d{4}-\d{2}-\d{2}$/.test(input.dateTo) ||
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

  async trialBalance(context:TenantContext,legalEntityId:string,dateFrom:string,dateTo:string) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ||
       !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) ||
       dateFrom>dateTo) {
      throw new BadRequestException("Invalid reporting date range");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `WITH movements AS (
           SELECT debit_account_id AS account_id,amount_minor AS debit,0::bigint AS credit
           FROM accounting_journal_entry
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND business_date BETWEEN $3::date AND $4::date
           UNION ALL
           SELECT credit_account_id,0::bigint,amount_minor
           FROM accounting_journal_entry
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND business_date BETWEEN $3::date AND $4::date
         )
         SELECT a.id,a.code,a.name,
                coalesce(sum(m.debit),0)::text AS debit_minor,
                coalesce(sum(m.credit),0)::text AS credit_minor,
                (coalesce(sum(m.debit),0)-coalesce(sum(m.credit),0))::text AS net_debit_minor
         FROM accounting_account a
         JOIN movements m ON m.account_id=a.id
         WHERE a.tenant_id=$1
         GROUP BY a.id,a.code,a.name
         ORDER BY a.code`,
        [context.tenantId,legalEntityId,dateFrom,dateTo]
      );
      return result.rows;
    });
  }

  async periodHistory(context:TenantContext,periodId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const period=await client.query(
        "SELECT 1 FROM accounting_period WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,periodId]
      );
      if(!period.rowCount) throw new NotFoundException("Accounting period not found");
      const result=await client.query(
        `SELECT id,from_state,to_state,reason,actor_membership_id,changed_at
         FROM accounting_period_transition
         WHERE tenant_id=$1 AND period_id=$2
         ORDER BY changed_at DESC,id DESC`,
        [context.tenantId,periodId]
      );
      return result.rows;
    });
  }

  async lockPeriod(context:TenantContext,input:{
    periodId:string;targetState:"SOFT_LOCKED"|"HARD_LOCKED";reason:string;
  }) {
    if (!["SOFT_LOCKED","HARD_LOCKED"].includes(input.targetState) ||
        !input.reason?.trim() || input.reason.trim().length<8) {
      throw new BadRequestException("Period lock requires target and reason");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{id:string;state:string}>(
        `SELECT id,state FROM accounting_period
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,input.periodId]
      );
      const period=result.rows[0];
      if(!period) throw new NotFoundException("Accounting period not found");
      if(period.state===input.targetState) return {state:period.state,changed:false};
      const allowed=(period.state==="OPEN" && input.targetState==="SOFT_LOCKED") ||
        (period.state==="SOFT_LOCKED" && input.targetState==="HARD_LOCKED");
      if(!allowed) throw new ConflictException("Invalid accounting period state transition");
      await client.query(
        `UPDATE accounting_period SET state=$3 WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,input.periodId,input.targetState]
      );
      await client.query(
        `INSERT INTO accounting_period_transition(
           tenant_id,period_id,from_state,to_state,reason,actor_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [context.tenantId,input.periodId,period.state,input.targetState,
         input.reason.trim(),context.membershipId]
      );
      return {state:input.targetState,changed:true};
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
      // Serialize competing requests before the idempotency lookup.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [context.tenantId + ":accounting:" + input.postingKey.trim()]
      );
      const existing = await client.query<{id:string}>(
        "SELECT id FROM accounting_journal_entry WHERE tenant_id=$1 AND posting_key=$2",
        [context.tenantId,input.postingKey.trim()]
      );
      if (existing.rows[0]) {
        const recorded=await client.query<{
          id:string;legal_entity_id:string;period_id:string;business_date:string;
          source_type:string;source_id:string;rule_code:string;rule_version:number;
          amount_minor:string;
        }>(
          `SELECT id,legal_entity_id,period_id,business_date::text,source_type,
                  source_id,rule_code,rule_version,amount_minor::text
           FROM accounting_journal_entry WHERE tenant_id=$1 AND posting_key=$2`,
          [context.tenantId,input.postingKey.trim()]
        );
        const previous=recorded.rows[0]!;
        if (previous.legal_entity_id!==input.legalEntityId ||
            previous.period_id!==input.periodId ||
            previous.business_date!==input.businessDate ||
            previous.source_type!==input.sourceType ||
            previous.source_id!==input.sourceId ||
            previous.rule_code!==input.ruleCode ||
            previous.rule_version!==input.ruleVersion ||
            previous.amount_minor!==input.amountMinor) {
          throw new ConflictException("Posting key already used with different operation");
        }
        return {id:previous.id,created:false};
      }

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
  async reverse(context:TenantContext,input:{
    originalEntryId:string;periodId:string;businessDate:string;
    postingKey:string;ruleCode:string;ruleVersion:number;
  }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
        !input.postingKey?.trim() || !input.ruleCode?.trim() ||
        !Number.isInteger(input.ruleVersion) || input.ruleVersion<=0) {
      throw new BadRequestException("Invalid reversal request");
    }
    return this.database.withTenantTransaction(context,async client=>{
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [context.tenantId + ":accounting-reverse:" + input.originalEntryId]
      );
      const previous=await client.query<{
        id:string;legal_entity_id:string;source_type:string;source_id:string;
        debit_account_id:string;credit_account_id:string;amount_minor:string;currency:string;
      }>(
        `SELECT id,legal_entity_id,source_type,source_id,debit_account_id,
                credit_account_id,amount_minor::text,currency
         FROM accounting_journal_entry WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,input.originalEntryId]
      );
      const original=previous.rows[0];
      if (!original) throw new NotFoundException("Original posting not found");
      const existing=await client.query<{
        id:string;posting_key:string;reversal_of_id:string|null;
        period_id:string;business_date:string;rule_code:string;rule_version:number;
      }>(
        `SELECT id,posting_key,reversal_of_id,period_id,
                business_date::text,rule_code,rule_version
         FROM accounting_journal_entry
         WHERE tenant_id=$1 AND (posting_key=$2 OR reversal_of_id=$3) FOR UPDATE`,
        [context.tenantId,input.postingKey.trim(),input.originalEntryId]
      );
      if (existing.rowCount) {
        const unrelated=existing.rows.find(row =>
          row.reversal_of_id!==input.originalEntryId ||
          row.posting_key!==input.postingKey.trim() ||
          row.period_id!==input.periodId ||
          row.business_date!==input.businessDate ||
          row.rule_code!==input.ruleCode ||
          row.rule_version!==input.ruleVersion
        );
        if (unrelated) throw new ConflictException("Reversal already exists with different parameters");
        return {id:existing.rows[0]!.id,created:false};
      }
      const period=await client.query(
        `SELECT 1 FROM accounting_period WHERE tenant_id=$1 AND id=$2
         AND legal_entity_id=$3 AND state='OPEN'
         AND $4::date BETWEEN date_from AND date_to FOR UPDATE`,
        [context.tenantId,input.periodId,original.legal_entity_id,input.businessDate]
      );
      if(!period.rowCount) throw new ConflictException("Reversal period unavailable");
      const rule=await client.query<{debit_account_id:string;credit_account_id:string}>(
        `SELECT r.debit_account_id,r.credit_account_id
         FROM accounting_posting_rule r
         JOIN accounting_policy p ON p.id=r.policy_id AND p.tenant_id=r.tenant_id
         WHERE r.tenant_id=$1 AND p.legal_entity_id=$2 AND r.code=$3
         AND r.version=$4 AND r.source_type=$5 AND r.status='APPROVED'
         AND p.status='APPROVED'
         AND $6::date BETWEEN r.valid_from AND coalesce(r.valid_to,'infinity'::date)
         AND $6::date BETWEEN p.valid_from AND coalesce(p.valid_to,'infinity'::date)`,
        [context.tenantId,original.legal_entity_id,input.ruleCode,input.ruleVersion,
         original.source_type,input.businessDate]
      );
      if(rule.rows.length!==1 || rule.rows[0]!.debit_account_id!==original.credit_account_id ||
         rule.rows[0]!.credit_account_id!==original.debit_account_id) {
        throw new ConflictException("Approved reversal rule must swap debit and credit");
      }
      const inserted=await client.query<{id:string}>(
        `INSERT INTO accounting_journal_entry(
           tenant_id,legal_entity_id,period_id,business_date,source_type,source_id,
           posting_key,rule_code,rule_version,currency,debit_account_id,
           credit_account_id,amount_minor,reversal_of_id,posted_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [context.tenantId,original.legal_entity_id,input.periodId,input.businessDate,
         original.source_type,original.source_id,input.postingKey.trim(),
         input.ruleCode,input.ruleVersion,original.currency,
         original.credit_account_id,original.debit_account_id,
         original.amount_minor,input.originalEntryId,context.membershipId]
      );
      return {id:inserted.rows[0]!.id,created:true};
    });
  }

}
