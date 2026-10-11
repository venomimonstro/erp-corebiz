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
  | "NPD"
  | "USN_INCOME"
  | "USN_INCOME_EXPENSE"
  | "OSNO"
  | "AUSN"
  | "OTHER";

type VatMode = "NO_VAT" | "VAT_5" | "VAT_7" | "VAT_22" | "VAT_MIXED";

type TaxProfileInput = {
  legalEntityId:string;
  entityKind:"ORGANIZATION"|"IP"|"INDIVIDUAL";
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
  complianceEnabled?:boolean;
  complianceDisabledReason?:string;
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
    if(!["ORGANIZATION","IP","INDIVIDUAL"].includes(input.entityKind)) {
      throw new BadRequestException("Некорректный тип налогоплательщика");
    }
    if(![
      "NPD","USN_INCOME","USN_INCOME_EXPENSE","OSNO","AUSN","OTHER"
    ].includes(input.taxRegime)) {
      throw new BadRequestException("Некорректный налоговый режим");
    }
    if(input.taxRegime==="NPD"){
      if(!["IP","INDIVIDUAL"].includes(input.entityKind)){
        throw new BadRequestException("НПД доступен только физлицу или ИП");
      }
      if(input.hasEmployees){
        throw new BadRequestException("НПД нельзя использовать с наёмными сотрудниками");
      }
    }
    const vatMode=input.taxRegime==="NPD"?"NO_VAT":(input.vatMode??"NO_VAT");
    if(!["NO_VAT","VAT_5","VAT_7","VAT_22","VAT_MIXED"].includes(vatMode)) {
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
      await client.query(
        `UPDATE legal_entity
         SET taxpayer_kind=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,input.legalEntityId,input.entityKind]
      );

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
                compliance_enabled=$15,compliance_disabled_reason=$16,
                compliance_disabled_by_membership_id=CASE
                  WHEN $15::boolean THEN NULL ELSE $19
                END,
                usn_rate_bps=$17,usn_min_tax_bps=$18,
                updated_by_membership_id=$19,updated_at=now()
           WHERE tenant_id=$1 AND id=$2
           RETURNING *`,
          [
            context.tenantId,existing.id,input.entityKind,input.taxRegime,
            vatMode,Boolean(input.hasEmployees),input.taxRegionCode?.trim()||null,
            input.taxOfficeCode?.trim()||null,input.ensEnabled!==false,
            input.okvedPrimary?.trim()||null,input.kpp?.trim()||null,
            input.oktmo?.trim()||null,input.reportingMode??"ASSISTED",
            input.riskTolerance??"CONSERVATIVE",
            input.complianceEnabled!==false,
            input.complianceEnabled===false
              ?(input.complianceDisabledReason?.trim()||
                "Налоговый контур отключён владельцем")
              :null,
            input.usnRateBps??null,input.usnMinimumTaxBps??null,
            context.membershipId
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
           compliance_enabled,compliance_disabled_reason,
           compliance_disabled_by_membership_id,
           usn_rate_bps,usn_min_tax_bps,effective_from,
           created_by_membership_id,updated_by_membership_id
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20,$21,$21
         )
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,input.entityKind,input.taxRegime,
          vatMode,Boolean(input.hasEmployees),input.taxRegionCode?.trim()||null,
          input.taxOfficeCode?.trim()||null,input.ensEnabled!==false,
          input.okvedPrimary?.trim()||null,input.kpp?.trim()||null,
          input.oktmo?.trim()||null,input.reportingMode??"ASSISTED",
          input.riskTolerance??"CONSERVATIVE",
          input.complianceEnabled!==false,
          input.complianceEnabled===false
            ?(input.complianceDisabledReason?.trim()||
              "Налоговый контур отключён владельцем")
            :null,
          input.complianceEnabled===false?context.membershipId:null,
          input.usnRateBps??null,input.usnMinimumTaxBps??null,
          effectiveFrom,context.membershipId
        ]
      );
      return created.rows[0];
    });
  }

  async overview(
    context:TenantContext,
    legalEntityId:string
  ){
    if(!legalEntityId){
      throw new BadRequestException("Выберите налогоплательщика");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const profileResult=await client.query<any>(
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
      const profile=profileResult.rows[0]??null;

      const obligations=await client.query<any>(
        `SELECT
           o.*,
           coalesce(r.form_code,o.code) AS form_code,
           r.source_url,
           p.validation_status AS packet_validation_status,
           p.signature_status AS packet_signature_status,
           CASE
             WHEN o.workflow_status IN ('ACCEPTED','PAID','CANCELLED')
               THEN 'DONE'
             WHEN o.due_at<now() THEN 'OVERDUE'
             WHEN o.due_at<=now()+interval '7 days' THEN 'URGENT'
             WHEN o.due_at<=now()+interval '30 days' THEN 'UPCOMING'
             ELSE 'LATER'
           END AS urgency,
           coalesce(
             o.calculation_snapshot->>'verificationNote',
             o.source_snapshot->>'reviewNote'
           ) AS review_note,
           o.packet_id
         FROM accounting_compliance_obligation o
         LEFT JOIN accounting_regulatory_rule r ON r.id=o.rule_id
         LEFT JOIN accounting_compliance_packet p
           ON p.tenant_id=o.tenant_id AND p.id=o.packet_id
         WHERE o.tenant_id=$1 AND o.legal_entity_id=$2
         ORDER BY
           CASE
             WHEN o.workflow_status IN ('ACCEPTED','PAID','CANCELLED') THEN 1
             ELSE 0
           END,
           o.due_at,o.created_at`,
        [context.tenantId,legalEntityId]
      );

      const connectors=await client.query(
        `SELECT
           id,provider,status,supports_filing,supports_receipts,
           certificate_valid_to,last_verified_at,last_error
         FROM accounting_reporting_connector
         WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY
           CASE status WHEN 'VERIFIED' THEN 0 WHEN 'CONFIGURED' THEN 1 ELSE 2 END,
           provider`,
        [context.tenantId,legalEntityId]
      );

      const counts:Record<string,number>={};
      for(const row of obligations.rows){
        counts[row.urgency]=(counts[row.urgency]??0)+1;
      }
      return {
        profile,
        counts,
        obligations:obligations.rows,
        connectors:connectors.rows
      };
    });
  }

  async npdOverview(
    context:TenantContext,
    legalEntityId:string,
    year:number
  ){
    if(!Number.isSafeInteger(year)||year<2024||year>2100){
      throw new BadRequestException("Некорректный год");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query<any>(
        `SELECT *
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status='ACTIVE' AND tax_regime='NPD'
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      const p=profile.rows[0];
      if(!p) throw new ConflictException("Для этого налогоплательщика НПД не настроен");
      if(!["IP","INDIVIDUAL"].includes(p.entity_kind)){
        throw new ConflictException("НПД доступен только физлицу или ИП");
      }

      const totals=await client.query<any>(
        `SELECT
           coalesce(sum(amount_minor) FILTER (
             WHERE fiscal_status='REGISTERED'
               AND buyer_kind='PERSON'
           ),0)::text AS person_income_minor,
           coalesce(sum(amount_minor) FILTER (
             WHERE fiscal_status='REGISTERED'
               AND buyer_kind IN ('ORGANIZATION','IP')
           ),0)::text AS business_income_minor,
           coalesce(sum(amount_minor) FILTER (
             WHERE fiscal_status='REGISTERED'
           ),0)::text AS year_income_minor,
           coalesce(sum(calculated_tax_minor) FILTER (
             WHERE fiscal_status='REGISTERED'
           ),0)::text AS estimated_tax_minor,
           count(*) FILTER (
             WHERE fiscal_status='DRAFT'
           )::integer AS draft_receipts,
           count(*) FILTER (
             WHERE fiscal_status='ERROR'
           )::integer AS error_receipts
         FROM accounting_npd_receipt
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND operation_date>=make_date($3,1,1)
           AND operation_date<make_date($3+1,1,1)`,
        [context.tenantId,legalEntityId,year]
      );

      const months=await client.query(
        `SELECT
           period_key,date_from,date_to,
           person_income_minor::text,business_income_minor::text,
           gross_income_minor::text,estimated_tax_minor::text,
           official_tax_minor::text,benefit_minor::text,
           payable_minor::text,source,status
         FROM accounting_npd_month
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND date_from>=make_date($3,1,1)
           AND date_from<make_date($3+1,1,1)
           AND status<>'SUPERSEDED'
         ORDER BY date_from`,
        [context.tenantId,legalEntityId,year]
      );

      const receipts=await client.query(
        `SELECT
           r.id,r.operation_date,r.buyer_kind,r.description,
           r.amount_minor::text,r.tax_rate_bps,
           r.calculated_tax_minor::text,r.fiscal_status,
           r.external_receipt_id,r.external_receipt_url,r.registered_at,
           r.cancellation_reason,p.display_name AS buyer_name
         FROM accounting_npd_receipt r
         LEFT JOIN party p
           ON p.tenant_id=r.tenant_id AND p.id=r.buyer_party_id
         WHERE r.tenant_id=$1 AND r.legal_entity_id=$2
           AND r.operation_date>=make_date($3,1,1)
           AND r.operation_date<make_date($3+1,1,1)
         ORDER BY r.operation_date DESC,r.created_at DESC
         LIMIT 500`,
        [context.tenantId,legalEntityId,year]
      );

      const row=totals.rows[0]??{};
      const limitMinor="240000000";
      return {
        profile:p,
        totals:{
          ...row,
          annual_limit_minor:limitMinor,
          remaining_limit_minor:(
            240000000n-BigInt(row.year_income_minor??"0")>0n
              ?240000000n-BigInt(row.year_income_minor??"0")
              :0n
          ).toString()
        },
        months:months.rows,
        receipts:receipts.rows
      };
    });
  }

  async registerNpdReceipt(
    context:TenantContext,
    input:{
      legalEntityId:string;
      operationDate:string;
      buyerKind:"PERSON"|"ORGANIZATION"|"IP";
      buyerPartyId?:string;
      description:string;
      amountMinor:string;
      sourceType?:string;
      sourceId?:string;
    }
  ){
    const operationDate=new Date(input.operationDate);
    if(Number.isNaN(operationDate.getTime())){
      throw new BadRequestException("Некорректная дата дохода");
    }
    if(!["PERSON","ORGANIZATION","IP"].includes(input.buyerKind)){
      throw new BadRequestException("Некорректный тип покупателя");
    }
    if(!/^\d+$/.test(input.amountMinor)||BigInt(input.amountMinor)<=0n){
      throw new BadRequestException("Некорректная сумма дохода");
    }
    if(!input.description?.trim()){
      throw new BadRequestException("Укажите наименование услуги или товара");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query<any>(
        `SELECT id,entity_kind
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status='ACTIVE' AND tax_regime='NPD'
           AND effective_from<=($3::timestamptz)::date
           AND (effective_to IS NULL OR effective_to>=($3::timestamptz)::date)
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,input.legalEntityId,operationDate]
      );
      const p=profile.rows[0];
      if(!p) throw new ConflictException("На дату дохода нет активного профиля НПД");
      if(!["IP","INDIVIDUAL"].includes(p.entity_kind)){
        throw new ConflictException("НПД доступен только физлицу или ИП");
      }

      const rate=input.buyerKind==="PERSON"?400:600;
      const amount=BigInt(input.amountMinor);
      const tax=(amount*BigInt(rate))/10000n;
      const result=await client.query(
        `INSERT INTO accounting_npd_receipt(
           tenant_id,legal_entity_id,tax_profile_id,
           source_type,source_id,operation_date,buyer_kind,buyer_party_id,
           description,amount_minor,tax_rate_bps,calculated_tax_minor,
           created_by_membership_id
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
         )
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,p.id,
          input.sourceType?.trim()||"MANUAL",
          input.sourceId??null,operationDate,input.buyerKind,
          input.buyerPartyId??null,input.description.trim(),
          input.amountMinor,rate,tax.toString(),context.membershipId
        ]
      );
      return result.rows[0];
    });
  }

  async confirmNpdReceipt(
    context:TenantContext,
    receiptId:string,
    input:{
      externalReceiptId:string;
      externalReceiptUrl?:string;
      connectorProvider?:string;
    }
  ){
    if(!input.externalReceiptId?.trim()){
      throw new BadRequestException("Укажите номер чека из «Мой налог»");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE accounting_npd_receipt
         SET fiscal_status='REGISTERED',
             external_receipt_id=$3,
             external_receipt_url=$4,
             connector_provider=$5,
             registered_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2
           AND fiscal_status IN ('DRAFT','READY','ERROR')
         RETURNING *`,
        [
          context.tenantId,receiptId,input.externalReceiptId.trim(),
          input.externalReceiptUrl?.trim()||null,
          input.connectorProvider?.trim()||"MANUAL"
        ]
      );
      if(!result.rows[0]) throw new NotFoundException("Чек НПД не найден или уже закрыт");
      return result.rows[0];
    });
  }

  async rebuildNpdMonths(
    context:TenantContext,
    legalEntityId:string,
    year:number
  ){
    if(!Number.isSafeInteger(year)||year<2024||year>2100){
      throw new BadRequestException("Некорректный год");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query<{id:string}>(
        `SELECT id FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status='ACTIVE' AND tax_regime='NPD'
         ORDER BY effective_from DESC LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      const profileId=profile.rows[0]?.id;
      if(!profileId) throw new ConflictException("НПД не настроен");

      let rebuilt=0;
      for(let month=1;month<=12;month++){
        const from=`${year}-${String(month).padStart(2,"0")}-01`;
        const next=month===12
          ?`${year+1}-01-01`
          :`${year}-${String(month+1).padStart(2,"0")}-01`;
        const totals=await client.query<any>(
          `SELECT
             coalesce(sum(amount_minor) FILTER (
               WHERE buyer_kind='PERSON' AND fiscal_status='REGISTERED'
             ),0)::bigint AS person_income,
             coalesce(sum(amount_minor) FILTER (
               WHERE buyer_kind IN ('ORGANIZATION','IP')
                 AND fiscal_status='REGISTERED'
             ),0)::bigint AS business_income,
             coalesce(sum(calculated_tax_minor) FILTER (
               WHERE fiscal_status='REGISTERED'
             ),0)::bigint AS tax
           FROM accounting_npd_receipt
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND operation_date>=$3::date
             AND operation_date<$4::date`,
          [context.tenantId,legalEntityId,from,next]
        );
        const t=totals.rows[0];
        const person=BigInt(t?.person_income??0);
        const business=BigInt(t?.business_income??0);
        const tax=BigInt(t?.tax??0);
        await client.query(
          `UPDATE accounting_npd_month
           SET status='SUPERSEDED',updated_at=now()
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND period_key=$3 AND status='ESTIMATED'`,
          [context.tenantId,legalEntityId,`${year}-${String(month).padStart(2,"0")}`]
        );
        await client.query(
          `INSERT INTO accounting_npd_month(
             tenant_id,legal_entity_id,tax_profile_id,period_key,
             date_from,date_to,person_income_minor,business_income_minor,
             gross_income_minor,estimated_tax_minor,payable_minor,
             calculation_snapshot
           ) VALUES(
             $1,$2,$3,$4,$5::date,($6::date-1),
             $7,$8,$9,$10,$10,$11
           )`,
          [
            context.tenantId,legalEntityId,profileId,
            `${year}-${String(month).padStart(2,"0")}`,
            from,next,person.toString(),business.toString(),
            (person+business).toString(),tax.toString(),
            JSON.stringify({rates:{personBps:400,businessBps:600}})
          ]
        );
        rebuilt++;
      }
      return {rebuilt};
    });
  }

  async cashAccounts(
    context:TenantContext,
    legalEntityId:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        `SELECT 1 FROM legal_entity
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,legalEntityId]
      );
      if(!entity.rowCount) throw new NotFoundException("Юридическое лицо не найдено");

      const result=await client.query(
        `SELECT
           id,name,kind,currency,opening_balance_minor::text,status,is_default,
           legal_entity_id,
           CASE
             WHEN legal_entity_id=$2::uuid THEN 'THIS_ENTITY'
             WHEN legal_entity_id IS NULL THEN 'UNASSIGNED'
             ELSE 'OTHER_ENTITY'
           END AS assignment_state
         FROM cash_account
         WHERE tenant_id=$1 AND status='ACTIVE'
         ORDER BY
           CASE
             WHEN legal_entity_id=$2::uuid THEN 0
             WHEN legal_entity_id IS NULL THEN 1
             ELSE 2
           END,
           is_default DESC,name`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
    });
  }

  async assignCashAccount(
    context:TenantContext,
    cashAccountId:string,
    input:{legalEntityId:string|null}
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      if(input.legalEntityId) {
        const entity=await client.query(
          `SELECT 1 FROM legal_entity
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.legalEntityId]
        );
        if(!entity.rowCount) {
          throw new NotFoundException("Юридическое лицо не найдено");
        }
      }

      const result=await client.query(
        `UPDATE cash_account
         SET legal_entity_id=$3::uuid,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
         RETURNING
           id,name,kind,currency,opening_balance_minor::text,
           legal_entity_id,is_default`,
        [context.tenantId,cashAccountId,input.legalEntityId]
      );
      if(!result.rows[0]) throw new NotFoundException("Денежный счёт не найден");
      return result.rows[0];
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
      obligationId?:string;
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

      if(input.obligationId) {
        const obligation=await client.query(
          `SELECT 1
           FROM accounting_compliance_obligation
           WHERE tenant_id=$1 AND id=$2 AND legal_entity_id=$3
             AND obligation_type IN ('PAY','NOTIFY')
             AND workflow_status IN ('PLANNED','READY')`,
          [context.tenantId,input.obligationId,input.legalEntityId]
        );
        if(!obligation.rowCount) {
          throw new ConflictException("Налоговое обязательство недоступно для расчёта");
        }
      }

      const totals=await client.query<{
        income:string;
        expense:string;
        review_count:number;
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
      const mainTax=(base*BigInt(profile.usn_rate_bps)+9999n)/10000n;
      let calculated=mainTax;
      let minimumTax=0n;

      if(
        profile.tax_regime==="USN_INCOME_EXPENSE" &&
        input.calculationType==="USN_ANNUAL"
      ) {
        const minimumRate=BigInt(
          profile.usn_min_tax_bps ?? profile.usn_min_rate_bps ?? 100
        );
        minimumTax=(income*minimumRate+9999n)/10000n;
        if(minimumTax>calculated) calculated=minimumTax;
      }

      const finalPreview=calculated>reductions?calculated-reductions:0n;
      const status=totalsRow.review_count>0?"REVIEW_REQUIRED":"DRAFT";
      const periodKey=
        input.calculationType==="USN_ANNUAL"
          ?input.periodFrom.slice(0,4)
          :input.periodFrom+"_"+input.periodTo;

      await client.query(
        `UPDATE accounting_tax_calculation
         SET status='SUPERSEDED',updated_at=now()
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND tax_code='USN' AND period_key=$3
           AND status IN ('DRAFT','REVIEW_REQUIRED')`,
        [context.tenantId,input.legalEntityId,periodKey]
      );

      const result=await client.query<any>(
        `INSERT INTO accounting_tax_calculation(
           tenant_id,legal_entity_id,tax_profile_id,tax_code,period_key,
           date_from,date_to,taxable_income_minor,deductible_expense_minor,
           taxable_base_minor,calculated_tax_minor,advances_minor,tax_due_minor,
           calculation_method,rule_snapshot,source_snapshot,status
         ) VALUES(
           $1,$2,$3,'USN',$4,$5,$6,$7,$8,$9,$10,$11,$12,
           'AUDITED_TAX_LEDGER',$13,$14,$15
         )
         RETURNING *`,
        [
          context.tenantId,input.legalEntityId,profile.id,periodKey,
          input.periodFrom,input.periodTo,income.toString(),expense.toString(),
          base.toString(),calculated.toString(),reductions.toString(),
          finalPreview.toString(),
          JSON.stringify({
            taxRegime:profile.tax_regime,
            rateBps:profile.usn_rate_bps,
            minimumTaxMinor:minimumTax.toString()
          }),
          JSON.stringify({
            reviewRequiredCount:totalsRow.review_count,
            obligationId:input.obligationId??null,
            note:
              "Предварительный расчёт до подтверждения налоговой книги, льгот, переносов убытков и специальных уменьшений."
          }),
          status
        ]
      );
      return {
        ...result.rows[0],
        obligation_id:input.obligationId??null
      };
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
      const calculation=await client.query<any>(
        `SELECT *
         FROM accounting_tax_calculation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,calculationId]
      );
      const current=calculation.rows[0];
      if(!current) throw new NotFoundException("Расчёт не найден");
      if(!["DRAFT","REVIEW_REQUIRED"].includes(current.status)) {
        throw new ConflictException("Расчёт уже подтверждён или заменён");
      }
      const reviewCount=Number(
        current.source_snapshot?.reviewRequiredCount??0
      );
      if(reviewCount>0) {
        throw new ConflictException(
          "В налоговой книге остались операции, требующие проверки"
        );
      }

      const updated=await client.query<any>(
        `UPDATE accounting_tax_calculation
         SET status='CONFIRMED',confirmed_by_membership_id=$3,
             confirmed_at=now(),
             source_snapshot=source_snapshot ||
               jsonb_build_object('verificationNote',$4),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [
          context.tenantId,calculationId,context.membershipId,
          input.note.trim()
        ]
      );
      const row=updated.rows[0];

      if(input.obligationId) {
        const obligation=await client.query<any>(
          `UPDATE accounting_compliance_obligation
           SET amount_minor=$4,calculation_status='CONFIRMED',
               calculation_snapshot=$5,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND legal_entity_id=$3
             AND workflow_status IN ('PLANNED','READY')
           RETURNING
             id,obligation_type,due_at,currency,payment_obligation_id`,
          [
            context.tenantId,input.obligationId,row.legal_entity_id,
            row.tax_due_minor,
            JSON.stringify({
              taxCalculationId:row.id,
              taxCode:row.tax_code,
              periodKey:row.period_key,
              verifiedBy:context.membershipId,
              verifiedAt:new Date().toISOString()
            })
          ]
        );
        const linked=obligation.rows[0];
        if(!linked) {
          throw new ConflictException(
            "Не удалось связать расчёт с налоговым обязательством"
          );
        }

        if(linked.obligation_type==="PAY"){
          const payable=await client.query<{id:string}>(
            `INSERT INTO financial_obligation(
               tenant_id,direction,party_id,source_type,source_id,
               currency,amount_minor,due_at,status
             ) VALUES(
               $1,'PAYABLE',NULL,'ACCOUNTING_COMPLIANCE',$2,$3,$4,$5,'OPEN'
             )
             ON CONFLICT(tenant_id,direction,source_type,source_id)
             DO UPDATE SET
               currency=EXCLUDED.currency,
               amount_minor=EXCLUDED.amount_minor,
               due_at=EXCLUDED.due_at,
               status=CASE
                 WHEN financial_obligation.settled_minor>=EXCLUDED.amount_minor
                   THEN 'SETTLED'
                 WHEN financial_obligation.settled_minor>0
                   THEN 'PARTIALLY_SETTLED'
                 ELSE 'OPEN'
               END,
               updated_at=now()
             RETURNING id`,
            [
              context.tenantId,linked.id,linked.currency,
              row.tax_due_minor,linked.due_at
            ]
          );
          const paymentObligationId=payable.rows[0]?.id;
          if(!paymentObligationId){
            throw new Error("ACCOUNTING_TAX_PAYABLE_CREATE_FAILED");
          }
          await client.query(
            `UPDATE accounting_compliance_obligation
             SET payment_obligation_id=$3,updated_at=now()
             WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId,linked.id,paymentObligationId]
          );
        }
      }
      return row;
    });
  }

  async calculations(
    context:TenantContext,
    legalEntityId:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           c.id,c.tax_code,c.period_key,c.date_from,c.date_to,
           c.taxable_income_minor::text,c.deductible_expense_minor::text,
           c.taxable_base_minor::text,c.calculated_tax_minor::text,
           c.advances_minor::text,c.tax_due_minor::text,
           c.calculation_method,c.rule_snapshot,c.source_snapshot,
           c.status,c.confirmed_at,c.created_at
         FROM accounting_tax_calculation c
         WHERE c.tenant_id=$1
           AND c.legal_entity_id=$2
           AND c.status<>'SUPERSEDED'
         ORDER BY c.date_to DESC,c.created_at DESC
         LIMIT 24`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
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
      if(profile.compliance_enabled===false) {
        throw new ConflictException(
          "Налоговый контур выключен. Включите его в профиле, чтобы формировать регламентный календарь"
        );
      }

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

  async complianceLines(
    context:TenantContext,
    obligationId:string
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const exists=await client.query(
        `SELECT 1 FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,obligationId]
      );
      if(!exists.rowCount) throw new NotFoundException("Обязательство не найдено");
      const result=await client.query(
        `SELECT
           id,line_number,kpp,oktmo,kbk,tax_period_code,reporting_year,
           amount_minor::text,source,status,metadata,confirmed_at
         FROM accounting_compliance_line
         WHERE tenant_id=$1 AND obligation_id=$2
         ORDER BY line_number`,
        [context.tenantId,obligationId]
      );
      return result.rows;
    });
  }

  async saveComplianceLine(
    context:TenantContext,
    obligationId:string,
    input:{
      lineNumber?:number;
      kpp?:string;
      oktmo?:string;
      kbk?:string;
      taxPeriodCode?:string;
      reportingYear?:number;
      amountMinor:string;
      confirm?:boolean;
    }
  ) {
    const lineNumber=Math.floor(input.lineNumber??1);
    const kpp=input.kpp?.trim()||null;
    const oktmo=input.oktmo?.trim()||null;
    const kbk=input.kbk?.trim()||null;
    const taxPeriodCode=input.taxPeriodCode?.trim()||null;
    const reportingYear=input.reportingYear===undefined
      ?null
      :Math.floor(input.reportingYear);

    if(lineNumber<1||lineNumber>999) {
      throw new BadRequestException("Некорректный номер строки");
    }
    if(kpp&&!/^\d{9}$/.test(kpp)) {
      throw new BadRequestException("КПП должен содержать 9 цифр");
    }
    if(oktmo&&!/^(?:\d{8}|\d{11})$/.test(oktmo)) {
      throw new BadRequestException("ОКТМО должен содержать 8 или 11 цифр");
    }
    if(kbk&&!/^\d{20}$/.test(kbk)) {
      throw new BadRequestException("КБК должен содержать 20 цифр");
    }
    if(taxPeriodCode&&!/^\d{2}\/\d{2}$/.test(taxPeriodCode)) {
      throw new BadRequestException("Код периода укажите в формате 00/00");
    }
    if(
      reportingYear!==null &&
      (reportingYear<2000||reportingYear>2100)
    ) {
      throw new BadRequestException("Некорректный отчётный год");
    }
    if(!/^\d+$/.test(input.amountMinor??"")) {
      throw new BadRequestException("Некорректная сумма строки");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const obligationResult=await client.query<any>(
        `SELECT
           o.id,o.form_code,o.workflow_status,o.legal_entity_id,
           p.entity_kind,coalesce(p.kpp,le.kpp) AS profile_kpp,p.oktmo
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
      if(
        !["PLANNED","READY","REJECTED"].includes(
          obligation.workflow_status
        )
      ) {
        throw new ConflictException(
          "Строки нельзя менять после утверждения документа"
        );
      }

      const effectiveKpp=kpp??obligation.profile_kpp??null;
      const effectiveOktmo=oktmo??obligation.oktmo??null;
      if(input.confirm){
        if(!effectiveOktmo||!kbk||!taxPeriodCode||reportingYear===null) {
          throw new BadRequestException(
            "Для подтверждения заполните ОКТМО, КБК, период и год"
          );
        }
        if(
          obligation.entity_kind==="ORGANIZATION" &&
          !effectiveKpp
        ) {
          throw new BadRequestException("Для организации укажите КПП");
        }
      }

      const result=await client.query<any>(
        `INSERT INTO accounting_compliance_line(
           tenant_id,obligation_id,line_number,kpp,oktmo,kbk,
           tax_period_code,reporting_year,amount_minor,source,status,
           confirmed_by_membership_id,confirmed_at
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL',$10,
           CASE WHEN $10='CONFIRMED' THEN $11::uuid ELSE NULL END,
           CASE WHEN $10='CONFIRMED' THEN now() ELSE NULL END
         )
         ON CONFLICT(tenant_id,obligation_id,line_number)
         DO UPDATE SET
           kpp=EXCLUDED.kpp,oktmo=EXCLUDED.oktmo,kbk=EXCLUDED.kbk,
           tax_period_code=EXCLUDED.tax_period_code,
           reporting_year=EXCLUDED.reporting_year,
           amount_minor=EXCLUDED.amount_minor,
           source='MANUAL',status=EXCLUDED.status,
           confirmed_by_membership_id=EXCLUDED.confirmed_by_membership_id,
           confirmed_at=EXCLUDED.confirmed_at,updated_at=now()
         RETURNING *`,
        [
          context.tenantId,obligationId,lineNumber,effectiveKpp,
          effectiveOktmo,kbk,taxPeriodCode,reportingYear,input.amountMinor,
          input.confirm?"CONFIRMED":"DRAFT",context.membershipId
        ]
      );

      if(input.confirm){
        const total=await client.query<{amount:string}>(
          `SELECT coalesce(sum(amount_minor),0)::text AS amount
           FROM accounting_compliance_line
           WHERE tenant_id=$1 AND obligation_id=$2
             AND status='CONFIRMED'`,
          [context.tenantId,obligationId]
        );
        await client.query(
          `UPDATE accounting_compliance_obligation
           SET amount_minor=$3::bigint,
               calculation_status='CONFIRMED',
               review_note='Сумма подтверждена по строкам налогового документа',
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,obligationId,total.rows[0]?.amount??"0"]
        );
        await this.event(
          client,context,obligationId,"COMPLIANCE_LINE_CONFIRMED",
          obligation.workflow_status,obligation.workflow_status,{
            lineNumber,
            amountMinor:input.amountMinor
          }
        );
      }

      return result.rows[0];
    });
  }

  async preparePacket(context:TenantContext,obligationId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const obligationResult=await client.query<any>(
        `SELECT
           o.*,le.inn,p.entity_kind,p.compliance_enabled,
           coalesce(p.kpp,le.kpp) AS kpp,p.oktmo
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
      if(obligation.compliance_enabled===false) {
        throw new ConflictException(
          "Налоговый контур выключен для этого юридического лица"
        );
      }
      if(!["PLANNED","READY","REJECTED"].includes(obligation.workflow_status)) {
        throw new ConflictException("Пакет уже находится на следующем этапе");
      }

      const lineResult=await client.query<any>(
        `SELECT
           line_number,kpp,oktmo,kbk,tax_period_code,reporting_year,
           amount_minor::text,source,status
         FROM accounting_compliance_line
         WHERE tenant_id=$1 AND obligation_id=$2
         ORDER BY line_number`,
        [context.tenantId,obligationId]
      );
      const lines=lineResult.rows;

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
      if(obligation.form_code==="KND_1110355"){
        if(!lines.length) {
          errors.push("Не заполнены строки КНД 1110355");
        }
        for(const line of lines){
          if(line.status!=="CONFIRMED"){
            errors.push("Строка "+line.line_number+" не подтверждена");
          }
          if(!line.oktmo) errors.push("Строка "+line.line_number+": нет ОКТМО");
          if(!line.kbk) errors.push("Строка "+line.line_number+": нет КБК");
          if(!line.tax_period_code) {
            errors.push("Строка "+line.line_number+": нет кода периода");
          }
          if(!line.reporting_year) {
            errors.push("Строка "+line.line_number+": нет отчётного года");
          }
          if(line.amount_minor===null) {
            errors.push("Строка "+line.line_number+": нет суммы");
          }
          if(obligation.entity_kind==="ORGANIZATION"&&!line.kpp){
            errors.push("Строка "+line.line_number+": нет КПП");
          }
        }
        if(lines.length&&obligation.amount_minor!==null){
          const linesTotal=lines.reduce(
            (sum:number,line:any)=>sum+Number(line.amount_minor??0),0
          );
          if(linesTotal!==Number(obligation.amount_minor)){
            errors.push("Сумма строк не совпадает с подтверждённой суммой");
          }
        }
      }

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
        },
        lines
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
           signed_by_membership_id=NULL,signature_reference=NULL,
           certificate_fingerprint_snapshot=NULL,updated_at=now()
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
      const current=await client.query<any>(
        `SELECT
           o.id,o.form_code,o.amount_minor,o.obligation_type,
           o.workflow_status,p.id AS packet_id,
           tp.entity_kind,coalesce(tp.kpp,le.kpp) AS kpp,
           tp.oktmo,le.inn
         FROM accounting_compliance_obligation o
         JOIN accounting_tax_profile tp
           ON tp.tenant_id=o.tenant_id AND tp.id=o.tax_profile_id
         JOIN legal_entity le
           ON le.tenant_id=o.tenant_id AND le.id=o.legal_entity_id
         LEFT JOIN accounting_compliance_packet p
           ON p.tenant_id=o.tenant_id AND p.id=o.packet_id
         WHERE o.tenant_id=$1 AND o.id=$2
         FOR UPDATE OF o`,
        [context.tenantId,obligationId]
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException("Обязательство не найдено");
      if(!row.packet_id) throw new NotFoundException("Пакет не найден");
      if(row.workflow_status!=="READY"){
        throw new ConflictException("Пакет не находится на этапе проверки");
      }

      const linesResult=await client.query<any>(
        `SELECT
           line_number,kpp,oktmo,kbk,tax_period_code,reporting_year,
           amount_minor::text,status
         FROM accounting_compliance_line
         WHERE tenant_id=$1 AND obligation_id=$2
         ORDER BY line_number`,
        [context.tenantId,obligationId]
      );
      const lines=linesResult.rows;
      const errors:string[]=[];
      if(!row.inn) errors.push("Не указан ИНН");
      if(
        ["PAY","NOTIFY"].includes(row.obligation_type) &&
        row.amount_minor===null
      ) errors.push("Не подтверждена сумма");

      if(row.form_code==="KND_1110355"){
        if(!lines.length) errors.push("Не заполнены строки КНД 1110355");
        for(const line of lines){
          if(line.status!=="CONFIRMED") {
            errors.push("Строка "+line.line_number+" не подтверждена");
          }
          if(!line.oktmo) errors.push("Строка "+line.line_number+": нет ОКТМО");
          if(!line.kbk) errors.push("Строка "+line.line_number+": нет КБК");
          if(!line.tax_period_code) {
            errors.push("Строка "+line.line_number+": нет кода периода");
          }
          if(!line.reporting_year) {
            errors.push("Строка "+line.line_number+": нет отчётного года");
          }
          if(line.amount_minor===null) {
            errors.push("Строка "+line.line_number+": нет суммы");
          }
          if(row.entity_kind==="ORGANIZATION"&&!line.kpp){
            errors.push("Строка "+line.line_number+": нет КПП");
          }
        }
        if(lines.length&&row.amount_minor!==null){
          const total=lines.reduce(
            (sum:number,line:any)=>sum+Number(line.amount_minor??0),0
          );
          if(total!==Number(row.amount_minor)){
            errors.push("Сумма строк не совпадает с подтверждённой суммой");
          }
        }
      }

      if(errors.length){
        await client.query(
          `UPDATE accounting_compliance_packet
           SET validation_status='INVALID',validation_errors=$3,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.packet_id,JSON.stringify(errors)]
        );
        throw new ConflictException(
          "Пакет не прошёл проверку: "+errors.join("; ")
        );
      }

      const result=await client.query<any>(
        `UPDATE accounting_compliance_packet
         SET validation_status='VALID',validation_errors='[]'::jsonb,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [context.tenantId,row.packet_id]
      );
      await client.query(
        `UPDATE accounting_compliance_obligation
         SET review_note=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,obligationId,input.note.trim()]
      );
      await this.event(
        client,context,obligationId,"PACKET_VALIDATED",
        "READY","READY",{note:input.note.trim()}
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
        `SELECT o.workflow_status,o.calculation_status,o.obligation_type,
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
        ["PAY","NOTIFY"].includes(current.obligation_type) &&
        current.calculation_status!=="CONFIRMED"
      ) {
        throw new ConflictException("Для платежа или уведомления сначала подтвердите расчёт");
      }
      if(
        !["PAY","NOTIFY"].includes(current.obligation_type) &&
        !["CONFIRMED","NOT_CALCULATED"].includes(current.calculation_status)
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

  async payTaxObligation(
    context:TenantContext,
    obligationId:string,
    input:{cashAccountId:string;note?:string}
  ){
    if(!input.cashAccountId){
      throw new BadRequestException("Выберите расчётный счёт для оплаты");
    }
    return this.database.withTenantTransaction(context,async client=>{
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [context.tenantId+":tax-payment:"+obligationId]
      );

      const obligationResult=await client.query<any>(
        `SELECT
           id,legal_entity_id,title,workflow_status,obligation_type,
           amount_minor,currency,payment_obligation_id,payment_id
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,obligationId]
      );
      const row=obligationResult.rows[0];
      if(!row) throw new NotFoundException("Налоговое обязательство не найдено");
      if(row.obligation_type!=="PAY"){
        throw new BadRequestException("Эта задача не является налоговым платежом");
      }
      if(!row.payment_obligation_id){
        throw new ConflictException(
          "Сначала подтвердите расчёт налога и сформируйте обязательство к оплате"
        );
      }

      const payableResult=await client.query<any>(
        `SELECT id,amount_minor,settled_minor,status
         FROM financial_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,row.payment_obligation_id]
      );
      const payable=payableResult.rows[0];
      if(!payable){
        throw new ConflictException("Финансовое обязательство по налогу не найдено");
      }

      if(row.workflow_status==="PAID"){
        return {
          paid:true,pending:false,alreadyPaid:true,
          paymentId:row.payment_id??null,
          amountMinor:String(payable.amount_minor)
        };
      }

      if(row.workflow_status==="PAYMENT_PENDING"&&row.payment_id){
        return {
          paid:false,pending:true,alreadyPaid:false,
          paymentId:row.payment_id,
          amountMinor:String(payable.amount_minor)
        };
      }

      if(row.workflow_status!=="APPROVED"){
        throw new ConflictException(
          "Оплата доступна только после проверки и утверждения налоговой задачи"
        );
      }

      const account=await client.query(
        `SELECT 1
         FROM cash_account
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
           AND legal_entity_id=$3`,
        [context.tenantId,input.cashAccountId,row.legal_entity_id]
      );
      if(!account.rowCount){
        throw new NotFoundException(
          "Расчётный счёт не найден или относится к другому юридическому лицу"
        );
      }

      const remaining=
        BigInt(payable.amount_minor)-BigInt(payable.settled_minor??0);
      if(remaining<=0n){
        throw new ConflictException(
          "Финансовое обязательство уже закрыто. Подтвердите факт уплаты квитанцией банка или ФНС."
        );
      }

      const idempotencyKey="tax-payment:"+obligationId;
      const existingPayment=await client.query<{id:string;amount_minor:string}>(
        `SELECT id,amount_minor::text
         FROM payment
         WHERE tenant_id=$1 AND idempotency_key=$2
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [context.tenantId,idempotencyKey]
      );

      let paymentId=existingPayment.rows[0]?.id??null;
      let paymentAmount=existingPayment.rows[0]?.amount_minor??remaining.toString();

      if(!paymentId){
        const counter=await client.query<{value:string}>(
          `INSERT INTO tenant_counter(tenant_id,counter_key,value)
           VALUES($1,'payment',1)
           ON CONFLICT(tenant_id,counter_key)
           DO UPDATE SET value=tenant_counter.value+1,updated_at=now()
           RETURNING value::text`,
          [context.tenantId]
        );
        const number=
          "PAY-"+new Date().getUTCFullYear()+"-"+
          BigInt(counter.rows[0]?.value??"0").toString().padStart(6,"0");

        const payment=await client.query<{id:string}>(
          `INSERT INTO payment(
             tenant_id,business_number,cash_account_id,party_id,obligation_id,
             direction,kind,amount_minor,currency,status,source_type,source_id,
             idempotency_key,note,posted_by_membership_id
           ) VALUES(
             $1,$2,$3,NULL,$4,'OUT','PAYMENT',$5,$6,'POSTED',
             'ACCOUNTING_COMPLIANCE',$7,$8,$9,$10
           )
           RETURNING id`,
          [
            context.tenantId,number,input.cashAccountId,row.payment_obligation_id,
            remaining.toString(),row.currency,obligationId,idempotencyKey,
            input.note?.trim()||("Уплата: "+row.title),
            context.membershipId
          ]
        );
        paymentId=payment.rows[0]?.id??null;
        paymentAmount=remaining.toString();
        if(!paymentId) throw new Error("ACCOUNTING_TAX_PAYMENT_CREATE_FAILED");
      }

      await client.query(
        `UPDATE accounting_compliance_obligation
         SET workflow_status='PAYMENT_PENDING',
             payment_id=$3,
             payment_initiated_at=coalesce(payment_initiated_at,now()),
             completed_at=NULL,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,obligationId,paymentId]
      );

      await client.query(
        `INSERT INTO accounting_compliance_receipt(
           tenant_id,obligation_id,provider,external_reference,
           receipt_type,payload
         ) VALUES($1,$2,'COREBIZ_PAYMENT',$3,'SENT',$4)
         ON CONFLICT DO NOTHING`,
        [
          context.tenantId,obligationId,paymentId,
          JSON.stringify({
            paymentId,cashAccountId:input.cashAccountId,
            amountMinor:paymentAmount,
            state:"PAYMENT_INITIATED_NOT_CONFIRMED"
          })
        ]
      );

      await this.event(
        client,context,obligationId,
        "TAX_PAYMENT_INITIATED","APPROVED","PAYMENT_PENDING",
        {paymentId,amountMinor:paymentAmount,cashAccountId:input.cashAccountId}
      );

      return {
        paid:false,pending:true,alreadyPaid:false,
        paymentId,amountMinor:paymentAmount
      };
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

  async recordProviderSignature(
    context:TenantContext,
    obligationId:string,
    input:{
      provider:string;
      certificateFingerprint:string;
      providerReference:string;
    }
  ) {
    if(
      !input.provider?.trim() ||
      !input.certificateFingerprint?.trim() ||
      !input.providerReference?.trim()
    ) {
      throw new BadRequestException(
        "Нужны оператор, отпечаток сертификата и идентификатор подписи"
      );
    }
    return this.database.withTenantTransaction(context,async client=>{
      const obligation=await client.query<{
        workflow_status:string;
        legal_entity_id:string;
        packet_id:string|null;
      }>(
        `SELECT workflow_status,legal_entity_id,packet_id
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,obligationId]
      );
      const row=obligation.rows[0];
      if(!row) throw new NotFoundException("Обязательство не найдено");
      if(row.workflow_status!=="APPROVED"||!row.packet_id) {
        throw new ConflictException(
          "Подписывать можно только утверждённый подготовленный пакет"
        );
      }

      const connector=await client.query(
        `SELECT 1
         FROM accounting_reporting_connector
         WHERE tenant_id=$1
           AND legal_entity_id=$2
           AND provider=$3
           AND status='VERIFIED'
           AND certificate_fingerprint=$4
           AND (
             certificate_valid_to IS NULL
             OR certificate_valid_to>now()
           )`,
        [
          context.tenantId,row.legal_entity_id,input.provider.trim(),
          input.certificateFingerprint.trim()
        ]
      );
      if(!connector.rowCount) {
        throw new ConflictException(
          "Подпись не подтверждена проверенным коннектором или сертификат истёк"
        );
      }

      const packet=await client.query(
        `UPDATE accounting_compliance_packet
         SET signature_status='SIGNED',
             signed_at=now(),
             signed_by_membership_id=$4,
             signature_reference=$6,
             certificate_fingerprint_snapshot=$7,
             payload=payload || jsonb_build_object(
               'signatureProvider',$5,
               'signatureReference',$6,
               'certificateFingerprint',$7
             ),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND obligation_id=$3
         RETURNING *`,
        [
          context.tenantId,row.packet_id,obligationId,context.membershipId,
          input.provider.trim(),input.providerReference.trim(),
          input.certificateFingerprint.trim()
        ]
      );
      if(!packet.rows[0]) throw new NotFoundException("Пакет не найден");

      await this.event(
        client,context,obligationId,"PROVIDER_SIGNATURE_CONFIRMED",
        "APPROVED","APPROVED",{
          provider:input.provider.trim(),
          providerReference:input.providerReference.trim()
        }
      );
      return packet.rows[0];
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
      if(row.signature_status!=="SIGNED") {
        throw new ConflictException(
          "Перед отправкой требуется подтверждённая подпись пакета"
        );
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
    if(!input.provider?.trim()||!input.externalReference?.trim()){
      throw new BadRequestException("Укажите источник и номер подтверждения");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const current=await client.query<{
        workflow_status:string;
        obligation_type:string;
        payment_obligation_id:string|null;
        payment_id:string|null;
      }>(
        `SELECT
           workflow_status,obligation_type,payment_obligation_id,payment_id
         FROM accounting_compliance_obligation
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,obligationId]
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException("Обязательство не найдено");

      if(
        input.receiptType==="PAYMENT" &&
        (
          row.obligation_type!=="PAY" ||
          !row.payment_obligation_id ||
          !row.payment_id
        )
      ){
        throw new ConflictException(
          "Подтверждение оплаты доступно только после формирования и отправки налогового платежа"
        );
      }

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

      if(input.receiptType==="PAYMENT"){
        const payable=await client.query<{
          amount_minor:string;
          settled_minor:string;
        }>(
          `SELECT amount_minor::text,settled_minor::text
           FROM financial_obligation
           WHERE tenant_id=$1 AND id=$2
           FOR UPDATE`,
          [context.tenantId,row.payment_obligation_id]
        );
        const paymentObligation=payable.rows[0];
        if(!paymentObligation){
          throw new ConflictException("Финансовое обязательство по налогу не найдено");
        }

        await client.query(
          `UPDATE financial_obligation
           SET settled_minor=amount_minor,status='SETTLED',updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.payment_obligation_id]
        );
      }

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
               payment_confirmed_at=CASE
                 WHEN $5::text='PAYMENT' THEN now()
                 ELSE payment_confirmed_at
               END,
               payment_confirmation_source=CASE
                 WHEN $5::text='PAYMENT' THEN $6
                 ELSE payment_confirmation_source
               END,
               payment_confirmation_reference=CASE
                 WHEN $5::text='PAYMENT' THEN $7
                 ELSE payment_confirmation_reference
               END,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,obligationId,next,
            input.receiptType==="REJECTED"
              ?String(input.payload?.reason??"Отклонено оператором/ФНС")
              :null,
            input.receiptType,input.provider.trim(),
            input.externalReference.trim()
          ]
        );
        await this.event(
          client,context,obligationId,"RECEIPT_"+input.receiptType,
          row.workflow_status,next,{
            ...(input.payload??{}),
            provider:input.provider.trim(),
            externalReference:input.externalReference.trim()
          }
        );
      }
      return {
        status:next,
        paymentConfirmed:input.receiptType==="PAYMENT"&&next==="PAID"
      };
    });
  }

  async ensSnapshots(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           id,legal_entity_id,snapshot_at AS as_of,
           balance_minor::text,upcoming_minor::text,overdue_minor::text,
           source,external_reference,details,created_at
         FROM accounting_ens_snapshot
         WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY snapshot_at DESC
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
      const source=
        input.source==="FNS_LK"||input.source==="REPORTING_OPERATOR"
          ?"FNS_CONNECTOR"
          :input.source==="IMPORT"
            ?"IMPORT"
            :"MANUAL";
      const result=await client.query(
        `INSERT INTO accounting_ens_snapshot(
           tenant_id,legal_entity_id,balance_minor,upcoming_minor,
           overdue_minor,source,external_reference,details,
           created_by_membership_id
         ) VALUES($1,$2,$3,0,0,$4,$5,$6,$7)
         RETURNING
           id,legal_entity_id,snapshot_at AS as_of,
           balance_minor::text,upcoming_minor::text,overdue_minor::text,
           source,external_reference,details,created_at`,
        [
          context.tenantId,input.legalEntityId,input.balanceMinor,source,
          input.externalReference?.trim()||null,
          JSON.stringify(input.details??{}),context.membershipId
        ]
      );
      return result.rows[0];
    });
  }

  async autopilot(
    context:TenantContext,
    legalEntityId:string
  ){
    if(!legalEntityId){
      throw new BadRequestException("Выберите юридическое лицо");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const entity=await client.query(
        `SELECT id,name,inn
         FROM legal_entity
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,legalEntityId]
      );
      if(!entity.rows[0]){
        throw new NotFoundException("Юридическое лицо не найдено");
      }

      const generated:Array<{
        key:string;
        category:string;
        severity:"INFO"|"WARNING"|"CRITICAL";
        title:string;
        description:string;
        actionCode?:string;
        actionHref?:string;
        sourceType?:string;
        sourceId?:string|null;
        dueAt?:Date|null;
        amountMinor?:string|null;
        payload?:Record<string,unknown>;
      }>=[];
      const add=(task:(typeof generated)[number])=>generated.push(task);

      const profileResult=await client.query<any>(
        `SELECT *
         FROM accounting_tax_profile
         WHERE tenant_id=$1 AND legal_entity_id=$2 AND status='ACTIVE'
         ORDER BY effective_from DESC,created_at DESC
         LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      const profile=profileResult.rows[0]??null;

      if(!profile){
        add({
          key:"setup:tax-profile",
          category:"SETUP",
          severity:"CRITICAL",
          title:"Настройте налоговый профиль",
          description:
            "Без налогового режима, формы бизнеса и НДС CoreBiz не может надёжно собрать календарь ФНС и рассчитать налоги.",
          actionCode:"OPEN_TAX_PROFILE",
          actionHref:"/app/accounting/taxes"
        });
      }else if(profile.compliance_enabled!==false){
        const obligations=await client.query<any>(
          `SELECT
             id,code,title,obligation_type,due_at,amount_minor::text,currency,
             workflow_status
           FROM accounting_compliance_obligation
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND workflow_status NOT IN ('ACCEPTED','PAID','CANCELLED')
             AND due_at<=now()+interval '30 days'
           ORDER BY due_at`,
          [context.tenantId,legalEntityId]
        );
        for(const item of obligations.rows){
          const dueAt=new Date(item.due_at);
          const days=Math.ceil((dueAt.getTime()-Date.now())/86400000);
          add({
            key:"obligation:"+item.id,
            category:item.obligation_type==="PAY"?"TAX":"FNS",
            severity:days<0?"CRITICAL":days<=7?"WARNING":"INFO",
            title:item.title,
            description:
              days<0
                ?"Срок уже прошёл. Проверьте расчёт, отправку или оплату и зафиксируйте квитанцию."
                :"До срока "+Math.max(0,days)+" дн. Подготовьте документ заранее, чтобы не зависеть от последнего дня.",
            actionCode:"OPEN_OBLIGATION",
            actionHref:"/app/accounting/taxes",
            sourceType:"ACCOUNTING_COMPLIANCE",
            sourceId:item.id,
            dueAt,
            amountMinor:item.amount_minor,
            payload:{
              code:item.code,
              workflowStatus:item.workflow_status,
              obligationType:item.obligation_type
            }
          });
        }

        const ledger=await client.query<{count:number;amount:string}>(
          `SELECT
             count(*)::integer AS count,
             coalesce(sum(amount_minor),0)::text AS amount
           FROM accounting_tax_ledger_item
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND tax_treatment='REVIEW_REQUIRED'`,
          [context.tenantId,legalEntityId]
        );
        const ledgerRow=ledger.rows[0];
        if((ledgerRow?.count??0)>0){
          add({
            key:"tax-ledger:review",
            category:"TAX",
            severity:"WARNING",
            title:"Проверьте операции налоговой книги",
            description:
              String(ledgerRow.count)+" операций ещё не классифицированы. Пока они не проверены, итоговый расчёт УСН нельзя считать подтверждённым.",
            actionCode:"REVIEW_TAX_LEDGER",
            actionHref:"/app/accounting/taxes",
            amountMinor:ledgerRow.amount,
            payload:{count:ledgerRow.count}
          });
        }

        const upcomingPay=await client.query<{amount:string;count:number}>(
          `SELECT
             coalesce(sum(amount_minor),0)::text AS amount,
             count(*)::integer AS count
           FROM accounting_compliance_obligation
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND obligation_type='PAY'
             AND workflow_status NOT IN ('PAID','CANCELLED')
             AND due_at>=now()
             AND due_at<=now()+interval '30 days'
             AND amount_minor IS NOT NULL`,
          [context.tenantId,legalEntityId]
        );
        const ens=await client.query<{balance_minor:string;snapshot_at:Date}>(
          `SELECT balance_minor::text,snapshot_at
           FROM accounting_ens_snapshot
           WHERE tenant_id=$1 AND legal_entity_id=$2
           ORDER BY snapshot_at DESC
           LIMIT 1`,
          [context.tenantId,legalEntityId]
        );
        const ensRow=ens.rows[0];
        const upcoming=BigInt(upcomingPay.rows[0]?.amount??"0");
        if(!ensRow&&upcoming>0n){
          add({
            key:"ens:no-snapshot",
            category:"ENS",
            severity:"WARNING",
            title:"Обновите баланс ЕНС",
            description:
              "Есть ближайшие налоговые платежи, но CoreBiz не знает актуальный баланс единого налогового счёта.",
            actionCode:"UPDATE_ENS",
            actionHref:"/app/accounting/taxes",
            amountMinor:upcoming.toString()
          });
        }else if(ensRow){
          const balance=BigInt(ensRow.balance_minor);
          if(balance<0n){
            add({
              key:"ens:negative",
              category:"ENS",
              severity:"CRITICAL",
              title:"На ЕНС отрицательный баланс",
              description:
                "Последний зафиксированный баланс ЕНС отрицательный. Нужна сверка с ФНС и проверка недоимки/пени.",
              actionCode:"RECONCILE_ENS",
              actionHref:"/app/accounting/taxes",
              amountMinor:(-balance).toString(),
              payload:{snapshotAt:ensRow.snapshot_at}
            });
          }else if(upcoming>balance){
            add({
              key:"ens:funding-gap",
              category:"ENS",
              severity:"WARNING",
              title:"Денег на ЕНС может не хватить",
              description:
                "Ближайшие подтверждённые налоговые платежи за 30 дней выше последнего известного положительного баланса ЕНС.",
              actionCode:"PLAN_TAX_FUNDING",
              actionHref:"/app/accounting/taxes",
              amountMinor:(upcoming-balance).toString(),
              payload:{
                ensBalanceMinor:balance.toString(),
                upcomingTaxMinor:upcoming.toString()
              }
            });
          }
        }

        const filingSoon=await client.query<{count:number}>(
          `SELECT count(*)::integer AS count
           FROM accounting_compliance_obligation
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND obligation_type IN ('FILE','NOTIFY')
             AND workflow_status NOT IN ('ACCEPTED','CANCELLED')
             AND due_at<=now()+interval '30 days'`,
          [context.tenantId,legalEntityId]
        );
        if((filingSoon.rows[0]?.count??0)>0){
          const connector=await client.query<any>(
            `SELECT
               id,provider,certificate_valid_to,last_error
             FROM accounting_reporting_connector
             WHERE tenant_id=$1 AND legal_entity_id=$2
               AND status='VERIFIED' AND supports_filing=true
             ORDER BY last_verified_at DESC NULLS LAST
             LIMIT 1`,
            [context.tenantId,legalEntityId]
          );
          const c=connector.rows[0];
          if(!c){
            add({
              key:"filing:no-connector",
              category:"FNS",
              severity:"WARNING",
              title:"Подключите канал сдачи отчётности",
              description:
                "В ближайшие 30 дней есть отчёт или уведомление, но нет проверенного коннектора, который поддерживает отправку.",
              actionCode:"SETUP_FILING_CONNECTOR",
              actionHref:"/app/accounting/taxes"
            });
          }else if(
            c.certificate_valid_to &&
            new Date(c.certificate_valid_to).getTime()<=
              Date.now()+30*86400000
          ){
            add({
              key:"filing:certificate-expiry:"+c.id,
              category:"FNS",
              severity:"WARNING",
              title:"Скоро истечёт сертификат КЭП",
              description:
                "Продлите сертификат заранее, чтобы отправка отчётности не остановилась в день срока.",
              actionCode:"RENEW_CERTIFICATE",
              actionHref:"/app/accounting/taxes",
              sourceType:"REPORTING_CONNECTOR",
              sourceId:c.id,
              dueAt:new Date(c.certificate_valid_to)
            });
          }
        }

        if(profile.tax_regime==="NPD"){
          const npd=await client.query<{drafts:number;errors:number}>(
            `SELECT
               count(*) FILTER (
                 WHERE fiscal_status IN ('DRAFT','READY')
               )::integer AS drafts,
               count(*) FILTER (
                 WHERE fiscal_status='ERROR'
               )::integer AS errors
             FROM accounting_npd_receipt
             WHERE tenant_id=$1 AND legal_entity_id=$2`,
            [context.tenantId,legalEntityId]
          );
          const n=npd.rows[0];
          if((n?.errors??0)>0||(n?.drafts??0)>0){
            add({
              key:"npd:unregistered-receipts",
              category:"NPD",
              severity:(n?.errors??0)>0?"CRITICAL":"WARNING",
              title:"Оформите чеки НПД",
              description:
                "Есть "+String(n?.drafts??0)+" доходов без подтверждённого чека и "+
                String(n?.errors??0)+" ошибок регистрации.",
              actionCode:"FIX_NPD_RECEIPTS",
              actionHref:"/app/accounting/taxes",
              payload:{drafts:n?.drafts??0,errors:n?.errors??0}
            });
          }
        }
      }

      const bank=await client.query<{count:number;amount:string}>(
        `SELECT
           count(*)::integer AS count,
           coalesce(sum(l.amount_minor),0)::text AS amount
         FROM finance_bank_statement_line l
         JOIN finance_bank_statement s
           ON s.tenant_id=l.tenant_id AND s.id=l.statement_id
         JOIN cash_account ca
           ON ca.tenant_id=s.tenant_id AND ca.id=s.cash_account_id
         WHERE l.tenant_id=$1
           AND ca.legal_entity_id=$2
           AND l.payment_id IS NULL
           AND l.booked_on>=current_date-60`,
        [context.tenantId,legalEntityId]
      );
      const bankRow=bank.rows[0];
      if((bankRow?.count??0)>0){
        add({
          key:"bank:unmatched",
          category:"BANK",
          severity:"WARNING",
          title:"Сверьте операции банка",
          description:
            String(bankRow.count)+" строк выписки за последние 60 дней не сопоставлены с платежами CoreBiz.",
          actionCode:"OPEN_BANK_RECONCILIATION",
          actionHref:"/app/finance",
          amountMinor:bankRow.amount,
          payload:{count:bankRow.count}
        });
      }

      const close=await client.query<any>(
        `SELECT
           p.id,p.date_from,p.date_to,p.state,
           count(c.id) FILTER (WHERE c.status='DONE')::integer AS done_count,
           count(c.id) FILTER (WHERE c.status='BLOCKED')::integer AS blocked_count
         FROM accounting_period p
         LEFT JOIN accounting_month_close_check c
           ON c.tenant_id=p.tenant_id AND c.period_id=p.id
         WHERE p.tenant_id=$1 AND p.legal_entity_id=$2
           AND p.state='OPEN'
           AND p.date_to<current_date
         GROUP BY p.id
         ORDER BY p.date_to DESC
         LIMIT 1`,
        [context.tenantId,legalEntityId]
      );
      const period=close.rows[0];
      if(period&&Number(period.done_count??0)<7){
        add({
          key:"period-close:"+period.id,
          category:"PERIOD_CLOSE",
          severity:Number(period.blocked_count??0)>0?"CRITICAL":"WARNING",
          title:"Закройте прошедший бухгалтерский период",
          description:
            "За период до "+String(period.date_to)+
            " выполнено "+String(period.done_count??0)+" из 7 контрольных проверок.",
          actionCode:"OPEN_PERIOD_CLOSE",
          actionHref:"/app/accounting",
          sourceType:"ACCOUNTING_PERIOD",
          sourceId:period.id,
          payload:{
            doneCount:Number(period.done_count??0),
            blockedCount:Number(period.blocked_count??0)
          }
        });
      }

      const activeKeys=generated.map(item=>item.key);
      for(const task of generated){
        await client.query(
          `INSERT INTO accounting_assistant_task(
             tenant_id,legal_entity_id,task_key,category,severity,status,
             title,description,action_code,action_href,source_type,source_id,
             due_at,amount_minor,currency,payload
           ) VALUES(
             $1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9,$10,$11,$12,$13,'RUB',$14
           )
           ON CONFLICT(tenant_id,legal_entity_id,task_key)
           DO UPDATE SET
             category=EXCLUDED.category,
             severity=EXCLUDED.severity,
             status=CASE
               WHEN accounting_assistant_task.status='DISMISSED'
                 THEN 'DISMISSED'
               ELSE 'OPEN'
             END,
             title=EXCLUDED.title,
             description=EXCLUDED.description,
             action_code=EXCLUDED.action_code,
             action_href=EXCLUDED.action_href,
             source_type=EXCLUDED.source_type,
             source_id=EXCLUDED.source_id,
             due_at=EXCLUDED.due_at,
             amount_minor=EXCLUDED.amount_minor,
             currency=EXCLUDED.currency,
             payload=EXCLUDED.payload,
             resolved_by_membership_id=NULL,
             resolved_at=NULL,
             updated_at=now()`,
          [
            context.tenantId,legalEntityId,task.key,task.category,
            task.severity,task.title,task.description,
            task.actionCode??null,task.actionHref??null,
            task.sourceType??null,task.sourceId??null,task.dueAt??null,
            task.amountMinor??null,JSON.stringify(task.payload??{})
          ]
        );
      }

      if(activeKeys.length){
        await client.query(
          `UPDATE accounting_assistant_task
           SET status='DONE',
               resolved_by_membership_id=$3,
               resolved_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND status IN ('OPEN','IN_PROGRESS')
             AND NOT (task_key=ANY($4::text[]))`,
          [context.tenantId,legalEntityId,context.membershipId,activeKeys]
        );
      }else{
        await client.query(
          `UPDATE accounting_assistant_task
           SET status='DONE',
               resolved_by_membership_id=$3,
               resolved_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND legal_entity_id=$2
             AND status IN ('OPEN','IN_PROGRESS')`,
          [context.tenantId,legalEntityId,context.membershipId]
        );
      }

      const tasks=await client.query(
        `SELECT
           id,task_key,category,severity,status,title,description,
           action_code,action_href,source_type,source_id,due_at,
           amount_minor::text,currency,payload,updated_at
         FROM accounting_assistant_task
         WHERE tenant_id=$1 AND legal_entity_id=$2
           AND status IN ('OPEN','IN_PROGRESS','DISMISSED')
         ORDER BY
           CASE severity
             WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2
           END,
           due_at NULLS LAST,updated_at DESC`,
        [context.tenantId,legalEntityId]
      );

      const summary={
        critical:tasks.rows.filter((task:any)=>task.status!=="DISMISSED"&&task.severity==="CRITICAL").length,
        warning:tasks.rows.filter((task:any)=>task.status!=="DISMISSED"&&task.severity==="WARNING").length,
        info:tasks.rows.filter((task:any)=>task.status!=="DISMISSED"&&task.severity==="INFO").length
      };
      return {
        legalEntity:entity.rows[0],
        profile,
        summary,
        tasks:tasks.rows
      };
    });
  }

  async updateAutopilotTask(
    context:TenantContext,
    taskId:string,
    input:{status:"OPEN"|"IN_PROGRESS"|"DISMISSED"}
  ){
    if(!["OPEN","IN_PROGRESS","DISMISSED"].includes(input.status)){
      throw new BadRequestException("Некорректный статус задачи");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE accounting_assistant_task
         SET status=$3,
             resolved_by_membership_id=CASE
               WHEN $3='DISMISSED' THEN $4::uuid ELSE NULL
             END,
             resolved_at=CASE
               WHEN $3='DISMISSED' THEN now() ELSE NULL
             END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING
           id,task_key,category,severity,status,title,description,
           action_code,action_href,due_at,amount_minor::text,currency,payload`,
        [context.tenantId,taskId,input.status,context.membershipId]
      );
      if(!result.rows[0]){
        throw new NotFoundException("Задача автопилота не найдена");
      }
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
