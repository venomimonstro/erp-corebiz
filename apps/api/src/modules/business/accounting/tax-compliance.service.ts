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

  async autoClassifyPayments(context:TenantContext,legalEntityId:string){
    return this.database.withTenantTransaction(context,async client=>{
      const entities=await client.query<{count:number}>(
        "SELECT count(*)::integer AS count FROM legal_entity WHERE tenant_id=$1 AND status='ACTIVE'",
        [context.tenantId]
      );
      if((entities.rows[0]?.count??0)!==1){
        throw new ConflictException(
          "При нескольких юрлицах сначала распределите платежи по юрлицам"
        );
      }
      const profile=await client.query(
        "SELECT 1 FROM accounting_tax_profile WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE' LIMIT 1",
        [context.tenantId,legalEntityId]
      );
      if(!profile.rowCount) throw new ConflictException("Налоговый профиль не настроен");

      const result=await client.query(
        `INSERT INTO accounting_tax_payment_classification(
           tenant_id,legal_entity_id,payment_id,treatment,source,confidence,
           reason,rule_code,classified_by_membership_id
         )
         SELECT p.tenant_id,$2,p.id,
           CASE
             WHEN p.status<>'POSTED' THEN 'EXCLUDED'
             WHEN p.kind='REFUND' THEN 'REVIEW_REQUIRED'
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT'
               THEN 'TAXABLE_INCOME'
             ELSE 'REVIEW_REQUIRED'
           END,
           'AUTO_RULE',
           CASE
             WHEN p.status<>'POSTED' THEN 100
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT' THEN 95
             ELSE 50
           END,
           CASE
             WHEN p.status<>'POSTED' THEN 'Платёж не участвует в расчёте'
             WHEN p.kind='REFUND' THEN 'Возврат требует проверки налогового периода'
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT'
               THEN 'Оплата клиента: кандидат в доход УСН'
             WHEN p.direction='OUT' AND c.code='SUPPLIER_PAYMENT'
               THEN 'Расход поставщику требует проверки налоговой допустимости'
             ELSE 'Нет безопасного автоматического правила'
           END,
           CASE
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT'
               THEN 'USN_CUSTOMER_RECEIPT'
             ELSE 'MANUAL_REVIEW'
           END,
           $3
         FROM payment p
         LEFT JOIN cash_flow_category c
           ON c.tenant_id=p.tenant_id AND c.id=p.category_id
         WHERE p.tenant_id=$1
           AND NOT EXISTS(
             SELECT 1
             FROM accounting_tax_payment_classification x
             WHERE x.tenant_id=p.tenant_id
               AND x.legal_entity_id=$2
               AND x.payment_id=p.id
           )
         RETURNING treatment`,
        [context.tenantId,legalEntityId,context.membershipId]
      );
      return {
        classified:result.rowCount,
        taxableIncome:result.rows.filter(r=>r.treatment==="TAXABLE_INCOME").length,
        reviewRequired:result.rows.filter(r=>r.treatment==="REVIEW_REQUIRED").length
      };
    });
  }

  async classifications(
    context:TenantContext,
    legalEntityId:string,
    from?:string,
    to?:string
  ){
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           x.id,x.payment_id,p.business_number,p.posted_at,p.direction,p.kind,
           p.amount_minor::text,p.currency,c.name AS category_name,
           x.treatment,x.source,x.confidence,x.reason,x.rule_code
         FROM accounting_tax_payment_classification x
         JOIN payment p
           ON p.tenant_id=x.tenant_id AND p.id=x.payment_id
         LEFT JOIN cash_flow_category c
           ON c.tenant_id=p.tenant_id AND c.id=p.category_id
         WHERE x.tenant_id=$1 AND x.legal_entity_id=$2
           AND ($3::date IS NULL OR p.posted_at>=$3::date)
           AND ($4::date IS NULL OR p.posted_at<$4::date+interval '1 day')
         ORDER BY p.posted_at DESC LIMIT 1000`,
        [context.tenantId,legalEntityId,from??null,to??null]
      );
      return result.rows;
    });
  }

  async classifyPayment(context:TenantContext,input:any){
    const allowed=[
      "TAXABLE_INCOME","DEDUCTIBLE_EXPENSE","NON_DEDUCTIBLE_EXPENSE",
      "EXCLUDED","REVIEW_REQUIRED"
    ];
    if(!allowed.includes(input.treatment))
      throw new BadRequestException("Некорректная налоговая классификация");
    return this.database.withTenantTransaction(context,async client=>{
      const p=await client.query(
        "SELECT 1 FROM payment WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,input.paymentId]
      );
      if(!p.rowCount) throw new NotFoundException("Платёж не найден");
      const result=await client.query(
        `INSERT INTO accounting_tax_payment_classification(
           tenant_id,legal_entity_id,payment_id,treatment,source,confidence,
           reason,rule_code,classified_by_membership_id
         ) VALUES($1,$2,$3,$4,'MANUAL',100,$5,'MANUAL',$6)
         ON CONFLICT(tenant_id,legal_entity_id,payment_id)
         DO UPDATE SET treatment=EXCLUDED.treatment,source='MANUAL',
           confidence=100,reason=EXCLUDED.reason,rule_code='MANUAL',
           classified_by_membership_id=EXCLUDED.classified_by_membership_id,
           classified_at=now(),updated_at=now()
         RETURNING *`,
        [context.tenantId,input.legalEntityId,input.paymentId,input.treatment,
         input.reason?.trim()||null,context.membershipId]
      );
      return result.rows[0];
    });
  }

  async calculateUsn(context:TenantContext,input:any){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.dateFrom)||
       !/^\d{4}-\d{2}-\d{2}$/.test(input.dateTo)||
       input.dateFrom>input.dateTo||!input.periodKey?.trim()){
      throw new BadRequestException("Некорректный налоговый период");
    }
    const advances=String(input.advancesMinor??"0");
    if(!/^\d+$/.test(advances)) throw new BadRequestException("Некорректные авансы");

    return this.database.withTenantTransaction(context,async client=>{
      const p=await client.query<any>(
        `SELECT * FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
           AND effective_from<=$3::date
           AND (effective_to IS NULL OR effective_to>=$4::date)
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,input.legalEntityId,input.dateTo,input.dateFrom]
      );
      const profile=p.rows[0];
      if(!profile) throw new ConflictException("Налоговый профиль не настроен");
      if(!["USN_INCOME","USN_INCOME_EXPENSE"].includes(profile.tax_regime))
        throw new ConflictException("Для этого режима расчёт УСН недоступен");

      const totals=await client.query<any>(
        `SELECT
           coalesce(sum(p.amount_minor) FILTER(
             WHERE x.treatment='TAXABLE_INCOME' AND p.status='POSTED'
           ),0)::text AS income_minor,
           coalesce(sum(p.amount_minor) FILTER(
             WHERE x.treatment='DEDUCTIBLE_EXPENSE' AND p.status='POSTED'
           ),0)::text AS expense_minor,
           count(*) FILTER(
             WHERE x.treatment='REVIEW_REQUIRED' AND p.status='POSTED'
           )::integer AS review_count
         FROM accounting_tax_payment_classification x
         JOIN payment p ON p.tenant_id=x.tenant_id AND p.id=x.payment_id
         WHERE x.tenant_id=$1 AND x.legal_entity_id=$2
           AND p.posted_at>=$3::date
           AND p.posted_at<$4::date+interval '1 day'`,
        [context.tenantId,input.legalEntityId,input.dateFrom,input.dateTo]
      );
      const income=BigInt(totals.rows[0]?.income_minor??"0");
      const expense=BigInt(totals.rows[0]?.expense_minor??"0");
      const review=Number(totals.rows[0]?.review_count??0);
      const base=profile.tax_regime==="USN_INCOME"
        ?income:(income>expense?income-expense:0n);
      const rate=BigInt(profile.usn_rate_bps??(
        profile.tax_regime==="USN_INCOME"?600:1500
      ));
      const regular=(base*rate+9999n)/10000n;
      const annual=input.dateFrom.endsWith("-01-01")&&input.dateTo.endsWith("-12-31");
      const minimum=profile.tax_regime==="USN_INCOME_EXPENSE"&&annual
        ?(income*BigInt(profile.usn_min_tax_bps??100)+9999n)/10000n:0n;
      const calculated=regular>minimum?regular:minimum;
      const advance=BigInt(advances);
      const due=calculated>advance?calculated-advance:0n;

      await client.query(
        `UPDATE accounting_tax_calculation
         SET status='SUPERSEDED',updated_at=now()
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND tax_code='USN'
           AND period_key=$3 AND status IN ('DRAFT','REVIEW_REQUIRED')`,
        [context.tenantId,input.legalEntityId,input.periodKey]
      );
      const result=await client.query(
        `INSERT INTO accounting_tax_calculation(
           tenant_id,legal_entity_id,tax_profile_id,tax_code,period_key,
           date_from,date_to,taxable_income_minor,deductible_expense_minor,
           taxable_base_minor,calculated_tax_minor,advances_minor,tax_due_minor,
           calculation_method,rule_snapshot,source_snapshot,status
         ) VALUES(
           $1,$2,$3,'USN',$4,$5,$6,$7,$8,$9,$10,$11,$12,
           'PAYMENT_CASH_BASIS_CLASSIFIED',$13,$14,$15
         ) RETURNING *`,
        [context.tenantId,input.legalEntityId,profile.id,input.periodKey,
         input.dateFrom,input.dateTo,income.toString(),expense.toString(),
         base.toString(),calculated.toString(),advance.toString(),due.toString(),
         JSON.stringify({taxRegime:profile.tax_regime,rateBps:Number(rate),
           minimumTaxApplied:minimum>regular}),
         JSON.stringify({reviewRequiredPayments:review}),
         review>0?"REVIEW_REQUIRED":"DRAFT"]
      );
      return result.rows[0];
    });
  }

  async confirmCalculation(context:TenantContext,id:string){
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE accounting_tax_calculation
         SET status='CONFIRMED',confirmed_by_membership_id=$3,
             confirmed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2
           AND status IN ('DRAFT','REVIEW_REQUIRED')
         RETURNING *`,
        [context.tenantId,id,context.membershipId]
      );
      if(!result.rows[0]) throw new ConflictException("Расчёт уже подтверждён");
      return result.rows[0];
    });
  }

  async recordEns(context:TenantContext,input:any){
    for(const value of [
      String(input.balanceMinor??"0"),
      String(input.upcomingMinor??"0"),
      String(input.overdueMinor??"0")
    ]){
      if(!/^-?\d+$/.test(value)) throw new BadRequestException("Некорректная сумма ЕНС");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `INSERT INTO accounting_ens_snapshot(
           tenant_id,legal_entity_id,balance_minor,upcoming_minor,overdue_minor,
           source,external_reference,details,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [context.tenantId,input.legalEntityId,String(input.balanceMinor??"0"),
         String(input.upcomingMinor??"0"),String(input.overdueMinor??"0"),
         input.source??"MANUAL",input.externalReference??null,
         JSON.stringify(input.details??{}),context.membershipId]
      );
      return result.rows[0];
    });
  }


  async preparePacket(context:TenantContext,obligationId:string){
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<any>(
        `SELECT
           o.*,l.name AS legal_entity_name,l.inn,l.kpp
         FROM accounting_compliance_obligation o
         JOIN legal_entity l
           ON l.tenant_id=o.tenant_id AND l.id=o.legal_entity_id
         WHERE o.tenant_id=$1 AND o.id=$2
         FOR UPDATE OF o`,
        [context.tenantId,obligationId]
      );
      const o=result.rows[0];
      if(!o) throw new NotFoundException("Налоговое обязательство не найдено");
      if(["ACCEPTED","PAID","CANCELLED"].includes(o.workflow_status)){
        throw new ConflictException("Обязательство уже завершено");
      }

      const packetKind=o.obligation_type==="PAY"
        ?"PAYMENT_INSTRUCTION"
        :o.obligation_type==="NOTIFY"
          ?"FNS_NOTIFICATION"
          :o.authority==="SFR"
            ?"SFR_REPORT"
            :"FNS_DECLARATION";

      const payload={
        generatedAt:new Date().toISOString(),
        legalEntity:{
          id:o.legal_entity_id,
          name:o.legal_entity_name,
          inn:o.inn,
          kpp:o.kpp
        },
        obligation:{
          id:o.id,
          authority:o.authority,
          type:o.obligation_type,
          code:o.code,
          title:o.title,
          periodKey:o.period_key,
          dueAt:o.due_at,
          amountMinor:o.amount_minor,
          currency:o.currency,
          formCode:o.form_code
        },
        evidence:o.source_snapshot,
        notice:
          "Черновой пакет. Юридически значимая отправка требует проверки формата, подписи и подтвержденного оператора."
      };

      const packet=await client.query(
        `INSERT INTO accounting_compliance_packet(
           tenant_id,legal_entity_id,obligation_id,packet_kind,format,
           form_code,schema_version,payload,validation_status,
           signature_status,created_by_membership_id
         ) VALUES(
           $1,$2,$3,$4,'JSON',$5,'COREBIZ-DRAFT-1',$6,
           'REVIEW_REQUIRED','SIGNATURE_REQUIRED',$7
         )
         ON CONFLICT(tenant_id,obligation_id,packet_kind)
         DO UPDATE SET
           payload=EXCLUDED.payload,
           validation_status='REVIEW_REQUIRED',
           signature_status=CASE
             WHEN accounting_compliance_packet.signature_status='SIGNED'
             THEN 'SIGNED'
             ELSE 'SIGNATURE_REQUIRED'
           END,
           updated_at=now()
         RETURNING *`,
        [
          context.tenantId,o.legal_entity_id,o.id,packetKind,
          o.form_code??null,JSON.stringify(payload),context.membershipId
        ]
      );

      await client.query(
        `UPDATE accounting_compliance_obligation
         SET packet_id=$3,
             workflow_status=CASE
               WHEN workflow_status='PLANNED' THEN 'READY'
               ELSE workflow_status
             END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,o.id,packet.rows[0].id]
      );
      return packet.rows[0];
    });
  }

  async validatePacket(
    context:TenantContext,
    packetId:string,
    input:{valid:boolean;errors?:string[]}
  ){
    return this.database.withTenantTransaction(context,async client=>{
      const errors=Array.isArray(input.errors)
        ?input.errors.slice(0,100).map(String)
        :[];
      const result=await client.query(
        `UPDATE accounting_compliance_packet
         SET validation_status=$3,
             validation_errors=$4::jsonb,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [
          context.tenantId,packetId,input.valid?"VALID":"INVALID",
          JSON.stringify(errors)
        ]
      );
      if(!result.rows[0]) throw new NotFoundException("Пакет не найден");
      return result.rows[0];
    });
  }

  async recordPacketSignature(
    context:TenantContext,
    packetId:string
  ){
    return this.database.withTenantTransaction(context,async client=>{
      const packet=await client.query<any>(
        `SELECT p.*,c.id AS connector_id,c.status AS connector_status,
                c.certificate_valid_to
         FROM accounting_compliance_packet p
         LEFT JOIN accounting_reporting_connector c
           ON c.tenant_id=p.tenant_id
          AND c.legal_entity_id=p.legal_entity_id
          AND c.status='VERIFIED'
         WHERE p.tenant_id=$1 AND p.id=$2
         ORDER BY c.last_verified_at DESC NULLS LAST
         LIMIT 1
         FOR UPDATE OF p`,
        [context.tenantId,packetId]
      );
      const row=packet.rows[0];
      if(!row) throw new NotFoundException("Пакет не найден");
      if(row.validation_status!=="VALID"){
        throw new ConflictException("Сначала пакет должен пройти валидацию");
      }
      if(!row.connector_id){
        throw new ConflictException(
          "Нет подтвержденного оператора электронной отчетности"
        );
      }
      if(
        row.certificate_valid_to &&
        new Date(row.certificate_valid_to).getTime()<=Date.now()
      ){
        throw new ConflictException("Сертификат электронной подписи истек");
      }

      const result=await client.query(
        `UPDATE accounting_compliance_packet
         SET signature_status='SIGNED',signed_at=now(),
             signed_by_membership_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [context.tenantId,packetId,context.membershipId]
      );
      return result.rows[0];
    });
  }

  async approveObligation(
    context:TenantContext,
    obligationId:string,
    note?:string
  ){
    return this.database.withTenantTransaction(context,async client=>{
      const packet=await client.query<any>(
        `SELECT p.id,p.validation_status
         FROM accounting_compliance_packet p
         WHERE p.tenant_id=$1 AND p.obligation_id=$2
         FOR UPDATE`,
        [context.tenantId,obligationId]
      );
      if(!packet.rows[0]){
        throw new ConflictException("Сначала подготовьте пакет");
      }
      if(packet.rows[0].validation_status!=="VALID"){
        throw new ConflictException("Пакет еще не прошел валидацию");
      }
      const result=await client.query(
        `UPDATE accounting_compliance_obligation
         SET workflow_status='APPROVED',
             approved_by_membership_id=$3,approved_at=now(),
             review_note=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND workflow_status='READY'
         RETURNING *`,
        [context.tenantId,obligationId,context.membershipId,note?.trim()||null]
      );
      if(!result.rows[0]){
        throw new ConflictException("Обязательство не готово к утверждению");
      }
      return result.rows[0];
    });
  }

  async queueSubmission(
    context:TenantContext,
    obligationId:string
  ){
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<any>(
        `SELECT
           o.id AS obligation_id,o.workflow_status,
           p.id AS packet_id,p.validation_status,p.signature_status,
           c.id AS connector_id,c.provider,c.supports_filing,
           c.status AS connector_status
         FROM accounting_compliance_obligation o
         JOIN accounting_compliance_packet p
           ON p.tenant_id=o.tenant_id AND p.obligation_id=o.id
         LEFT JOIN accounting_reporting_connector c
           ON c.tenant_id=o.tenant_id
          AND c.legal_entity_id=o.legal_entity_id
          AND c.status='VERIFIED'
          AND c.supports_filing=true
         WHERE o.tenant_id=$1 AND o.id=$2
         ORDER BY c.last_verified_at DESC NULLS LAST
         LIMIT 1
         FOR UPDATE OF o,p`,
        [context.tenantId,obligationId]
      );
      const row=result.rows[0];
      if(!row) throw new NotFoundException("Обязательство или пакет не найдены");
      if(row.workflow_status!=="APPROVED"){
        throw new ConflictException("Сначала утвердите обязательство");
      }
      if(row.validation_status!=="VALID"||row.signature_status!=="SIGNED"){
        throw new ConflictException("Нужны валидный и подписанный пакет");
      }
      if(!row.connector_id){
        throw new ConflictException(
          "Не подключен подтвержденный оператор электронной отчетности"
        );
      }

      const key="tax-submit:"+obligationId+":"+row.packet_id;
      const attempt=await client.query(
        `INSERT INTO accounting_submission_attempt(
           tenant_id,filing_package_id,connector_id,idempotency_key,status,
           request_snapshot
         )
         SELECT $1,f.id,$3,$4,'QUEUED',$5
         FROM accounting_filing_package f
         WHERE f.tenant_id=$1 AND f.obligation_id=$2
         ORDER BY f.created_at DESC
         LIMIT 1
         ON CONFLICT(tenant_id,idempotency_key)
         DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
         RETURNING *`,
        [
          context.tenantId,obligationId,row.connector_id,key,
          JSON.stringify({
            obligationId,
            compliancePacketId:row.packet_id,
            provider:row.provider
          })
        ]
      );

      if(!attempt.rows[0]){
        throw new ConflictException(
          "Для отправки нет provider-specific filing package. Подготовьте пакет формата оператора."
        );
      }
      return attempt.rows[0];
    });
  }

}
