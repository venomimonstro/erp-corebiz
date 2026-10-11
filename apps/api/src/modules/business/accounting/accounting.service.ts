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

  async monthCloseChecks(context:TenantContext,periodId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const p=await client.query("SELECT 1 FROM accounting_period WHERE tenant_id=$1 AND id=$2",[context.tenantId,periodId]);
      if(!p.rowCount) throw new NotFoundException("Period not found");
      const rows=await client.query(
        "SELECT code,status,note,checked_by_membership_id,checked_at FROM accounting_month_close_check WHERE tenant_id=$1 AND period_id=$2 ORDER BY code",
        [context.tenantId,periodId]);
      return rows.rows;
    });
  }

  async setMonthCloseCheck(context:TenantContext,input:{
    periodId:string;code:"JOURNAL"|"BANK"|"RECEIVABLES"|"PAYABLES"|"INVENTORY"|"VAT"|"PAYROLL";
    status:"PENDING"|"DONE"|"BLOCKED";note?:string;
  }) {
    const codes=["JOURNAL","BANK","RECEIVABLES","PAYABLES","INVENTORY","VAT","PAYROLL"];
    if(!input?.periodId || !codes.includes(input.code) || !["PENDING","DONE","BLOCKED"].includes(input.status))
      throw new BadRequestException("Invalid close check");
    return this.database.withTenantTransaction(context,async client=>{
      const p=await client.query("SELECT state FROM accounting_period WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId,input.periodId]);
      if(!p.rowCount) throw new NotFoundException("Period not found");
      if(p.rows[0].state!=="OPEN") throw new ConflictException("Period is locked");
      const row=await client.query(
        `INSERT INTO accounting_month_close_check(tenant_id,period_id,code,status,note,checked_by_membership_id,checked_at)
         VALUES($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT(tenant_id,period_id,code) DO UPDATE
         SET status=EXCLUDED.status,note=EXCLUDED.note,checked_by_membership_id=EXCLUDED.checked_by_membership_id,
             checked_at=EXCLUDED.checked_at
         RETURNING code,status,checked_at`,
        [context.tenantId,input.periodId,input.code,input.status,input.note??null,context.membershipId]);
      return row.rows[0];
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
        "SELECT set_config('app.accounting_period_reason',$1,true), set_config('app.accounting_period_actor',$2,true)",
        [input.reason.trim(),context.membershipId]
      );
      await client.query(
        `UPDATE accounting_period SET state=$3 WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,input.periodId,input.targetState]
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

  async taxProfile(context:TenantContext,legalEntityId:string) {
    if(!legalEntityId) throw new BadRequestException("Не выбрано юридическое лицо");
    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        "SELECT 1 FROM legal_entity WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,legalEntityId]
      );
      if(!entity.rowCount) throw new NotFoundException("Юридическое лицо не найдено");
      const result=await client.query(
        `SELECT
           id,legal_entity_id,entity_kind,tax_regime,vat_mode,has_employees,
           tax_region_code,tax_office_code,kpp,oktmo,okved_primary,
           ens_enabled,reporting_mode,risk_tolerance,
           usn_rate_bps,usn_min_rate_bps,status,
           effective_from,effective_to,updated_at
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status='ACTIVE'
           AND effective_from<=current_date
           AND (effective_to IS NULL OR effective_to>=current_date)
         ORDER BY effective_from DESC,id DESC
         LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      return result.rows[0]??null;
    });
  }

  async saveTaxProfile(context:TenantContext,input:{
    legalEntityId:string;
    entityKind:"ORGANIZATION"|"IP";
    taxRegime:"USN_INCOME"|"USN_INCOME_EXPENSE"|"OSNO"|"AUSN"|"OTHER";
    vatMode?:"NO_VAT"|"VAT_5"|"VAT_7"|"VAT_22"|"VAT_MIXED";
    hasEmployees?:boolean;
    taxRegionCode?:string;
    taxOfficeCode?:string;
    kpp?:string;
    oktmo?:string;
    okvedPrimary?:string;
    ensEnabled?:boolean;
    reportingMode?:"ASSISTED"|"SEMI_AUTOMATIC"|"EXTERNAL_ACCOUNTANT";
    riskTolerance?:"CONSERVATIVE"|"STANDARD";
    effectiveFrom?:string;
  }) {
    if(!input.legalEntityId ||
       !["ORGANIZATION","IP"].includes(input.entityKind) ||
       !["USN_INCOME","USN_INCOME_EXPENSE","OSNO","AUSN","OTHER"].includes(input.taxRegime)) {
      throw new BadRequestException("Некорректный налоговый профиль");
    }
    const effectiveFrom=input.effectiveFrom??new Date().toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      throw new BadRequestException("Некорректная дата налогового режима");
    }
    const vatMode=input.vatMode??"NO_VAT";
    const reportingMode=input.reportingMode??"ASSISTED";
    const riskTolerance=input.riskTolerance??"CONSERVATIVE";
    if(!["NO_VAT","VAT_5","VAT_7","VAT_22","VAT_MIXED"].includes(vatMode) ||
       !["ASSISTED","SEMI_AUTOMATIC","EXTERNAL_ACCOUNTANT"].includes(reportingMode) ||
       !["CONSERVATIVE","STANDARD"].includes(riskTolerance)) {
      throw new BadRequestException("Некорректные параметры налогового профиля");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        "SELECT 1 FROM legal_entity WHERE tenant_id=$1 AND id=$2 FOR SHARE",
        [context.tenantId,input.legalEntityId]
      );
      if(!entity.rowCount) throw new NotFoundException("Юридическое лицо не найдено");

      await client.query(
        `UPDATE accounting_tax_profile
         SET effective_to=$3::date-1,updated_by_membership_id=$4,updated_at=now()
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
           AND effective_from<$3::date
           AND (effective_to IS NULL OR effective_to>=$3::date)`,
        [context.tenantId,input.legalEntityId,effectiveFrom,context.membershipId]
      );

      const existing=await client.query<{id:string}>(
        `SELECT id FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND effective_from=$3::date
         FOR UPDATE`,
        [context.tenantId,input.legalEntityId,effectiveFrom]
      );

      if(existing.rows[0]){
        const updated=await client.query(
          `UPDATE accounting_tax_profile
           SET entity_kind=$4,tax_regime=$5,vat_mode=$6,has_employees=$7,
               tax_region_code=$8,tax_office_code=$9,kpp=$10,oktmo=$11,
               okved_primary=$12,ens_enabled=$13,reporting_mode=$14,
               risk_tolerance=$15,
               usn_rate_bps=$16,usn_min_rate_bps=$17,
               status='ACTIVE',effective_to=NULL,
               updated_by_membership_id=$18,updated_at=now()
           WHERE tenant_id=$1 AND legal_entity_id=$2 AND id=$3
           RETURNING *`,
          [
            context.tenantId,input.legalEntityId,existing.rows[0].id,
            input.entityKind,input.taxRegime,vatMode,Boolean(input.hasEmployees),
            input.taxRegionCode?.trim()||null,input.taxOfficeCode?.trim()||null,
            input.kpp?.trim()||null,input.oktmo?.trim()||null,
            input.okvedPrimary?.trim()||null,input.ensEnabled!==false,
            reportingMode,riskTolerance,
            input.taxRegime==="USN_INCOME"?600:
              input.taxRegime==="USN_INCOME_EXPENSE"?1500:null,
            input.taxRegime==="USN_INCOME_EXPENSE"?100:null,
            context.membershipId
          ]
        );
        return updated.rows[0];
      }

      const inserted=await client.query(
        `INSERT INTO accounting_tax_profile(
           tenant_id,legal_entity_id,entity_kind,tax_regime,vat_mode,
           has_employees,tax_region_code,tax_office_code,kpp,oktmo,
           okved_primary,ens_enabled,reporting_mode,risk_tolerance,
           usn_rate_bps,usn_min_rate_bps,
           effective_from,created_by_membership_id,updated_by_membership_id
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18
         )
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,input.entityKind,input.taxRegime,
          vatMode,Boolean(input.hasEmployees),input.taxRegionCode?.trim()||null,
          input.taxOfficeCode?.trim()||null,input.kpp?.trim()||null,
          input.oktmo?.trim()||null,input.okvedPrimary?.trim()||null,
          input.ensEnabled!==false,reportingMode,riskTolerance,
          input.taxRegime==="USN_INCOME"?600:
            input.taxRegime==="USN_INCOME_EXPENSE"?1500:null,
          input.taxRegime==="USN_INCOME_EXPENSE"?100:null,
          effectiveFrom,context.membershipId
        ]
      );
      return inserted.rows[0];
    });
  }

  async buildComplianceCalendar(
    context:TenantContext,
    legalEntityId:string,
    year:number
  ) {
    if(!Number.isSafeInteger(year)||year<2024||year>2100){
      throw new BadRequestException("Некорректный год налогового календаря");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const profileResult=await client.query<{
        id:string;
        entity_kind:"ORGANIZATION"|"IP";
        tax_regime:string;
        vat_mode:string;
        has_employees:boolean;
        compliance_enabled:boolean;
      }>(
        `SELECT id,entity_kind,tax_regime,vat_mode,has_employees,compliance_enabled
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
           AND effective_from<=make_date($3,12,31)
           AND (effective_to IS NULL OR effective_to>=make_date($3,1,1))
         ORDER BY effective_from DESC,id DESC
         LIMIT 1`,
        [context.tenantId,legalEntityId,year]
      );
      const profile=profileResult.rows[0];
      if(!profile){
        throw new ConflictException(
          "Сначала настройте налоговый профиль юридического лица"
        );
      }
      if(profile.compliance_enabled===false){
        throw new ConflictException(
          "Налоговый контур выключен для этого юридического лица"
        );
      }

      const items:Array<{
        code:string;
        title:string;
        authority:"FNS"|"SFR"|"ROSSTAT"|"OTHER";
        type:"FILE"|"PAY"|"NOTIFY"|"RECONCILE";
        due:string;
        periodKey:string;
        formCode?:string;
        sourceUrl:string;
      }>=[];

      const push=(item:(typeof items)[number])=>items.push(item);
      const iso=(month:number,day:number)=>{
        const d=new Date(Date.UTC(year,month-1,day,12,0,0));
        return d.toISOString();
      };
      const nextMonthIso=(month:number,day:number)=>{
        const d=new Date(Date.UTC(year,month,day,12,0,0));
        return d.toISOString();
      };
      const ens="https://www.nalog.gov.ru/rn23/ens/";
      const usn="https://www.nalog.gov.ru/rn77/yul/organization_pays_taxes/simplified_system/";

      if(profile.tax_regime.startsWith("USN_")){
        if(profile.entity_kind==="ORGANIZATION"){
          push({
            code:"USN_ANNUAL_DECLARATION_ORG",
            title:"Декларация по УСН за "+String(year-1),
            authority:"FNS",type:"FILE",due:iso(3,25),
            periodKey:String(year-1),formCode:"USN_DECLARATION",sourceUrl:usn
          });
          push({
            code:"USN_ANNUAL_PAYMENT_ORG",
            title:"Доплатить налог по УСН за "+String(year-1),
            authority:"FNS",type:"PAY",due:iso(3,28),
            periodKey:String(year-1),sourceUrl:usn
          });
        }else{
          push({
            code:"USN_ANNUAL_DECLARATION_IP",
            title:"Декларация по УСН за "+String(year-1),
            authority:"FNS",type:"FILE",due:iso(4,25),
            periodKey:String(year-1),formCode:"USN_DECLARATION",sourceUrl:usn
          });
          push({
            code:"USN_ANNUAL_PAYMENT_IP",
            title:"Доплатить налог по УСН за "+String(year-1),
            authority:"FNS",type:"PAY",due:iso(4,28),
            periodKey:String(year-1),sourceUrl:usn
          });
        }

        for(const period of [
          {month:4,key:"Q1",label:"1 квартал"},
          {month:7,key:"H1",label:"полугодие"},
          {month:10,key:"9M",label:"9 месяцев"}
        ]){
          push({
            code:"USN_ADVANCE_NOTIFICATION",
            title:"Уведомление по авансу УСН за "+period.label,
            authority:"FNS",type:"NOTIFY",due:iso(period.month,25),
            periodKey:year+"-"+period.key,
            formCode:"KND_1110355",sourceUrl:ens
          });
          push({
            code:"USN_ADVANCE_PAYMENT",
            title:"Авансовый платёж УСН за "+period.label,
            authority:"FNS",type:"PAY",due:iso(period.month,28),
            periodKey:year+"-"+period.key,sourceUrl:ens
          });
        }
      }

      if(profile.vat_mode!=="NO_VAT"){
        for(const quarter of [1,2,3,4]){
          const month=quarter*3+1;
          const dueYear=month>12?year+1:year;
          const dueMonth=month>12?1:month;
          const d=new Date(Date.UTC(dueYear,dueMonth-1,25,12,0,0));
          push({
            code:"VAT_DECLARATION",
            title:"Декларация по НДС за "+quarter+" квартал",
            authority:"FNS",type:"FILE",due:d.toISOString(),
            periodKey:year+"-Q"+quarter,formCode:"VAT_DECLARATION",
            sourceUrl:"https://www.nalog.gov.ru/"
          });
        }
      }

      if(profile.has_employees){
        for(let month=1;month<=12;month++){
          const mm=String(month).padStart(2,"0");
          push({
            code:"NDFL_1_22_NOTIFICATION",
            title:"Уведомление по НДФЛ за 1–22 "+mm,
            authority:"FNS",type:"NOTIFY",due:iso(month,25),
            periodKey:year+"-"+mm+"-01-22",formCode:"KND_1110355",sourceUrl:ens
          });
          push({
            code:"NDFL_1_22_PAYMENT",
            title:"Уплатить НДФЛ за 1–22 "+mm,
            authority:"FNS",type:"PAY",due:iso(month,28),
            periodKey:year+"-"+mm+"-01-22",sourceUrl:ens
          });
          if(month<12){
            push({
              code:"NDFL_23_EOM_NOTIFICATION",
              title:"Уведомление по НДФЛ за 23–конец "+mm,
              authority:"FNS",type:"NOTIFY",due:nextMonthIso(month,3),
              periodKey:year+"-"+mm+"-23-EOM",formCode:"KND_1110355",sourceUrl:ens
            });
            push({
              code:"NDFL_23_EOM_PAYMENT",
              title:"Уплатить НДФЛ за 23–конец "+mm,
              authority:"FNS",type:"PAY",due:nextMonthIso(month,5),
              periodKey:year+"-"+mm+"-23-EOM",sourceUrl:ens
            });
          }
          push({
            code:"INSURANCE_NOTIFICATION",
            title:"Уведомление по страховым взносам за "+mm,
            authority:"FNS",type:"NOTIFY",due:nextMonthIso(month,25),
            periodKey:year+"-"+mm,formCode:"KND_1110355",sourceUrl:ens
          });
          push({
            code:"INSURANCE_PAYMENT",
            title:"Уплатить страховые взносы за "+mm,
            authority:"FNS",type:"PAY",due:nextMonthIso(month,28),
            periodKey:year+"-"+mm,sourceUrl:ens
          });
        }
      }

      let created=0;
      for(const item of items){
        const rule=await client.query<{id:string}>(
          `SELECT id FROM accounting_regulatory_rule
           WHERE code=$1 AND status='ACTIVE'
             AND effective_from<=$2::date
             AND (effective_to IS NULL OR effective_to>=$2::date)
           ORDER BY version DESC LIMIT 1`,
          [item.code,item.due.slice(0,10)]
        );
        const inserted=await client.query(
          `INSERT INTO accounting_compliance_obligation(
             tenant_id,legal_entity_id,tax_profile_id,rule_id,
             authority,obligation_type,code,title,period_key,due_at,
             form_code,source_url,source_effective_at,
             calculation_status,workflow_status,source_snapshot
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),
             'REVIEW_REQUIRED','PLANNED',$13
           )
           ON CONFLICT(tenant_id,legal_entity_id,code,period_key) DO NOTHING
           RETURNING id`,
          [
            context.tenantId,legalEntityId,profile.id,rule.rows[0]?.id??null,
            item.authority,item.type,item.code,item.title,item.periodKey,
            item.due,item.formCode??null,item.sourceUrl,
            JSON.stringify({
              generatedBy:"COREBIZ_REGULATORY_CALENDAR",
              generatedAt:new Date().toISOString(),
              year,
              note:
                "Срок создан по нормативному правилу. Перед отправкой система должна сверить переносы выходных/праздников и актуальную редакцию формы."
            })
          ]
        );
        if(inserted.rowCount) created++;
      }

      return {created,total:items.length,profileId:profile.id};
    });
  }

  async complianceOverview(
    context:TenantContext,
    legalEntityId:string,
    from?:string,
    to?:string
  ) {
    const dateFrom=from&&/^\d{4}-\d{2}-\d{2}$/.test(from)
      ?from
      :new Date().toISOString().slice(0,10);
    const defaultTo=new Date(Date.now()+120*86400000).toISOString().slice(0,10);
    const dateTo=to&&/^\d{4}-\d{2}-\d{2}$/.test(to)?to:defaultTo;

    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query(
        `SELECT
           id,entity_kind,tax_regime,vat_mode,has_employees,ens_enabled,
           reporting_mode,risk_tolerance,kpp,oktmo,tax_office_code,
           effective_from,effective_to
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
           AND effective_from<=current_date
           AND (effective_to IS NULL OR effective_to>=current_date)
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,legalEntityId]
      );

      const obligations=await client.query(
        `SELECT
           o.id,o.authority,o.obligation_type,o.code,o.title,o.period_key,
           o.due_at,o.amount_minor::text,o.currency,o.calculation_status,
           o.workflow_status,o.form_code,o.source_url,o.review_note,
           o.external_provider,o.external_reference,o.rejection_reason,
           o.packet_id,
           p.validation_status AS packet_validation_status,
           p.signature_status AS packet_signature_status,
           CASE
             WHEN o.workflow_status IN ('ACCEPTED','PAID','CANCELLED') THEN 'DONE'
             WHEN o.due_at<now() THEN 'OVERDUE'
             WHEN o.due_at<now()+interval '7 days' THEN 'URGENT'
             WHEN o.due_at<now()+interval '30 days' THEN 'UPCOMING'
             ELSE 'LATER'
           END AS urgency
         FROM accounting_compliance_obligation o
         LEFT JOIN accounting_compliance_packet p
           ON p.tenant_id=o.tenant_id AND p.id=o.packet_id
         WHERE o.tenant_id=$1
           AND o.legal_entity_id=$2
           AND o.due_at >= $3::date
           AND o.due_at < $4::date + interval '1 day'
         ORDER BY
           CASE
             WHEN o.workflow_status IN ('ACCEPTED','PAID','CANCELLED') THEN 1
             ELSE 0
           END,
           o.due_at,o.id`,
        [context.tenantId,legalEntityId,dateFrom,dateTo]
      );

      const connectors=await client.query(
        `SELECT
           id,provider,status,supports_filing,supports_receipts,
           certificate_valid_to,last_verified_at,last_error
         FROM accounting_reporting_connector
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status<>'DISABLED'
         ORDER BY provider`,
        [context.tenantId,legalEntityId]
      );

      const counts=obligations.rows.reduce<Record<string,number>>(
        (acc,row:any)=>{
          acc.total=(acc.total??0)+1;
          acc[row.urgency]=(acc[row.urgency]??0)+1;
          return acc;
        },{}
      );

      return {
        profile:profile.rows[0]??null,
        counts,
        obligations:obligations.rows,
        connectors:connectors.rows
      };
    });
  }

  async prepareCompliancePacket(
    context:TenantContext,
    obligationId:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const obligation=await client.query<{
        id:string;
        legal_entity_id:string;
        tax_profile_id:string;
        obligation_type:string;
        code:string;
        title:string;
        period_key:string;
        due_at:Date;
        form_code:string|null;
        source_url:string|null;
        workflow_status:string;
      }>(
        `SELECT
           id,legal_entity_id,tax_profile_id,obligation_type,code,title,
           period_key,due_at,form_code,source_url,workflow_status
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,obligationId]
      );
      const o=obligation.rows[0];
      if(!o) throw new NotFoundException("Налоговая задача не найдена");
      if(["ACCEPTED","PAID","CANCELLED"].includes(o.workflow_status)){
        throw new ConflictException("Завершённую налоговую задачу нельзя пересобрать");
      }

      const profile=await client.query(
        `SELECT
           entity_kind,tax_regime,vat_mode,kpp,oktmo,tax_office_code,
           tax_region_code,ens_enabled
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,o.tax_profile_id]
      );
      const entity=await client.query(
        `SELECT id,name,inn
         FROM legal_entity
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,o.legal_entity_id]
      );

      const packetKind=
        o.obligation_type==="PAY"?"PAYMENT_INSTRUCTION":
        o.form_code==="KND_1110355"?"FNS_NOTIFICATION":
        o.obligation_type==="FILE"?"FNS_DECLARATION":"OTHER";

      const missing:string[]=[];
      const p:any=profile.rows[0]??{};
      const e:any=entity.rows[0]??{};
      if(!e.inn) missing.push("ИНН");
      if(o.form_code==="KND_1110355"){
        if(p.entity_kind==="ORGANIZATION"&&!p.kpp) missing.push("КПП");
        if(!p.oktmo) missing.push("ОКТМО");
        missing.push("КБК и подтверждённая сумма для строки уведомления");
      }

      const payload={
        schema:"corebiz.accounting.compliance.packet.v1",
        generatedAt:new Date().toISOString(),
        legalEntity:{id:e.id,name:e.name,inn:e.inn??null},
        taxProfile:p,
        obligation:{
          id:o.id,code:o.code,title:o.title,periodKey:o.period_key,
          dueAt:o.due_at,formCode:o.form_code,sourceUrl:o.source_url
        },
        requiredBeforeSubmission:missing
      };

      const validationStatus=
        missing.length?"REVIEW_REQUIRED":"VALID";
      const signatureStatus=
        o.obligation_type==="FILE"||o.obligation_type==="NOTIFY"
          ?"SIGNATURE_REQUIRED"
          :"UNSIGNED";

      const packet=await client.query<{id:string}>(
        `INSERT INTO accounting_compliance_packet(
           tenant_id,legal_entity_id,obligation_id,packet_kind,format,
           form_code,schema_version,payload,validation_status,
           validation_errors,signature_status,created_by_membership_id
         ) VALUES(
           $1,$2,$3,$4,'JSON',$5,'1',$6,$7,$8,$9,$10
         )
         ON CONFLICT(tenant_id,obligation_id,packet_kind)
         DO UPDATE SET
           payload=EXCLUDED.payload,
           validation_status=EXCLUDED.validation_status,
           validation_errors=EXCLUDED.validation_errors,
           signature_status=CASE
             WHEN accounting_compliance_packet.signature_status='SIGNED'
               THEN accounting_compliance_packet.signature_status
             ELSE EXCLUDED.signature_status
           END,
           updated_at=now()
         RETURNING id`,
        [
          context.tenantId,o.legal_entity_id,o.id,packetKind,o.form_code,
          JSON.stringify(payload),validationStatus,JSON.stringify(missing),
          signatureStatus,context.membershipId
        ]
      );

      await client.query(
        `UPDATE accounting_compliance_obligation
         SET packet_id=$3,
             calculation_status=CASE
               WHEN $4::text='VALID' THEN 'CALCULATED'
               ELSE 'REVIEW_REQUIRED'
             END,
             workflow_status=CASE
               WHEN workflow_status='PLANNED' THEN 'READY'
               ELSE workflow_status
             END,
             review_note=CASE
               WHEN cardinality($5::text[])>0
                 THEN array_to_string($5::text[],'; ')
               ELSE NULL
             END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,o.id,packet.rows[0]!.id,validationStatus,missing]
      );

      await client.query(
        `INSERT INTO accounting_compliance_event(
           tenant_id,obligation_id,event_type,actor_membership_id,payload
         ) VALUES($1,$2,'PACKET_PREPARED',$3,$4)`,
        [
          context.tenantId,o.id,context.membershipId,
          JSON.stringify({packetId:packet.rows[0]!.id,validationStatus,missing})
        ]
      );

      return {
        packetId:packet.rows[0]!.id,
        validationStatus,
        signatureStatus,
        missing,
        payload
      };
    });
  }

  async complianceTransition(context:TenantContext,input:{
    obligationId:string;
    action:"APPROVE"|"SUBMIT"|"ACCEPT"|"REJECT"|"MARK_PAID"|"REOPEN";
    externalProvider?:string;
    externalReference?:string;
    rejectionReason?:string;
    note?:string;
  }) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{
        id:string;
        workflow_status:string;
        obligation_type:string;
        packet_id:string|null;
      }>(
        `SELECT id,workflow_status,obligation_type,packet_id
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,input.obligationId]
      );
      const row=result.rows[0];
      if(!row) throw new NotFoundException("Налоговая задача не найдена");

      let next=row.workflow_status;
      if(input.action==="APPROVE"){
        if(row.workflow_status!=="READY") {
          throw new ConflictException("Сначала подготовьте и проверьте пакет");
        }
        if(row.packet_id){
          const packet=await client.query<{validation_status:string}>(
            `SELECT validation_status
             FROM accounting_compliance_packet
             WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId,row.packet_id]
          );
          if(packet.rows[0]?.validation_status!=="VALID"){
            throw new ConflictException(
              "Пакет требует проверки: заполните обязательные реквизиты и суммы"
            );
          }
        }
        next="APPROVED";
      } else if(input.action==="SUBMIT"){
        if(row.workflow_status!=="APPROVED"){
          throw new ConflictException("Перед отправкой задача должна быть утверждена");
        }
        if(!input.externalProvider?.trim()||!input.externalReference?.trim()){
          throw new BadRequestException(
            "Для отправки нужен провайдер и внешний идентификатор/квитанция"
          );
        }
        next="SUBMITTED";
      } else if(input.action==="ACCEPT"){
        if(row.workflow_status!=="SUBMITTED"){
          throw new ConflictException("Принять можно только отправленный документ");
        }
        next="ACCEPTED";
      } else if(input.action==="REJECT"){
        if(row.workflow_status!=="SUBMITTED"||!input.rejectionReason?.trim()){
          throw new BadRequestException("Для отказа требуется причина ФНС/оператора");
        }
        next="REJECTED";
      } else if(input.action==="MARK_PAID"){
        if(!["APPROVED","SUBMITTED"].includes(row.workflow_status) ||
           row.obligation_type!=="PAY"){
          throw new ConflictException("Эту задачу нельзя отметить оплаченной");
        }
        next="PAID";
      } else if(input.action==="REOPEN"){
        if(row.workflow_status!=="REJECTED"){
          throw new ConflictException("Повторная подготовка доступна после отказа");
        }
        next="READY";
      } else {
        throw new BadRequestException("Неизвестное действие налогового workflow");
      }

      const approved=["APPROVED","SUBMITTED","ACCEPTED","PAID"].includes(next);
      const updated=await client.query(
        `UPDATE accounting_compliance_obligation
         SET workflow_status=$3,
             approved_by_membership_id=CASE
               WHEN $4 THEN coalesce(approved_by_membership_id,$5::uuid)
               ELSE approved_by_membership_id
             END,
             approved_at=CASE
               WHEN $4 THEN coalesce(approved_at,now())
               ELSE approved_at
             END,
             external_provider=coalesce($6,external_provider),
             external_reference=coalesce($7,external_reference),
             rejection_reason=CASE
               WHEN $3='REJECTED' THEN $8
               WHEN $3='READY' THEN NULL
               ELSE rejection_reason
             END,
             completed_at=CASE
               WHEN $3 IN ('ACCEPTED','PAID') THEN now()
               ELSE completed_at
             END,
             review_note=coalesce($9,review_note),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,workflow_status,completed_at`,
        [
          context.tenantId,row.id,next,approved,context.membershipId,
          input.externalProvider?.trim()||null,
          input.externalReference?.trim()||null,
          input.rejectionReason?.trim()||null,input.note?.trim()||null
        ]
      );

      await client.query(
        `INSERT INTO accounting_compliance_event(
           tenant_id,obligation_id,event_type,actor_membership_id,
           previous_status,new_status,payload
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          context.tenantId,row.id,input.action,context.membershipId,
          row.workflow_status,next,
          JSON.stringify({
            provider:input.externalProvider??null,
            externalReference:input.externalReference??null,
            note:input.note??null
          })
        ]
      );

      if(input.action==="ACCEPT"||input.action==="REJECT"){
        await client.query(
          `INSERT INTO accounting_compliance_receipt(
             tenant_id,obligation_id,provider,external_reference,receipt_type,payload
           ) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [
            context.tenantId,row.id,
            input.externalProvider?.trim()||"MANUAL",
            input.externalReference?.trim()||("manual:"+row.id+":"+next),
            input.action==="ACCEPT"?"ACCEPTED":"REJECTED",
            JSON.stringify({reason:input.rejectionReason??null})
          ]
        );
      }

      return updated.rows[0];
    });
  }

  async taxCategories(context:TenantContext) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT id,name,direction,code,tax_treatment,status
         FROM cash_flow_category
         WHERE tenant_id=$1 AND status='ACTIVE'
         ORDER BY name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async setTaxCategoryTreatment(context:TenantContext,input:{
    categoryId:string;
    treatment:
      "TAXABLE_INCOME"|"INCOME_REVERSAL"|"DEDUCTIBLE_EXPENSE"|
      "EXPENSE_REVERSAL"|"NON_TAXABLE"|"NON_DEDUCTIBLE"|"REVIEW";
  }) {
    const allowed=[
      "TAXABLE_INCOME","INCOME_REVERSAL","DEDUCTIBLE_EXPENSE",
      "EXPENSE_REVERSAL","NON_TAXABLE","NON_DEDUCTIBLE","REVIEW"
    ];
    if(!input.categoryId||!allowed.includes(input.treatment)){
      throw new BadRequestException("Некорректная налоговая классификация");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE cash_flow_category
         SET tax_treatment=$3
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
         RETURNING id,name,direction,code,tax_treatment`,
        [context.tenantId,input.categoryId,input.treatment]
      );
      if(!result.rowCount) throw new NotFoundException("Категория не найдена");
      return result.rows[0];
    });
  }

  async taxCashBasisEstimate(context:TenantContext,input:{
    legalEntityId:string;
    dateFrom:string;
    dateTo:string;
  }) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.dateFrom)||
       !/^\d{4}-\d{2}-\d{2}$/.test(input.dateTo)||
       input.dateFrom>input.dateTo){
      throw new BadRequestException("Некорректный период расчёта");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query<{
        tax_regime:string;
        usn_rate_bps:number|null;
        usn_min_rate_bps:number|null;
      }>(
        `SELECT tax_regime,usn_rate_bps,usn_min_rate_bps
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status='ACTIVE'
           AND effective_from<=$4::date
           AND (effective_to IS NULL OR effective_to>=$3::date)
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,input.legalEntityId,input.dateFrom,input.dateTo]
      );
      const p=profile.rows[0];
      if(!p) throw new ConflictException("Налоговый профиль не настроен");
      if(!p.tax_regime.startsWith("USN_")){
        throw new ConflictException(
          "Кассовый расчёт сейчас реализован для УСН"
        );
      }

      const dimensions=await client.query<{
        undimensioned_accounts:number;
        unclassified_count:number;
        unclassified_minor:string;
        taxable_income_minor:string;
        income_reversal_minor:string;
        deductible_expense_minor:string;
        expense_reversal_minor:string;
      }>(
        `SELECT
           (
             SELECT count(*)::integer
             FROM cash_account a
             WHERE a.tenant_id=$1
               AND a.status='ACTIVE'
               AND a.legal_entity_id IS NULL
           ) AS undimensioned_accounts,
           count(*) FILTER (
             WHERE p.category_id IS NULL OR c.tax_treatment='REVIEW'
           )::integer AS unclassified_count,
           coalesce(sum(p.amount_minor) FILTER (
             WHERE p.category_id IS NULL OR c.tax_treatment='REVIEW'
           ),0)::text AS unclassified_minor,
           coalesce(sum(p.amount_minor) FILTER (
             WHERE p.direction='IN' AND c.tax_treatment='TAXABLE_INCOME'
           ),0)::text AS taxable_income_minor,
           coalesce(sum(p.amount_minor) FILTER (
             WHERE p.direction='OUT' AND c.tax_treatment='INCOME_REVERSAL'
           ),0)::text AS income_reversal_minor,
           coalesce(sum(p.amount_minor) FILTER (
             WHERE p.direction='OUT' AND c.tax_treatment='DEDUCTIBLE_EXPENSE'
           ),0)::text AS deductible_expense_minor,
           coalesce(sum(p.amount_minor) FILTER (
             WHERE p.direction='IN' AND c.tax_treatment='EXPENSE_REVERSAL'
           ),0)::text AS expense_reversal_minor
         FROM payment p
         JOIN cash_account a
           ON a.tenant_id=p.tenant_id AND a.id=p.cash_account_id
         LEFT JOIN cash_flow_category c
           ON c.tenant_id=p.tenant_id AND c.id=p.category_id
         WHERE p.tenant_id=$1
           AND a.legal_entity_id=$2
           AND p.status='POSTED'
           AND p.posted_at::date BETWEEN $3::date AND $4::date`,
        [context.tenantId,input.legalEntityId,input.dateFrom,input.dateTo]
      );
      const row=dimensions.rows[0]!;
      const income=
        BigInt(row.taxable_income_minor)-BigInt(row.income_reversal_minor);
      const expenses=
        BigInt(row.deductible_expense_minor)-BigInt(row.expense_reversal_minor);
      const normalizedIncome=income>0n?income:0n;
      const normalizedExpenses=expenses>0n?expenses:0n;
      const rate=BigInt(p.usn_rate_bps??(
        p.tax_regime==="USN_INCOME"?600:1500
      ));
      const minRate=BigInt(p.usn_min_rate_bps??100);

      const base=
        p.tax_regime==="USN_INCOME"
          ?normalizedIncome
          :normalizedIncome>normalizedExpenses
            ?normalizedIncome-normalizedExpenses
            :0n;
      const calculated=(base*rate+9999n)/10000n;
      const minimumTax=(normalizedIncome*minRate+9999n)/10000n;

      const warnings:string[]=[];
      if(row.undimensioned_accounts>0){
        warnings.push(
          "Есть денежные счета без привязки к юрлицу: "+row.undimensioned_accounts
        );
      }
      if(row.unclassified_count>0){
        warnings.push(
          "Есть платежи без подтверждённой налоговой классификации: "+
          row.unclassified_count
        );
      }
      if(p.tax_regime==="USN_INCOME"){
        warnings.push(
          "Уменьшение налога на страховые взносы и специальные льготы пока не применены автоматически."
        );
      }else{
        warnings.push(
          "Принимаемость расходов по УСН Доходы минус расходы требует первички и проверки условий НК РФ."
        );
      }

      return {
        legalEntityId:input.legalEntityId,
        dateFrom:input.dateFrom,
        dateTo:input.dateTo,
        taxRegime:p.tax_regime,
        rateBps:Number(rate),
        minimumRateBps:Number(minRate),
        taxableIncomeMinor:normalizedIncome.toString(),
        deductibleExpenseMinor:normalizedExpenses.toString(),
        taxBaseMinor:base.toString(),
        calculatedTaxMinor:calculated.toString(),
        minimumTaxMinor:minimumTax.toString(),
        unclassifiedCount:row.unclassified_count,
        unclassifiedMinor:row.unclassified_minor,
        undimensionedAccounts:row.undimensioned_accounts,
        reviewRequired:true,
        warnings
      };
    });
  }

  async calculateUsnObligation(
    context:TenantContext,
    obligationId:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const obligation=await client.query<{
        id:string;
        legal_entity_id:string;
        code:string;
        period_key:string;
        due_at:Date;
      }>(
        `SELECT id,legal_entity_id,code,period_key,due_at
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
           AND code IN ('USN_ADVANCE_PAYMENT','USN_ANNUAL_PAYMENT_ORG','USN_ANNUAL_PAYMENT_IP')
         FOR UPDATE`,
        [context.tenantId,obligationId]
      );
      const o=obligation.rows[0];
      if(!o) throw new NotFoundException("Задача расчёта УСН не найдена");

      let year:number;
      let dateFrom:string;
      let dateTo:string;
      const annual=/^\d{4}$/.exec(o.period_key);
      const cumulative=/^(\d{4})-(Q1|H1|9M)$/.exec(o.period_key);
      if(annual){
        year=Number(annual[0]);
        dateFrom=year+"-01-01";
        dateTo=year+"-12-31";
      }else if(cumulative){
        year=Number(cumulative[1]);
        dateFrom=year+"-01-01";
        dateTo=
          cumulative[2]==="Q1"?year+"-03-31":
          cumulative[2]==="H1"?year+"-06-30":
          year+"-09-30";
      }else{
        throw new ConflictException("Неизвестный период расчёта УСН");
      }

      const profile=await client.query<{
        tax_regime:string;
        usn_rate_bps:number|null;
        usn_min_rate_bps:number|null;
      }>(
        `SELECT tax_regime,usn_rate_bps,usn_min_rate_bps
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status='ACTIVE'
           AND effective_from<=$4::date
           AND (effective_to IS NULL OR effective_to>=$3::date)
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,o.legal_entity_id,dateFrom,dateTo]
      );
      const p=profile.rows[0];
      if(!p||!p.tax_regime.startsWith("USN_")){
        throw new ConflictException("Для задачи не найден профиль УСН");
      }

      const sums=await client.query<{
        unclassified_count:number;
        taxable_income_minor:string;
        income_reversal_minor:string;
        deductible_expense_minor:string;
        expense_reversal_minor:string;
      }>(
        `SELECT
           count(*) FILTER(
             WHERE pay.category_id IS NULL OR c.tax_treatment='REVIEW'
           )::integer AS unclassified_count,
           coalesce(sum(pay.amount_minor) FILTER(
             WHERE pay.direction='IN' AND c.tax_treatment='TAXABLE_INCOME'
           ),0)::text AS taxable_income_minor,
           coalesce(sum(pay.amount_minor) FILTER(
             WHERE pay.direction='OUT' AND c.tax_treatment='INCOME_REVERSAL'
           ),0)::text AS income_reversal_minor,
           coalesce(sum(pay.amount_minor) FILTER(
             WHERE pay.direction='OUT' AND c.tax_treatment='DEDUCTIBLE_EXPENSE'
           ),0)::text AS deductible_expense_minor,
           coalesce(sum(pay.amount_minor) FILTER(
             WHERE pay.direction='IN' AND c.tax_treatment='EXPENSE_REVERSAL'
           ),0)::text AS expense_reversal_minor
         FROM payment pay
         JOIN cash_account a
           ON a.tenant_id=pay.tenant_id AND a.id=pay.cash_account_id
         LEFT JOIN cash_flow_category c
           ON c.tenant_id=pay.tenant_id AND c.id=pay.category_id
         WHERE pay.tenant_id=$1
           AND a.legal_entity_id=$2
           AND pay.status='POSTED'
           AND pay.posted_at::date BETWEEN $3::date AND $4::date`,
        [context.tenantId,o.legal_entity_id,dateFrom,dateTo]
      );
      const row=sums.rows[0]!;
      const incomeRaw=
        BigInt(row.taxable_income_minor)-BigInt(row.income_reversal_minor);
      const expenseRaw=
        BigInt(row.deductible_expense_minor)-BigInt(row.expense_reversal_minor);
      const income=incomeRaw>0n?incomeRaw:0n;
      const expenses=expenseRaw>0n?expenseRaw:0n;
      const base=p.tax_regime==="USN_INCOME"
        ?income
        :income>expenses?income-expenses:0n;
      const rate=BigInt(p.usn_rate_bps??(
        p.tax_regime==="USN_INCOME"?600:1500
      ));
      let gross=(base*rate+9999n)/10000n;

      if(annual&&p.tax_regime==="USN_INCOME_EXPENSE"){
        const minRate=BigInt(p.usn_min_rate_bps??100);
        const minimum=(income*minRate+9999n)/10000n;
        if(minimum>gross) gross=minimum;
      }

      const prior=await client.query<{amount_minor:string}>(
        `SELECT coalesce(sum(amount_minor),0)::text AS amount_minor
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1
           AND legal_entity_id=$2
           AND code='USN_ADVANCE_PAYMENT'
           AND amount_minor IS NOT NULL
           AND due_at<$3
           AND extract(year FROM due_at)=$4`,
        [context.tenantId,o.legal_entity_id,o.due_at,year]
      );
      const priorAmount=BigInt(prior.rows[0]?.amount_minor??"0");
      const estimatedDue=gross>priorAmount?gross-priorAmount:0n;

      const warnings:string[]=[];
      if(row.unclassified_count>0){
        warnings.push("Есть неклассифицированные платежи: "+row.unclassified_count);
      }
      if(p.tax_regime==="USN_INCOME"){
        warnings.push("Не применено автоматическое уменьшение УСН на страховые взносы.");
      }
      if(p.tax_regime==="USN_INCOME_EXPENSE"){
        warnings.push("Расходы должны быть подтверждены первичными документами и соответствовать условиям признания.");
      }

      const snapshot={
        engine:"COREBIZ_USN_CASH_BASIS_V1",
        calculatedAt:new Date().toISOString(),
        dateFrom,dateTo,taxRegime:p.tax_regime,
        taxableIncomeMinor:income.toString(),
        deductibleExpenseMinor:expenses.toString(),
        taxBaseMinor:base.toString(),
        grossTaxMinor:gross.toString(),
        priorAdvanceMinor:priorAmount.toString(),
        estimatedDueMinor:estimatedDue.toString(),
        warnings
      };

      const updated=await client.query(
        `UPDATE accounting_compliance_obligation
         SET amount_minor=$3,
             calculation_status='REVIEW_REQUIRED',
             calculation_snapshot=$4,
             review_note=$5,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,amount_minor::text,calculation_status,calculation_snapshot`,
        [
          context.tenantId,o.id,estimatedDue.toString(),
          JSON.stringify(snapshot),
          warnings.length?warnings.join(" "):"Требуется подтверждение владельцем."
        ]
      );

      await client.query(
        `INSERT INTO accounting_compliance_event(
           tenant_id,obligation_id,event_type,actor_membership_id,payload
         ) VALUES($1,$2,'USN_DRAFT_CALCULATED',$3,$4)`,
        [context.tenantId,o.id,context.membershipId,JSON.stringify(snapshot)]
      );

      return updated.rows[0];
    });
  }

  async confirmComplianceAmount(context:TenantContext,input:{
    obligationId:string;
    amountMinor:string;
    note:string;
  }) {
    if(!/^\d+$/.test(input.amountMinor)||!input.note?.trim()||
       input.note.trim().length<5){
      throw new BadRequestException(
        "Для подтверждения нужна сумма и комментарий"
      );
    }
    return this.database.withTenantTransaction(context,async client=>{
      const current=await client.query<{
        workflow_status:string;
        calculation_snapshot:any;
      }>(
        `SELECT workflow_status,calculation_snapshot
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,input.obligationId]
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException("Налоговая задача не найдена");
      if(!["PLANNED","READY","REJECTED"].includes(row.workflow_status)){
        throw new ConflictException(
          "Сумму нельзя менять после утверждения/отправки"
        );
      }
      const snapshot={
        ...(row.calculation_snapshot??{}),
        confirmedAmountMinor:input.amountMinor,
        confirmedAt:new Date().toISOString(),
        confirmationNote:input.note.trim(),
        confirmedByMembershipId:context.membershipId
      };
      const updated=await client.query(
        `UPDATE accounting_compliance_obligation
         SET amount_minor=$3,calculation_status='CONFIRMED',
             calculation_snapshot=$4,review_note=$5,
             workflow_status=CASE
               WHEN workflow_status IN ('PLANNED','REJECTED') THEN 'READY'
               ELSE workflow_status
             END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,amount_minor::text,calculation_status,workflow_status`,
        [
          context.tenantId,input.obligationId,input.amountMinor,
          JSON.stringify(snapshot),input.note.trim()
        ]
      );
      await client.query(
        `INSERT INTO accounting_compliance_event(
           tenant_id,obligation_id,event_type,actor_membership_id,payload
         ) VALUES($1,$2,'AMOUNT_CONFIRMED',$3,$4)`,
        [
          context.tenantId,input.obligationId,context.membershipId,
          JSON.stringify({amountMinor:input.amountMinor,note:input.note.trim()})
        ]
      );
      return updated.rows[0];
    });
  }

  async complianceHistory(context:TenantContext,obligationId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const exists=await client.query(
        `SELECT 1 FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,obligationId]
      );
      if(!exists.rowCount) throw new NotFoundException("Налоговая задача не найдена");
      const result=await client.query(
        `SELECT
           id,event_type,actor_membership_id,previous_status,new_status,
           payload,created_at
         FROM accounting_compliance_event
         WHERE tenant_id=$1 AND obligation_id=$2
         ORDER BY created_at DESC,id DESC`,
        [context.tenantId,obligationId]
      );
      return result.rows;
    });
  }

}
