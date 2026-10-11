import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type TaxRegime =
  | "USN_INCOME"
  | "USN_INCOME_EXPENSE"
  | "OSNO"
  | "AUSN"
  | "OTHER";

type VatMode = "NO_VAT" | "VAT_5" | "VAT_7" | "VAT_20" | "VAT_MIXED";

type TaxProfileInput = {
  legalEntityId:string;
  entityKind:"ORGANIZATION"|"IP";
  taxRegime:TaxRegime;
  vatMode?:VatMode;
  hasEmployees?:boolean;
  taxRegionCode?:string;
  taxOfficeCode?:string;
  ensEnabled?:boolean;
  okvedPrimary?:string;
  kpp?:string;
  oktmo?:string;
  reportingMode?:"ASSISTED"|"SEMI_AUTOMATIC"|"EXTERNAL_ACCOUNTANT";
  riskTolerance?:"CONSERVATIVE"|"STANDARD";
  usnRateBps?:number|null;
  usnMinimumTaxBps?:number|null;
  effectiveFrom?:string;
};

@Injectable()
export class ComplianceService {
  constructor(private readonly database:DatabaseService) {}

  async profile(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.*,le.name AS legal_entity_name,le.inn,le.kpp AS legal_entity_kpp
         FROM accounting_tax_profile p
         JOIN legal_entity le
           ON le.tenant_id=p.tenant_id AND le.id=p.legal_entity_id
         WHERE p.tenant_id=$1
           AND p.legal_entity_id=$2
           AND p.status='ACTIVE'
         ORDER BY p.effective_from DESC,p.created_at DESC
         LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      return result.rows[0]??null;
    });
  }

  async saveProfile(context:TenantContext,input:TaxProfileInput) {
    if(!input?.legalEntityId) {
      throw new BadRequestException("Выберите юридическое лицо");
    }
    if(!["ORGANIZATION","IP"].includes(input.entityKind)) {
      throw new BadRequestException("Некорректный тип налогоплательщика");
    }
    if(![
      "USN_INCOME","USN_INCOME_EXPENSE","OSNO","AUSN","OTHER"
    ].includes(input.taxRegime)) {
      throw new BadRequestException("Некорректный налоговый режим");
    }
    const vatMode=input.vatMode??"NO_VAT";
    if(!["NO_VAT","VAT_5","VAT_7","VAT_20","VAT_MIXED"].includes(vatMode)) {
      throw new BadRequestException("Некорректный режим НДС");
    }
    for(const rate of [input.usnRateBps,input.usnMinimumTaxBps]) {
      if(rate!==undefined&&rate!==null&&(
        !Number.isSafeInteger(rate)||rate<1||rate>10000
      )) {
        throw new BadRequestException("Некорректная налоговая ставка");
      }
    }
    const effectiveFrom=input.effectiveFrom??new Date().toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      throw new BadRequestException("Некорректная дата начала налогового профиля");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        `SELECT 1 FROM legal_entity
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,input.legalEntityId]
      );
      if(!entity.rowCount) throw new NotFoundException("Юридическое лицо не найдено");

      const current=await client.query<{id:string;effective_from:string}>(
        `SELECT id,effective_from::text
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
         ORDER BY effective_from DESC
         LIMIT 1
         FOR UPDATE`,
        [context.tenantId,input.legalEntityId]
      );
      const existing=current.rows[0];
      if(existing&&existing.effective_from===effectiveFrom) {
        const updated=await client.query(
          `UPDATE accounting_tax_profile
           SET entity_kind=$3,tax_regime=$4,vat_mode=$5,
               has_employees=$6,tax_region_code=$7,tax_office_code=$8,
               ens_enabled=$9,okved_primary=$10,kpp=$11,oktmo=$12,
               reporting_mode=$13,risk_tolerance=$14,
               usn_rate_bps=$15,usn_minimum_tax_bps=$16,
               updated_by_membership_id=$17,updated_at=now()
           WHERE tenant_id=$1 AND id=$2
           RETURNING *`,
          [
            context.tenantId,existing.id,input.entityKind,input.taxRegime,
            vatMode,Boolean(input.hasEmployees),input.taxRegionCode?.trim()||null,
            input.taxOfficeCode?.trim()||null,input.ensEnabled!==false,
            input.okvedPrimary?.trim()||null,input.kpp?.trim()||null,
            input.oktmo?.trim()||null,input.reportingMode??"ASSISTED",
            input.riskTolerance??"CONSERVATIVE",input.usnRateBps??null,
            input.usnMinimumTaxBps??null,context.membershipId
          ]
        );
        return updated.rows[0];
      }

      if(existing) {
        const previousDay=new Date(effectiveFrom+"T00:00:00Z");
        previousDay.setUTCDate(previousDay.getUTCDate()-1);
        await client.query(
          `UPDATE accounting_tax_profile
           SET effective_to=$3,status='ARCHIVED',
               updated_by_membership_id=$4,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,existing.id,
            previousDay.toISOString().slice(0,10),context.membershipId
          ]
        );
      }

      const created=await client.query(
        `INSERT INTO accounting_tax_profile(
           tenant_id,legal_entity_id,entity_kind,tax_regime,vat_mode,
           has_employees,tax_region_code,tax_office_code,ens_enabled,
           okved_primary,kpp,oktmo,reporting_mode,risk_tolerance,
           usn_rate_bps,usn_minimum_tax_bps,effective_from,
           created_by_membership_id,updated_by_membership_id
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18
         )
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,input.entityKind,input.taxRegime,
          vatMode,Boolean(input.hasEmployees),input.taxRegionCode?.trim()||null,
          input.taxOfficeCode?.trim()||null,input.ensEnabled!==false,
          input.okvedPrimary?.trim()||null,input.kpp?.trim()||null,
          input.oktmo?.trim()||null,input.reportingMode??"ASSISTED",
          input.riskTolerance??"CONSERVATIVE",input.usnRateBps??null,
          input.usnMinimumTaxBps??null,effectiveFrom,context.membershipId
        ]
      );
      return created.rows[0];
    });
  }

  async syncTaxLedger(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        "SELECT 1 FROM legal_entity WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,legalEntityId]
      );
      if(!entity.rowCount) throw new NotFoundException("Юридическое лицо не найдено");

      const result=await client.query(
        `INSERT INTO accounting_tax_ledger_item(
           tenant_id,legal_entity_id,payment_id,recognition_date,
           direction,amount_minor,currency,tax_treatment,treatment_reason,
           source_type,source_id,category_code,evidence,
           reviewed_by_membership_id,reviewed_at
         )
         SELECT
           p.tenant_id,$2,p.id,p.posted_at::date,
           CASE WHEN p.direction='IN' THEN 'INCOME' ELSE 'EXPENSE' END,
           p.amount_minor,p.currency,
           CASE
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT'
               THEN 'INCLUDED'
             ELSE 'REVIEW_REQUIRED'
           END,
           CASE
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT'
               THEN 'AUTO_CUSTOMER_PAYMENT'
             ELSE NULL
           END,
           coalesce(p.source_type,'PAYMENT'),p.source_id,c.code,
           jsonb_build_object(
             'paymentNumber',p.business_number,
             'partyId',p.party_id,
             'note',p.note
           ),
           CASE
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT'
               THEN p.posted_by_membership_id
             ELSE NULL
           END,
           CASE
             WHEN p.direction='IN' AND c.code='CUSTOMER_PAYMENT'
               THEN p.posted_at
             ELSE NULL
           END
         FROM payment p
         JOIN cash_account a
           ON a.tenant_id=p.tenant_id AND a.id=p.cash_account_id
         LEFT JOIN cash_flow_category c
           ON c.tenant_id=p.tenant_id AND c.id=p.category_id
         WHERE p.tenant_id=$1
           AND a.legal_entity_id=$2
           AND p.status='POSTED'
           AND p.currency='RUB'
         ON CONFLICT(tenant_id,legal_entity_id,payment_id) DO NOTHING
         RETURNING id`,
        [context.tenantId,legalEntityId]
      );
      return {added:result.rowCount};
    });
  }

  async taxLedger(
    context:TenantContext,
    legalEntityId:string,
    from?:string,
    to?:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           i.id,i.recognition_date,i.direction,i.amount_minor::text,i.currency,
           i.tax_treatment,i.treatment_reason,i.source_type,i.source_id,
           i.category_code,i.evidence,i.reviewed_at,
           p.business_number AS payment_number,
           party.display_name AS party_name
         FROM accounting_tax_ledger_item i
         LEFT JOIN payment p
           ON p.tenant_id=i.tenant_id AND p.id=i.payment_id
         LEFT JOIN party
           ON party.tenant_id=p.tenant_id AND party.id=p.party_id
         WHERE i.tenant_id=$1 AND i.legal_entity_id=$2
           AND ($3::date IS NULL OR i.recognition_date>=$3)
           AND ($4::date IS NULL OR i.recognition_date<=$4)
         ORDER BY i.recognition_date DESC,i.created_at DESC
         LIMIT 2000`,
        [context.tenantId,legalEntityId,from??null,to??null]
      );
      return result.rows;
    });
  }

  async reviewTaxLedgerItem(
    context:TenantContext,
    itemId:string,
    input:{treatment:"INCLUDED"|"EXCLUDED";reason:string}
  ) {
    if(!["INCLUDED","EXCLUDED"].includes(input?.treatment) ||
       !input.reason?.trim() || input.reason.trim().length<4) {
      throw new BadRequestException("Укажите решение и основание");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE accounting_tax_ledger_item
         SET tax_treatment=$3,treatment_reason=$4,
             reviewed_by_membership_id=$5,reviewed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [
          context.tenantId,itemId,input.treatment,input.reason.trim(),
          context.membershipId
        ]
      );
      if(!result.rows[0]) throw new NotFoundException("Строка налоговой книги не найдена");
      return result.rows[0];
    });
  }

  async usnPreview(
    context:TenantContext,
    input:{
      legalEntityId:string;
      periodFrom:string;
      periodTo:string;
      calculationType:"USN_ADVANCE"|"USN_ANNUAL";
      reductionsMinor?:string;
    }
  ) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.periodFrom) ||
       !/^\d{4}-\d{2}-\d{2}$/.test(input.periodTo) ||
       input.periodFrom>input.periodTo) {
      throw new BadRequestException("Некорректный период расчёта");
    }
    const reductions=BigInt(input.reductionsMinor??"0");
    if(reductions<0n) throw new BadRequestException("Некорректные уменьшения");

    return this.database.withTenantTransaction(context,async client=>{
      const profileResult=await client.query<any>(
        `SELECT *
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status='ACTIVE'
           AND effective_from<=$3::date
           AND (effective_to IS NULL OR effective_to>=$4::date)
         ORDER BY effective_from DESC
         LIMIT 1`,
        [context.tenantId,input.legalEntityId,input.periodTo,input.periodFrom]
      );
      const profile=profileResult.rows[0];
      if(!profile) throw new ConflictException("Настройте налоговый профиль");
      if(!["USN_INCOME","USN_INCOME_EXPENSE"].includes(profile.tax_regime)) {
        throw new ConflictException("Расчёт доступен только для УСН");
      }
      if(!profile.usn_rate_bps) {
        throw new ConflictException(
          "Укажите подтверждённую ставку УСН для вашего региона"
        );
      }

      const totals=await client.query<{
        income:string;expense:string;review_count:number;
      }>(
        `SELECT
           coalesce(sum(amount_minor) FILTER(
             WHERE direction='INCOME' AND tax_treatment='INCLUDED'
           ),0)::text AS income,
           coalesce(sum(amount_minor) FILTER(
             WHERE direction='EXPENSE' AND tax_treatment='INCLUDED'
           ),0)::text AS expense,
           count(*) FILTER(
             WHERE tax_treatment='REVIEW_REQUIRED'
           )::integer AS review_count
         FROM accounting_tax_ledger_item
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND recognition_date BETWEEN $3::date AND $4::date`,
        [
          context.tenantId,input.legalEntityId,
          input.periodFrom,input.periodTo
        ]
      );
      const totalsRow=totals.rows[0]!;
      const income=BigInt(totalsRow.income);
      const expense=BigInt(totalsRow.expense);
      const base=profile.tax_regime==="USN_INCOME"
        ?income
        :(income>expense?income-expense:0n);
      const mainTax=base*BigInt(profile.usn_rate_bps)/10000n;
      let calculated=mainTax;
      let minimumTax=0n;

      if(
        profile.tax_regime==="USN_INCOME_EXPENSE" &&
        input.calculationType==="USN_ANNUAL"
      ) {
        if(!profile.usn_minimum_tax_bps) {
          throw new ConflictException(
            "Укажите подтверждённую ставку минимального налога УСН"
          );
        }
        minimumTax=
          income*BigInt(profile.usn_minimum_tax_bps)/10000n;
        if(minimumTax>calculated) calculated=minimumTax;
      }

      const finalPreview=calculated>reductions?calculated-reductions:0n;
      const confidence=totalsRow.review_count>0
        ?"REVIEW_REQUIRED"
        :"PREVIEW";

      const snapshot={
        includedIncomeMinor:income.toString(),
        includedExpenseMinor:expense.toString(),
        reviewRequiredCount:totalsRow.review_count,
        note:"Предварительный расчёт. Не учитывает все специальные уменьшения, перенос убытков и региональные особенности без отдельного подтверждения."
      };
      const formula={
        regime:profile.tax_regime,
        rateBps:profile.usn_rate_bps,
        minimumTaxBps:profile.usn_minimum_tax_bps,
        minimumTaxMinor:minimumTax.toString()
      };

      const result=await client.query(
        `INSERT INTO accounting_tax_calculation(
           tenant_id,legal_entity_id,tax_profile_id,calculation_type,
           period_from,period_to,income_minor,expense_minor,tax_base_minor,
           calculated_minor,reductions_minor,final_preview_minor,
           confidence,source_snapshot,formula_snapshot
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
         )
         ON CONFLICT(
           tenant_id,legal_entity_id,calculation_type,period_from,period_to
         ) DO UPDATE SET
           tax_profile_id=EXCLUDED.tax_profile_id,
           income_minor=EXCLUDED.income_minor,
           expense_minor=EXCLUDED.expense_minor,
           tax_base_minor=EXCLUDED.tax_base_minor,
           calculated_minor=EXCLUDED.calculated_minor,
           reductions_minor=EXCLUDED.reductions_minor,
           final_preview_minor=EXCLUDED.final_preview_minor,
           confidence=EXCLUDED.confidence,
           source_snapshot=EXCLUDED.source_snapshot,
           formula_snapshot=EXCLUDED.formula_snapshot,
           verified_by_membership_id=NULL,verified_at=NULL,updated_at=now()
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,profile.id,
          input.calculationType,input.periodFrom,input.periodTo,
          income.toString(),expense.toString(),base.toString(),
          calculated.toString(),reductions.toString(),finalPreview.toString(),
          confidence,JSON.stringify(snapshot),JSON.stringify(formula)
        ]
      );
      return result.rows[0];
    });
  }

  async confirmCalculation(
    context:TenantContext,
    calculationId:string,
    input:{obligationId?:string;note:string}
  ) {
    if(!input.note?.trim()||input.note.trim().length<8) {
      throw new BadRequestException("Укажите основание проверки расчёта");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<any>(
        `UPDATE accounting_tax_calculation
         SET confidence='VERIFIED',verified_by_membership_id=$3,
             verified_at=now(),obligation_id=coalesce($4::uuid,obligation_id),
             source_snapshot=source_snapshot ||
               jsonb_build_object('verificationNote',$5),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [
          context.tenantId,calculationId,context.membershipId,
          input.obligationId??null,input.note.trim()
        ]
      );
      const row=result.rows[0];
      if(!row) throw new NotFoundException("Расчёт не найден");

      if(row.obligation_id) {
        await client.query(
          `UPDATE accounting_compliance_obligation
           SET amount_minor=$3,calculation_status='CONFIRMED',
               calculation_snapshot=$4,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,row.obligation_id,row.final_preview_minor,
            JSON.stringify({
              taxCalculationId:row.id,
              verifiedBy:context.membershipId,
              verifiedAt:new Date().toISOString()
            })
          ]
        );
      }
      return row;
    });
  }

  async obligations(
    context:TenantContext,
    legalEntityId:string,
    from?:string,
    to?:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           o.*,r.form_code AS rule_form_code,r.source_url AS rule_source_url,
           p.validation_status,p.signature_status,
           c.provider AS connector_provider,c.status AS connector_status
         FROM accounting_compliance_obligation o
         LEFT JOIN accounting_regulatory_rule r ON r.id=o.rule_id
         LEFT JOIN accounting_compliance_packet p
           ON p.tenant_id=o.tenant_id AND p.id=o.packet_id
         LEFT JOIN accounting_reporting_connector c
           ON c.tenant_id=o.tenant_id
          AND c.legal_entity_id=o.legal_entity_id
          AND c.status='VERIFIED'
         WHERE o.tenant_id=$1 AND o.legal_entity_id=$2
           AND ($3::timestamptz IS NULL OR o.due_at>=$3)
           AND ($4::timestamptz IS NULL OR o.due_at<=$4)
         ORDER BY
           CASE WHEN o.workflow_status IN ('ACCEPTED','PAID','CANCELLED') THEN 1 ELSE 0 END,
           o.due_at,o.title`,
        [context.tenantId,legalEntityId,from??null,to??null]
      );
      return result.rows;
    });
  }

  async generateCalendar(
    context:TenantContext,
    input:{legalEntityId:string;from:string;to:string}
  ) {
    const from=new Date(input.from+"T00:00:00Z");
    const to=new Date(input.to+"T23:59:59Z");
    if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<from) {
      throw new BadRequestException("Некорректный горизонт календаря");
    }
    if(to.getTime()-from.getTime()>550*86400000) {
      throw new BadRequestException("Горизонт календаря не более 550 дней");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const profileResult=await client.query<any>(
        `SELECT *
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
         ORDER BY effective_from DESC
         LIMIT 1`,
        [context.tenantId,input.legalEntityId]
      );
      const profile=profileResult.rows[0];
      if(!profile) throw new ConflictException("Сначала настройте налоговый профиль");

      const rules=await client.query<any>(
        `SELECT *
         FROM accounting_regulatory_rule
         WHERE status='ACTIVE'
           AND effective_from<=$1::date
           AND (effective_to IS NULL OR effective_to>=$2::date)
         ORDER BY code,version DESC`,
        [input.to,input.from]
      );

      let created=0;
      for(const rule of rules.rows) {
        if(!this.ruleMatches(rule,profile)) continue;
        for(const due of this.expandDueDates(rule,from,to)) {
          const periodKey=due.periodKey;
          const result=await client.query(
            `INSERT INTO accounting_compliance_obligation(
               tenant_id,legal_entity_id,tax_profile_id,rule_id,
               authority,obligation_type,code,title,period_key,due_at,
               form_code,source_url,source_effective_at,
               calculation_status,workflow_status,source_snapshot
             ) VALUES(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               'NOT_CALCULATED','PLANNED',$14
             )
             ON CONFLICT(tenant_id,legal_entity_id,code,period_key)
             DO NOTHING
             RETURNING id`,
            [
              context.tenantId,input.legalEntityId,profile.id,rule.id,
              rule.authority,rule.obligation_type,rule.code,rule.title,
              periodKey,due.dueAt,rule.form_code,rule.source_url,
              rule.effective_from,
              JSON.stringify({
                regulatoryRuleCode:rule.code,
                regulatoryRuleVersion:rule.version,
                dueRule:rule.due_rule,
                weekendShiftApplied:due.weekendShiftApplied,
                holidayCalendarVerified:false
              })
            ]
          );
          created+=result.rowCount;
        }
      }
      return {created};
    });
  }

  async preparePacket(context:TenantContext,obligationId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const obligationResult=await client.query<any>(
        `SELECT
           o.*,le.inn,coalesce(p.kpp,le.kpp) AS kpp,p.oktmo
         FROM accounting_compliance_obligation o
         JOIN accounting_tax_profile p
           ON p.tenant_id=o.tenant_id AND p.id=o.tax_profile_id
         JOIN legal_entity le
           ON le.tenant_id=o.tenant_id AND le.id=o.legal_entity_id
         WHERE o.tenant_id=$1 AND o.id=$2
         FOR UPDATE OF o`,
        [context.tenantId,obligationId]
      );
      const obligation=obligationResult.rows[0];
      if(!obligation) throw new NotFoundException("Обязательство не найдено");
      if(!["PLANNED","READY","REJECTED"].includes(obligation.workflow_status)) {
        throw new ConflictException("Пакет уже находится на следующем этапе");
      }

      const errors:string[]=[];
      if(!obligation.inn) errors.push("Не указан ИНН");
      if(
        ["PAY","NOTIFY"].includes(obligation.obligation_type) &&
        obligation.amount_minor===null
      ) errors.push("Не подтверждена сумма");
      if(
        obligation.authority==="FNS" &&
        !obligation.source_url
      ) errors.push("Нет нормативного источника правила");

      const payload={
        schema:"corebiz.accounting.compliance/v1",
        authority:obligation.authority,
        obligation:{
          id:obligation.id,
          code:obligation.code,
          title:obligation.title,
          formCode:obligation.form_code,
          periodKey:obligation.period_key,
          dueAt:obligation.due_at,
          amountMinor:obligation.amount_minor,
          currency:obligation.currency
        },
        taxpayer:{
          inn:obligation.inn,
          kpp:obligation.kpp,
          oktmo:obligation.oktmo
        },
        regulatoryEvidence:{
          sourceUrl:obligation.source_url,
          effectiveAt:obligation.source_effective_at
        }
      };
      const checksum=createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      const packetKind=
        obligation.obligation_type==="NOTIFY"
          ?"FNS_NOTIFICATION"
          :obligation.obligation_type==="FILE"
            ?"FNS_DECLARATION"
            :obligation.obligation_type==="PAY"
              ?"PAYMENT_INSTRUCTION"
              :"RECONCILIATION";
      const validationStatus=errors.length?"INVALID":"REVIEW_REQUIRED";

      const packet=await client.query<any>(
        `INSERT INTO accounting_compliance_packet(
           tenant_id,legal_entity_id,obligation_id,packet_kind,format,
           form_code,schema_version,payload,checksum_sha256,
           validation_status,validation_errors,signature_status,
           created_by_membership_id
         ) VALUES(
           $1,$2,$3,$4,'JSON',$5,'corebiz-v1',$6,$7,$8,$9,'SIGNATURE_REQUIRED',$10
         )
         ON CONFLICT(tenant_id,obligation_id,packet_kind)
         DO UPDATE SET
           payload=EXCLUDED.payload,checksum_sha256=EXCLUDED.checksum_sha256,
           validation_status=EXCLUDED.validation_status,
           validation_errors=EXCLUDED.validation_errors,
           signature_status='SIGNATURE_REQUIRED',signed_at=NULL,
           signed_by_membership_id=NULL,updated_at=now()
         RETURNING *`,
        [
          context.tenantId,obligation.legal_entity_id,obligation.id,
          packetKind,obligation.form_code,JSON.stringify(payload),checksum,
          validationStatus,JSON.stringify(errors),context.membershipId
        ]
      );
      const row=packet.rows[0];

      await client.query(
        `UPDATE accounting_compliance_obligation
         SET packet_id=$3,workflow_status=CASE
               WHEN $4::text='INVALID' THEN workflow_status
               ELSE 'READY'
             END,
             review_note=CASE
               WHEN $4::text='INVALID' THEN $5
               ELSE review_note
             END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,obligation.id,row.id,validationStatus,
          errors.join("; ")||null
        ]
      );
      await this.event(
        client,context,obligation.id,"PACKET_PREPARED",
        obligation.workflow_status,
        validationStatus==="INVALID"?obligation.workflow_status:"READY",
        {packetId:row.id,validationStatus,errors}
      );
      return row;
    });
  }

  async validatePacket(
    context:TenantContext,
    obligationId:string,
    input:{note:string}
  ) {
    if(!input.note?.trim()||input.note.trim().length<8) {
      throw new BadRequestException("Укажите основание проверки документа");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<any>(
        `UPDATE accounting_compliance_packet p
         SET validation_status='VALID',validation_errors='[]'::jsonb,
             updated_at=now()
         FROM accounting_compliance_obligation o
         WHERE p.tenant_id=$1
           AND o.tenant_id=p.tenant_id
           AND o.id=$2
           AND p.id=o.packet_id
         RETURNING p.*`,
        [context.tenantId,obligationId]
      );
      if(!result.rows[0]) throw new NotFoundException("Пакет не найден");
      await client.query(
        `UPDATE accounting_compliance_obligation
         SET review_note=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,obligationId,input.note.trim()]
      );
      return result.rows[0];
    });
  }

  async approveObligation(
    context:TenantContext,
    obligationId:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const row=await client.query<any>(
        `SELECT o.workflow_status,o.calculation_status,
                p.validation_status
         FROM accounting_compliance_obligation o
         LEFT JOIN accounting_compliance_packet p
           ON p.tenant_id=o.tenant_id AND p.id=o.packet_id
         WHERE o.tenant_id=$1 AND o.id=$2
         FOR UPDATE OF o`,
        [context.tenantId,obligationId]
      );
      const current=row.rows[0];
      if(!current) throw new NotFoundException("Обязательство не найдено");
      if(current.workflow_status!=="READY") {
        throw new ConflictException("Документ ещё не готов к утверждению");
      }
      if(current.validation_status!=="VALID") {
        throw new ConflictException("Сначала подтвердите проверку пакета");
      }
      if(
        current.calculation_status!=="CONFIRMED" &&
        current.calculation_status!=="NOT_CALCULATED"
      ) {
        throw new ConflictException("Сначала подтвердите расчёт");
      }

      const updated=await client.query(
        `UPDATE accounting_compliance_obligation
         SET workflow_status='APPROVED',
             approved_by_membership_id=$3,approved_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [context.tenantId,obligationId,context.membershipId]
      );
      await this.event(
        client,context,obligationId,"APPROVED","READY","APPROVED",{}
      );
      return updated.rows[0];
    });
  }

  async connectors(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           id,provider,status,supports_filing,supports_receipts,
           certificate_fingerprint,certificate_valid_to,
           last_verified_at,last_error,metadata
         FROM accounting_reporting_connector
         WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY provider`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
    });
  }

  async saveConnector(
    context:TenantContext,
    input:{
      legalEntityId:string;
      provider:string;
      supportsFiling?:boolean;
      supportsReceipts?:boolean;
      status?:"DISCONNECTED"|"CONFIGURED"|"VERIFIED"|"DEGRADED"|"DISABLED";
      certificateFingerprint?:string;
      certificateValidTo?:string;
      metadata?:Record<string,unknown>;
    }
  ) {
    const provider=input.provider?.trim();
    if(!provider||provider.length>120) {
      throw new BadRequestException("Некорректный оператор");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `INSERT INTO accounting_reporting_connector(
           tenant_id,legal_entity_id,provider,status,
           supports_filing,supports_receipts,certificate_fingerprint,
           certificate_valid_to,metadata,last_verified_at
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,
           CASE WHEN $4='VERIFIED' THEN now() ELSE NULL END
         )
         ON CONFLICT(tenant_id,legal_entity_id,provider)
         DO UPDATE SET
           status=EXCLUDED.status,
           supports_filing=EXCLUDED.supports_filing,
           supports_receipts=EXCLUDED.supports_receipts,
           certificate_fingerprint=EXCLUDED.certificate_fingerprint,
           certificate_valid_to=EXCLUDED.certificate_valid_to,
           metadata=EXCLUDED.metadata,
           last_verified_at=CASE
             WHEN EXCLUDED.status='VERIFIED' THEN now()
             ELSE accounting_reporting_connector.last_verified_at
           END,
           updated_at=now()
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,provider,
          input.status??"CONFIGURED",Boolean(input.supportsFiling),
          Boolean(input.supportsReceipts),
          input.certificateFingerprint?.trim()||null,
          input.certificateValidTo??null,
          JSON.stringify(input.metadata??{})
        ]
      );
      return result.rows[0];
    });
  }

  async recordSubmitted(
    context:TenantContext,
    obligationId:string,
    input:{provider:string;externalReference:string}
  ) {
    if(!input.provider?.trim()||!input.externalReference?.trim()) {
      throw new BadRequestException("Нужны оператор и идентификатор отправки");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const current=await client.query<any>(
        `SELECT o.workflow_status,o.legal_entity_id,p.signature_status
         FROM accounting_compliance_obligation o
         LEFT JOIN accounting_compliance_packet p
           ON p.tenant_id=o.tenant_id AND p.id=o.packet_id
         WHERE o.tenant_id=$1 AND o.id=$2
         FOR UPDATE OF o`,
        [context.tenantId,obligationId]
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException("Обязательство не найдено");
      if(row.workflow_status!=="APPROVED") {
        throw new ConflictException("Отправка возможна только после утверждения");
      }
      const connector=await client.query(
        `SELECT 1
         FROM accounting_reporting_connector
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND provider=$3 AND status='VERIFIED'
           AND supports_filing=true`,
        [context.tenantId,row.legal_entity_id,input.provider.trim()]
      );
      if(!connector.rowCount) {
        throw new ConflictException("Оператор не проверен или не поддерживает отправку");
      }

      const updated=await client.query(
        `UPDATE accounting_compliance_obligation
         SET workflow_status='SUBMITTED',external_provider=$3,
             external_reference=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [
          context.tenantId,obligationId,input.provider.trim(),
          input.externalReference.trim()
        ]
      );
      await client.query(
        `INSERT INTO accounting_compliance_receipt(
           tenant_id,obligation_id,provider,external_reference,receipt_type,payload
         ) VALUES($1,$2,$3,$4,'SENT',$5)
         ON CONFLICT DO NOTHING`,
        [
          context.tenantId,obligationId,input.provider.trim(),
          input.externalReference.trim(),
          JSON.stringify({recordedBy:context.membershipId})
        ]
      );
      await this.event(
        client,context,obligationId,"SUBMITTED","APPROVED","SUBMITTED",
        {provider:input.provider,externalReference:input.externalReference}
      );
      return updated.rows[0];
    });
  }

  async recordReceipt(
    context:TenantContext,
    obligationId:string,
    input:{
      provider:string;
      externalReference:string;
      receiptType:"DELIVERED"|"ACCEPTED"|"REJECTED"|"CLARIFICATION"|"PAYMENT";
      payload?:Record<string,unknown>;
    }
  ) {
    if(![
      "DELIVERED","ACCEPTED","REJECTED","CLARIFICATION","PAYMENT"
    ].includes(input.receiptType)) {
      throw new BadRequestException("Некорректный тип квитанции");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const current=await client.query<{workflow_status:string}>(
        `SELECT workflow_status
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,obligationId]
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException("Обязательство не найдено");

      await client.query(
        `INSERT INTO accounting_compliance_receipt(
           tenant_id,obligation_id,provider,external_reference,receipt_type,payload
         ) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [
          context.tenantId,obligationId,input.provider.trim(),
          input.externalReference.trim(),input.receiptType,
          JSON.stringify(input.payload??{})
        ]
      );

      let next=row.workflow_status;
      if(input.receiptType==="ACCEPTED") next="ACCEPTED";
      if(input.receiptType==="REJECTED") next="REJECTED";
      if(input.receiptType==="PAYMENT") next="PAID";

      if(next!==row.workflow_status) {
        await client.query(
          `UPDATE accounting_compliance_obligation
           SET workflow_status=$3,
               completed_at=CASE
                 WHEN $3 IN ('ACCEPTED','PAID') THEN now()
                 ELSE completed_at
               END,
               rejection_reason=CASE
                 WHEN $3='REJECTED' THEN $4
                 ELSE rejection_reason
               END,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,obligationId,next,
            input.receiptType==="REJECTED"
              ?String(input.payload?.reason??"Отклонено оператором/ФНС")
              :null
          ]
        );
        await this.event(
          client,context,obligationId,"RECEIPT_"+input.receiptType,
          row.workflow_status,next,input.payload??{}
        );
      }
      return {status:next};
    });
  }

  async ensSnapshots(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT *
         FROM accounting_ens_snapshot
         WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY as_of DESC
         LIMIT 100`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
    });
  }

  async addEnsSnapshot(
    context:TenantContext,
    input:{
      legalEntityId:string;
      balanceMinor:string;
      source?:"MANUAL"|"FNS_LK"|"REPORTING_OPERATOR"|"IMPORT";
      externalReference?:string;
      details?:Record<string,unknown>;
    }
  ) {
    if(!/^-?\d+$/.test(input.balanceMinor)) {
      throw new BadRequestException("Некорректный баланс ЕНС");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `INSERT INTO accounting_ens_snapshot(
           tenant_id,legal_entity_id,balance_minor,source,
           external_reference,details,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,input.balanceMinor,
          input.source??"MANUAL",input.externalReference?.trim()||null,
          JSON.stringify(input.details??{}),context.membershipId
        ]
      );
      return result.rows[0];
    });
  }

  private ruleMatches(rule:any,profile:any) {
    if(rule.entity_kind&&rule.entity_kind!==profile.entity_kind) return false;
    if(
      rule.requires_employees!==null &&
      rule.requires_employees!==profile.has_employees
    ) return false;
    if(rule.tax_regime) {
      const matchesUsn=
        rule.tax_regime==="USN" &&
        String(profile.tax_regime).startsWith("USN_");
      if(!matchesUsn&&rule.tax_regime!==profile.tax_regime) return false;
    }
    if(rule.vat_mode) {
      const matchesVatRequired=
        rule.vat_mode==="VAT_REQUIRED" &&
        profile.vat_mode!=="NO_VAT";
      if(!matchesVatRequired&&rule.vat_mode!==profile.vat_mode) return false;
    }
    if(rule.code==="ENS_NOTIFICATION"&&!profile.ens_enabled) return false;
    return true;
  }

  private expandDueDates(rule:any,from:Date,to:Date) {
    const out:Array<{
      dueAt:Date;
      periodKey:string;
      weekendShiftApplied:boolean;
    }>=[];
    const dueRule=rule.due_rule??{};
    const years=new Set<number>();
    for(let y=from.getUTCFullYear();y<=to.getUTCFullYear();y++) years.add(y);

    const push=(date:Date,periodKey:string)=>{
      const shifted=this.shiftWeekend(date);
      if(shifted.date>=from&&shifted.date<=to) {
        out.push({
          dueAt:shifted.date,
          periodKey,
          weekendShiftApplied:shifted.shifted
        });
      }
    };

    if(rule.cadence==="ANNUAL") {
      for(const year of years) {
        if(!dueRule.month||!dueRule.day) continue;
        push(
          new Date(Date.UTC(year,dueRule.month-1,dueRule.day,9,0,0)),
          String(year-1)
        );
      }
    } else if(rule.cadence==="QUARTERLY") {
      const months:Array<number>=dueRule.months??[4,7,10,1];
      for(const year of years) {
        for(const month of months) {
          const actualYear=month===1?year+1:year;
          const q=month===4?1:month===7?2:month===10?3:4;
          push(
            new Date(Date.UTC(actualYear,month-1,dueRule.day??25,9,0,0)),
            String(month===1?year:year)+"-Q"+q
          );
        }
      }
    } else if(rule.cadence==="MONTHLY"||rule.cadence==="SEMI_MONTHLY") {
      const cursor=new Date(Date.UTC(
        from.getUTCFullYear(),from.getUTCMonth(),1,9,0,0
      ));
      const last=new Date(Date.UTC(
        to.getUTCFullYear(),to.getUTCMonth(),1,9,0,0
      ));
      while(cursor<=last) {
        const y=cursor.getUTCFullYear();
        const m=cursor.getUTCMonth();
        const periodKey=
          y+"-"+String(m+1).padStart(2,"0")+
          (String(rule.code).includes("23_EOM")?"-23_EOM":
           String(rule.code).includes("1_22")?"-1_22":"");
        if(dueRule.next_month_day) {
          push(
            new Date(Date.UTC(y,m+1,dueRule.next_month_day,9,0,0)),
            periodKey
          );
        } else {
          push(
            new Date(Date.UTC(y,m,dueRule.day??25,9,0,0)),
            periodKey
          );
        }
        cursor.setUTCMonth(cursor.getUTCMonth()+1);
      }
    }
    return out;
  }

  private shiftWeekend(date:Date) {
    const result=new Date(date);
    let shifted=false;
    while(result.getUTCDay()===0||result.getUTCDay()===6) {
      result.setUTCDate(result.getUTCDate()+1);
      shifted=true;
    }
    return {date:result,shifted};
  }

  private async event(
    client:any,
    context:TenantContext,
    obligationId:string,
    eventType:string,
    previousStatus:string|null,
    newStatus:string|null,
    payload:Record<string,unknown>
  ) {
    await client.query(
      `INSERT INTO accounting_compliance_event(
         tenant_id,obligation_id,event_type,actor_membership_id,
         previous_status,new_status,payload
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,obligationId,eventType,context.membershipId,
        previousStatus,newStatus,JSON.stringify(payload)
      ]
    );
  }
}
