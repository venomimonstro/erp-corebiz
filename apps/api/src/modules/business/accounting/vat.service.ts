import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class VatService {
  constructor(private readonly database:DatabaseService) {}

  async periods(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT id,date_from,date_to,state,closed_at,close_reason
         FROM accounting_vat_period WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY date_from DESC`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
    });
  }

  async createPeriod(context:TenantContext,input:{legalEntityId:string;dateFrom:string;dateTo:string}) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.dateFrom) ||
       !/^\d{4}-\d{2}-\d{2}$/.test(input.dateTo) || input.dateFrom>input.dateTo) {
      throw new BadRequestException("Invalid VAT period");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{id:string}>(
        `INSERT INTO accounting_vat_period(tenant_id,legal_entity_id,date_from,date_to)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [context.tenantId,input.legalEntityId,input.dateFrom,input.dateTo]
      );
      return {id:result.rows[0]!.id,state:"OPEN"};
    });
  }

  async closePeriod(context:TenantContext,input:{periodId:string;reason:string}) {
    if(!input.periodId || typeof input.reason!=="string" || input.reason.trim().length<12) {
      throw new BadRequestException("VAT period closure requires reason");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const period=await client.query<{id:string;state:string}>(
        `SELECT id,state FROM accounting_vat_period WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,input.periodId]
      );
      if(!period.rows[0]) throw new NotFoundException("VAT period not found");
      if(period.rows[0].state==="CLOSED") return {state:"CLOSED",changed:false};
      await client.query(
        `UPDATE accounting_vat_period SET state='CLOSED',
         closed_by_membership_id=$3,closed_at=now(),close_reason=$4
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,input.periodId,context.membershipId,input.reason.trim()]
      );
      return {state:"CLOSED",changed:true};
    });
  }

  async documents(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT id,document_kind,document_number,document_date,counterparty_id,
          source_type,source_id,currency,taxable_base_minor::text,
          vat_amount_minor::text,rate_code,status,approved_at
         FROM accounting_vat_document
         WHERE tenant_id=$1 AND legal_entity_id=$2
         ORDER BY document_date DESC,id DESC LIMIT 500`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
    });
  }

  async createDraft(context:TenantContext,input:{
    legalEntityId:string;documentKind:"ISSUED_INVOICE"|"RECEIVED_INVOICE"|"UPD"|"CORRECTION";
    documentNumber:string;documentDate:string;counterpartyId?:string;
    sourceType:string;sourceId:string;currency?:string;
    taxableBaseMinor:string;vatAmountMinor:string;rateCode:string;
  }) {
    const validDate=/^\d{4}-\d{2}-\d{2}$/;
    const validMinor=/^\d+$/;
    if(!input?.legalEntityId || !["ISSUED_INVOICE","RECEIVED_INVOICE","UPD","CORRECTION"].includes(input.documentKind) ||
      !input.documentNumber?.trim() || !validDate.test(input.documentDate) ||
      !input.sourceType?.trim() || !input.sourceId ||
      !validMinor.test(input.taxableBaseMinor) || !validMinor.test(input.vatAmountMinor) ||
      !input.rateCode?.trim() || !/^[A-Z]{3}$/.test(input.currency??"RUB")) {
      throw new BadRequestException("Invalid VAT document draft");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{id:string}>(
        `INSERT INTO accounting_vat_document(
         tenant_id,legal_entity_id,document_kind,document_number,document_date,
         counterparty_id,source_type,source_id,currency,taxable_base_minor,
         vat_amount_minor,rate_code
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [context.tenantId,input.legalEntityId,input.documentKind,input.documentNumber.trim(),
         input.documentDate,input.counterpartyId??null,input.sourceType.trim(),
         input.sourceId,input.currency??"RUB",input.taxableBaseMinor,input.vatAmountMinor,input.rateCode.trim()]
      );
      return {id:result.rows[0]!.id,status:"DRAFT"};
    });
  }

  async approveDocument(context:TenantContext,documentId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const doc=await client.query<{id:string;status:string}>(
        `SELECT id,status FROM accounting_vat_document
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,documentId]
      );
      if(!doc.rows[0]) throw new NotFoundException("VAT document not found");
      if(doc.rows[0].status==="APPROVED") return {id:documentId,status:"APPROVED",changed:false};
      if(doc.rows[0].status!=="DRAFT") throw new BadRequestException("Only draft VAT documents can be approved");
      await client.query(
        `UPDATE accounting_vat_document
         SET status='APPROVED',approved_by_membership_id=$3,approved_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,documentId,context.membershipId]
      );
      return {id:documentId,status:"APPROVED",changed:true};
    });
  }

  async registerDocument(context:TenantContext,input:{
    documentId:string;eventDate:string;registerKind:"OUTPUT_VAT"|"INPUT_VAT"|"CORRECTION";
  }) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate) ||
       !["OUTPUT_VAT","INPUT_VAT","CORRECTION"].includes(input.registerKind)) {
      throw new BadRequestException("Invalid VAT registration");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const doc=await client.query<{
        legal_entity_id:string;vat_amount_minor:string;status:string;
      }>(
        `SELECT legal_entity_id,vat_amount_minor::text,status
         FROM accounting_vat_document
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,input.documentId]
      );
      const d=doc.rows[0];
      if(!d || d.status!=="APPROVED") throw new BadRequestException("VAT document is not approved");
      const result=await client.query<{id:string}>(
        `INSERT INTO accounting_vat_register(
         tenant_id,vat_document_id,legal_entity_id,event_date,register_kind,amount_minor
         ) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [context.tenantId,input.documentId,d.legal_entity_id,input.eventDate,
         input.registerKind,d.vat_amount_minor]
      );
      return {id:result.rows[0]!.id,registered:true};
    });
  }

  async registerEntries(context:TenantContext,legalEntityId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT r.id,r.vat_document_id,r.event_date,r.register_kind,
           r.amount_minor::text,d.document_number,d.document_date
         FROM accounting_vat_register r
         JOIN accounting_vat_document d
           ON d.id=r.vat_document_id AND d.tenant_id=r.tenant_id
         WHERE r.tenant_id=$1 AND r.legal_entity_id=$2
         ORDER BY r.event_date DESC,r.id DESC LIMIT 500`,
        [context.tenantId,legalEntityId]
      );
      return result.rows;
    });
  }
}
