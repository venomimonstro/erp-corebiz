import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class VatService {
  constructor(private readonly database:DatabaseService) {}

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
