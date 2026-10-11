import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class TaxComplianceService {
  constructor(private readonly database:DatabaseService){}

  async dashboard(context:TenantContext,legalEntityId:string){
    if(!legalEntityId) throw new BadRequestException("Не выбрано юрлицо");
    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        "SELECT id,name,inn,kpp FROM legal_entity WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,legalEntityId]
      );
      if(!entity.rows[0]) throw new NotFoundException("Юрлицо не найдено");

      const profile=await client.query(
        `SELECT * FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
           AND effective_from<=current_date
           AND (effective_to IS NULL OR effective_to>=current_date)
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      const obligations=await client.query(
        `SELECT id,authority,obligation_type,code,title,period_key,due_at,
                amount_minor::text,currency,calculation_status,workflow_status,
                form_code,source_url,review_note,rejection_reason
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND workflow_status<>'CANCELLED'
         ORDER BY due_at LIMIT 100`,
        [context.tenantId,legalEntityId]
      );
      const counts=await client.query(
        `SELECT
           count(*) FILTER(
             WHERE due_at<now()
               AND workflow_status NOT IN ('ACCEPTED','PAID','CANCELLED')
           )::integer AS overdue,
           count(*) FILTER(
             WHERE due_at>=now() AND due_at<now()+interval '14 days'
               AND workflow_status NOT IN ('ACCEPTED','PAID','CANCELLED')
           )::integer AS next_14_days,
           count(*) FILTER(
             WHERE calculation_status='REVIEW_REQUIRED'
                OR workflow_status='READY'
           )::integer AS review_required,
           count(*) FILTER(WHERE workflow_status='REJECTED')::integer AS rejected
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND legal_entity_id=$2`,
        [context.tenantId,legalEntityId]
      );
      const ens=await client.query(
        `SELECT snapshot_at,balance_minor::text,upcoming_minor::text,
                overdue_minor::text,source,external_reference
         FROM accounting_ens_snapshot
         WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY snapshot_at DESC LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      const calculations=await client.query(
        `SELECT id,tax_code,period_key,date_from,date_to,
                taxable_income_minor::text,deductible_expense_minor::text,
                taxable_base_minor::text,calculated_tax_minor::text,
                advances_minor::text,tax_due_minor::text,status,created_at
         FROM accounting_tax_calculation
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status<>'SUPERSEDED'
         ORDER BY date_to DESC,created_at DESC LIMIT 12`,
        [context.tenantId,legalEntityId]
      );
      const connectors=await client.query(
        `SELECT id,provider,status,supports_filing,supports_receipts,
                certificate_valid_to,last_verified_at,last_error
         FROM accounting_reporting_connector
         WHERE tenant_id=$1 AND legal_entity_id=$2 ORDER BY provider`,
        [context.tenantId,legalEntityId]
      );
      return {
        entity:entity.rows[0],
        profile:profile.rows[0]??null,
        counts:counts.rows[0]??{},
        obligations:obligations.rows,
        ens:ens.rows[0]??null,
        calculations:calculations.rows,
        connectors:connectors.rows
      };
    });
  }

  async saveProfile(context:TenantContext,input:any){
    const effectiveFrom=input.effectiveFrom??new Date().toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom))
      throw new BadRequestException("Некорректная дата");
    if(!["ORGANIZATION","IP"].includes(input.entityKind))
      throw new BadRequestException("Некорректный тип налогоплательщика");
    if(!["USN_INCOME","USN_INCOME_EXPENSE","OSNO","AUSN","OTHER"].includes(input.taxRegime))
      throw new BadRequestException("Некорректный налоговый режим");
    const vatMode=input.vatMode??"NO_VAT";
    if(!["NO_VAT","VAT_5","VAT_7","VAT_22","VAT_MIXED"].includes(vatMode))
      throw new BadRequestException("Некорректный режим НДС");
    const defaultRate=input.taxRegime==="USN_INCOME"?600:
      input.taxRegime==="USN_INCOME_EXPENSE"?1500:null;
    const rate=input.usnRateBps===undefined?defaultRate:Math.floor(input.usnRateBps);

    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        "SELECT 1 FROM legal_entity WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,input.legalEntityId]
      );
      if(!entity.rowCount) throw new NotFoundException("Юрлицо не найдено");

      const same=await client.query<{id:string}>(
        `SELECT id FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND effective_from=$3::date
         FOR UPDATE`,
        [context.tenantId,input.legalEntityId,effectiveFrom]
      );
      if(!same.rows[0]){
        await client.query(
          `UPDATE accounting_tax_profile
           SET effective_to=$3::date-1,status='ARCHIVED',updated_at=now()
           WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
             AND effective_from<$3::date
             AND (effective_to IS NULL OR effective_to>=$3::date)`,
          [context.tenantId,input.legalEntityId,effectiveFrom]
        );
      }
      if(same.rows[0]){
        const updated=await client.query(
          `UPDATE accounting_tax_profile SET
             entity_kind=$4,tax_regime=$5,vat_mode=$6,has_employees=$7,
             tax_region_code=$8,tax_office_code=$9,okved_primary=$10,
             kpp=$11,oktmo=$12,reporting_mode=$13,risk_tolerance=$14,
             usn_rate_bps=$15,status='ACTIVE',effective_to=NULL,
             updated_by_membership_id=$16,updated_at=now()
           WHERE tenant_id=$1 AND legal_entity_id=$2 AND id=$3 RETURNING *`,
          [context.tenantId,input.legalEntityId,same.rows[0].id,
           input.entityKind,input.taxRegime,vatMode,Boolean(input.hasEmployees),
           input.taxRegionCode??null,input.taxOfficeCode??null,input.okvedPrimary??null,
           input.kpp??null,input.oktmo??null,input.reportingMode??"ASSISTED",
           input.riskTolerance??"CONSERVATIVE",rate,context.membershipId]
        );
        return updated.rows[0];
      }
      const inserted=await client.query(
        `INSERT INTO accounting_tax_profile(
           tenant_id,legal_entity_id,entity_kind,tax_regime,vat_mode,has_employees,
           tax_region_code,tax_office_code,okved_primary,kpp,oktmo,reporting_mode,
           risk_tolerance,usn_rate_bps,effective_from,created_by_membership_id,
           updated_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
         RETURNING *`,
        [context.tenantId,input.legalEntityId,input.entityKind,input.taxRegime,vatMode,
         Boolean(input.hasEmployees),input.taxRegionCode??null,input.taxOfficeCode??null,
         input.okvedPrimary??null,input.kpp??null,input.oktmo??null,
         input.reportingMode??"ASSISTED",input.riskTolerance??"CONSERVATIVE",
         rate,effectiveFrom,context.membershipId]
      );
      return inserted.rows[0];
    });
  }

  async generateCalendar(context:TenantContext,input:{legalEntityId:string;year:number}){
    const year=Math.floor(input.year);
    if(year<2025||year>2100) throw new BadRequestException("Некорректный год");
    return this.database.withTenantTransaction(context,async client=>{
      const p=await client.query<any>(
        `SELECT * FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
           AND effective_from<=$3::date
           AND (effective_to IS NULL OR effective_to>=$4::date)
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,input.legalEntityId,year+"-12-31",year+"-01-01"]
      );
      const profile=p.rows[0];
      if(!profile) throw new ConflictException("Налоговый профиль не настроен");
      const rules=await client.query<any>(
        `SELECT * FROM accounting_regulatory_rule
         WHERE status='ACTIVE'
           AND effective_from<=$1::date
           AND (effective_to IS NULL OR effective_to>=$2::date)
         ORDER BY code,version DESC`,
        [year+"-12-31",year+"-01-01"]
      );
      let created=0;
      for(const rule of rules.rows){
        if(rule.entity_kind&&rule.entity_kind!==profile.entity_kind) continue;
        if(rule.requires_employees===true&&!profile.has_employees) continue;
        if(rule.tax_regime==="USN"&&!String(profile.tax_regime).startsWith("USN")) continue;
        if(rule.vat_mode==="VAT_REQUIRED"&&profile.vat_mode==="NO_VAT") continue;
        const due=rule.due_rule??{};
        const instances:{period:string;due:string}[]=[];
        const iso=(m:number,d:number,y=year)=>
          new Date(Date.UTC(y,m-1,d,12)).toISOString();
        if(rule.cadence==="ANNUAL"&&due.month&&due.day){
          instances.push({period:String(year-1),due:iso(+due.month,+due.day)});
        } else if(Array.isArray(due.months)&&due.day){
          due.months.forEach((m:number,i:number)=>
            instances.push({period:year+"-Q"+(i+1),due:iso(+m,+due.day)}));
        } else if(rule.cadence==="QUARTERLY"&&due.day){
          [4,7,10].forEach((m,i)=>
            instances.push({period:year+"-Q"+(i+1),due:iso(m,+due.day)}));
          instances.push({period:year+"-Q4",due:iso(1,+due.day,year+1)});
        } else if(["MONTHLY","SEMI_MONTHLY"].includes(rule.cadence)&&(due.day||due.next_month_day)){
          for(let m=1;m<=12;m++){
            const next=Boolean(due.next_month_day);
            const dm=next?m+1:m;
            const yy=dm===13?year+1:year;
            const mm=dm===13?1:dm;
            instances.push({
              period:year+"-"+String(m).padStart(2,"0")+(due.segment?":"+due.segment:""),
              due:iso(mm,+(due.next_month_day??due.day),yy)
            });
          }
        }
        for(const instance of instances){
          const x=await client.query(
            `INSERT INTO accounting_compliance_obligation(
               tenant_id,legal_entity_id,tax_profile_id,rule_id,authority,
               obligation_type,code,title,period_key,due_at,calculation_status,
               workflow_status,form_code,source_url,source_effective_at,source_snapshot
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PLANNED',$12,$13,now(),$14)
             ON CONFLICT(tenant_id,legal_entity_id,code,period_key) DO NOTHING
             RETURNING id`,
            [context.tenantId,input.legalEntityId,profile.id,rule.id,rule.authority,
             rule.obligation_type,rule.code,rule.title,instance.period,instance.due,
             due.business_day_shift?"REVIEW_REQUIRED":"NOT_CALCULATED",
             rule.form_code??null,rule.source_url??null,
             JSON.stringify({ruleVersion:rule.version,dueRule:due,
               requiresHolidayVerification:Boolean(due.business_day_shift)})]
          );
          if(x.rowCount) created++;
        }
      }
      return {year,created};
    });
  }
}
