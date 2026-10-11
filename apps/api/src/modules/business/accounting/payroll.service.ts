import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class PayrollService {
  constructor(private readonly db:DatabaseService) {}

  async batches(ctx:TenantContext,legalEntityId:string) {
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        `SELECT
          b.id,b.period_from,b.period_to,b.status,b.currency,b.approved_at,
          b.paid_at,b.payment_reference,b.payment_note,
          count(l.id)::integer AS employees,
          coalesce(sum(l.gross_minor),0)::text AS gross_minor,
          coalesce(sum(l.deduction_minor),0)::text AS deduction_minor
         FROM payroll_accrual_batch b LEFT JOIN payroll_accrual_line l
         ON l.batch_id=b.id AND l.tenant_id=b.tenant_id
         WHERE b.tenant_id=$1 AND b.legal_entity_id=$2
         GROUP BY b.id ORDER BY b.period_from DESC LIMIT 200`,
        [ctx.tenantId,legalEntityId]);
      return r.rows;
    });
  }

  async createBatch(ctx:TenantContext,input:{legalEntityId:string;periodFrom:string;periodTo:string}) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input?.periodFrom) ||
       !/^\d{4}-\d{2}-\d{2}$/.test(input?.periodTo) ||
       input.periodFrom>input.periodTo) throw new BadRequestException("Invalid payroll dates");
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query<{id:string}>(
        `INSERT INTO payroll_accrual_batch(tenant_id,legal_entity_id,period_from,period_to)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [ctx.tenantId,input.legalEntityId,input.periodFrom,input.periodTo]);
      return {id:r.rows[0]!.id,status:"DRAFT"};
    });
  }

  async upsertLine(ctx:TenantContext,input:{
    batchId:string;employeeRef:string;grossMinor:string;deductionMinor:string;
  }) {
    if(!input?.employeeRef?.trim() || input.employeeRef.length>128 ||
       !/^\d+$/.test(input.grossMinor) || !/^\d+$/.test(input.deductionMinor) ||
       BigInt(input.deductionMinor)>BigInt(input.grossMinor))
       throw new BadRequestException("Invalid payroll amounts");
    return this.db.withTenantTransaction(ctx,async client=>{
      const b=await client.query("SELECT 1 FROM payroll_accrual_batch WHERE tenant_id=$1 AND id=$2 AND status='DRAFT' FOR UPDATE",
        [ctx.tenantId,input.batchId]);
      if(!b.rowCount) throw new ConflictException("Payroll batch not found or approved");
      const employeeRef=input.employeeRef.trim();
      await client.query(
        `DELETE FROM payroll_accrual_component
         WHERE tenant_id=$1
           AND batch_id=$2
           AND employee_ref=$3
           AND source_type='LEGACY_LINE'`,
        [ctx.tenantId,input.batchId,employeeRef]
      );
      await client.query(
        `INSERT INTO payroll_accrual_component(
           tenant_id,batch_id,employee_ref,source_type,source_key,
           gross_minor,deduction_minor,metadata
         ) VALUES($1,$2,$3,'MANUAL','manual',$4,$5,'{}'::jsonb)
         ON CONFLICT(
           tenant_id,batch_id,employee_ref,source_type,source_key
         ) DO UPDATE SET
           gross_minor=EXCLUDED.gross_minor,
           deduction_minor=EXCLUDED.deduction_minor,
           updated_at=now()`,
        [
          ctx.tenantId,input.batchId,employeeRef,
          input.grossMinor,input.deductionMinor
        ]
      );
      const r=await client.query(
        `SELECT id,employee_ref,gross_minor::text,deduction_minor::text
         FROM payroll_accrual_line
         WHERE tenant_id=$1 AND batch_id=$2 AND employee_ref=$3`,
        [ctx.tenantId,input.batchId,employeeRef]
      );
      return r.rows[0];
    });
  }

  async batchLines(ctx:TenantContext,batchId:string) {
    return this.db.withTenantTransaction(ctx,async client=>{
      const batch=await client.query(
        `SELECT 1 FROM payroll_accrual_batch
         WHERE tenant_id=$1 AND id=$2`,
        [ctx.tenantId,batchId]
      );
      if(!batch.rowCount) throw new NotFoundException("Payroll batch not found");

      const lines=await client.query(
        `SELECT
           l.id,l.employee_ref,l.gross_minor::text,l.deduction_minor::text,
           coalesce((
             SELECT json_agg(json_build_object(
               'id',c.id,
               'sourceType',c.source_type,
               'sourceKey',c.source_key,
               'grossMinor',c.gross_minor::text,
               'deductionMinor',c.deduction_minor::text,
               'metadata',c.metadata
             ) ORDER BY c.source_type,c.source_key)
             FROM payroll_accrual_component c
             WHERE c.tenant_id=l.tenant_id
               AND c.batch_id=l.batch_id
               AND c.employee_ref=l.employee_ref
           ),'[]'::json) AS components
         FROM payroll_accrual_line l
         WHERE l.tenant_id=$1 AND l.batch_id=$2
         ORDER BY l.employee_ref`,
        [ctx.tenantId,batchId]
      );
      return lines.rows;
    });
  }

  async batchSummary(ctx:TenantContext,batchId:string) {
    return this.db.withTenantTransaction(ctx,async client=>{
      const batch=await client.query(
        `SELECT b.id,b.legal_entity_id,b.period_from,b.period_to,b.status,b.currency,
          b.approved_at,b.approved_by_membership_id,
          count(l.id)::integer AS employee_count,
          coalesce(sum(l.gross_minor),0)::text AS gross_minor,
          coalesce(sum(l.deduction_minor),0)::text AS deductions_minor,
          coalesce(sum(l.gross_minor-l.deduction_minor),0)::text AS net_preview_minor
         FROM payroll_accrual_batch b LEFT JOIN payroll_accrual_line l
          ON l.tenant_id=b.tenant_id AND l.batch_id=b.id
         WHERE b.tenant_id=$1 AND b.id=$2 GROUP BY b.id`,
        [ctx.tenantId,batchId]);
      if(!batch.rows[0]) throw new NotFoundException("Payroll batch not found");
      return batch.rows[0];
    });
  }

  async prepareExport(ctx:TenantContext,input:{batchId:string;kind:"ACCOUNTING_PREVIEW"|"PAYMENT_PREVIEW"}) {
    if(!input?.batchId || !["ACCOUNTING_PREVIEW","PAYMENT_PREVIEW"].includes(input.kind))
      throw new BadRequestException("Invalid payroll preview export");
    return this.db.withTenantTransaction(ctx,async client=>{
      const batch=await client.query<{status:string}>(
        `SELECT status FROM payroll_accrual_batch WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [ctx.tenantId,input.batchId]);
      if(!batch.rows[0]) throw new NotFoundException("Payroll batch not found");
      if(batch.rows[0].status!=="APPROVED")
        throw new ConflictException("Approve payroll batch before preparing export");
      const result=await client.query<{id:string}>(
        `INSERT INTO payroll_accrual_export(tenant_id,batch_id,export_kind,prepared_by_membership_id)
         VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,batch_id,export_kind)
         DO NOTHING RETURNING id`,
        [ctx.tenantId,input.batchId,input.kind,ctx.membershipId]);
      if(result.rows[0]) return {id:result.rows[0].id,prepared:true};
      const existing=await client.query<{id:string}>(
        `SELECT id FROM payroll_accrual_export WHERE tenant_id=$1 AND batch_id=$2 AND export_kind=$3`,
        [ctx.tenantId,input.batchId,input.kind]);
      return {id:existing.rows[0]!.id,prepared:false};
    });
  }

  private async assertNoOpenPayrollDisputes(
    client:any,
    tenantId:string,
    batchId:string
  ){
    const disputed=await client.query(
      `SELECT pr.id
       FROM payroll_statement_review pr
       WHERE pr.tenant_id=$1
         AND pr.review_status='DISPUTED'
         AND (
           (
             pr.statement_kind='DANCE_TRAINER'
             AND EXISTS(
               SELECT 1
               FROM trainer_payroll_statement s
               WHERE s.tenant_id=pr.tenant_id
                 AND s.id=pr.statement_id
                 AND s.payroll_batch_id=$2
             )
           )
           OR
           (
             pr.statement_kind='SERVICE_EMPLOYEE'
             AND EXISTS(
               SELECT 1
               FROM service_employee_payroll_statement s
               WHERE s.tenant_id=pr.tenant_id
                 AND s.id=pr.statement_id
                 AND s.payroll_batch_id=$2
             )
           )
         )
       LIMIT 1`,
      [tenantId,batchId]
    );
    if(disputed.rowCount){
      throw new ConflictException(
        "Payroll содержит спорную ведомость. Закройте спор до утверждения или выплаты."
      );
    }
  }

  async markPaid(
    ctx:TenantContext,
    batchId:string,
    input?:{
      paidAt?:string;
      reference?:string;
      note?:string;
    }
  ) {
    const paidAt=input?.paidAt?new Date(input.paidAt):new Date();
    if(Number.isNaN(paidAt.getTime())){
      throw new BadRequestException("Invalid payroll payment date");
    }
    const reference=input?.reference?.trim()||null;
    const note=input?.note?.trim()||null;
    if(reference&&reference.length>180){
      throw new BadRequestException("Payroll payment reference is too long");
    }
    if(note&&note.length>500){
      throw new BadRequestException("Payroll payment note is too long");
    }

    return this.db.withTenantTransaction(ctx,async client=>{
      const batch=await client.query<{
        status:string;
        paid_at:Date|null;
        payment_reference:string|null;
      }>(
        `SELECT status,paid_at,payment_reference
         FROM payroll_accrual_batch
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [ctx.tenantId,batchId]
      );
      const row=batch.rows[0];
      if(!row) throw new NotFoundException("Payroll batch not found");
      if(row.status==="PAID"){
        return {
          status:"PAID",
          changed:false,
          paidAt:row.paid_at,
          reference:row.payment_reference
        };
      }
      if(row.status!=="APPROVED"){
        throw new ConflictException(
          "Payroll batch must be approved before payment"
        );
      }

      await this.assertNoOpenPayrollDisputes(client,ctx.tenantId,batchId);

      const result=await client.query<{
        paid_at:Date;
        payment_reference:string|null;
      }>(
        `UPDATE payroll_accrual_batch
         SET status='PAID',
             paid_at=$3,
             paid_by_membership_id=$4,
             payment_reference=$5,
             payment_note=$6
         WHERE tenant_id=$1 AND id=$2 AND status='APPROVED'
         RETURNING paid_at,payment_reference`,
        [
          ctx.tenantId,batchId,paidAt,ctx.membershipId,
          reference,note
        ]
      );
      if(!result.rows[0]){
        throw new ConflictException("Payroll batch changed concurrently");
      }
      return {
        status:"PAID",
        changed:true,
        paidAt:result.rows[0].paid_at,
        reference:result.rows[0].payment_reference
      };
    });
  }

  async approve(ctx:TenantContext,batchId:string) {
    return this.db.withTenantTransaction(ctx,async client=>{
      const b=await client.query<{status:string}>(
        `SELECT status
         FROM payroll_accrual_batch
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [ctx.tenantId,batchId]
      );
      const row=b.rows[0];
      if(!row) throw new NotFoundException("Payroll batch not found");
      if(row.status==="APPROVED"){
        return {status:"APPROVED",changed:false};
      }
      if(row.status==="PAID"){
        throw new ConflictException("Paid payroll batch cannot be reopened");
      }
      if(row.status!=="DRAFT"){
        throw new ConflictException("Payroll batch cannot be approved");
      }

      await this.assertNoOpenPayrollDisputes(client,ctx.tenantId,batchId);

      const lines=await client.query<{count:number}>(
        `SELECT count(*)::integer AS count
         FROM payroll_accrual_line
         WHERE tenant_id=$1 AND batch_id=$2`,
        [ctx.tenantId,batchId]
      );
      if((lines.rows[0]?.count??0)<1){
        throw new ConflictException("Cannot approve empty payroll batch");
      }

      const updated=await client.query(
        `UPDATE payroll_accrual_batch
         SET status='APPROVED',
             approved_by_membership_id=$3,
             approved_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='DRAFT'
         RETURNING id`,
        [ctx.tenantId,batchId,ctx.membershipId]
      );
      if(!updated.rowCount){
        throw new ConflictException("Payroll batch changed concurrently");
      }
      return {status:"APPROVED",changed:true};
    });
  }
}
