import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class PayrollService {
  constructor(private readonly db:DatabaseService) {}

  async batches(ctx:TenantContext,legalEntityId:string) {
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        `SELECT b.id,b.period_from,b.period_to,b.status,b.currency,b.approved_at,
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
      const r=await client.query(
        `INSERT INTO payroll_accrual_line(tenant_id,batch_id,employee_ref,gross_minor,deduction_minor)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id,batch_id,employee_ref) DO UPDATE
         SET gross_minor=EXCLUDED.gross_minor,deduction_minor=EXCLUDED.deduction_minor
         RETURNING id,employee_ref,gross_minor::text,deduction_minor::text`,
        [ctx.tenantId,input.batchId,input.employeeRef.trim(),input.grossMinor,input.deductionMinor]);
      return r.rows[0];
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

  async approve(ctx:TenantContext,batchId:string) {
    return this.db.withTenantTransaction(ctx,async client=>{
      const b=await client.query<{status:string}>(
        "SELECT status FROM payroll_accrual_batch WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [ctx.tenantId,batchId]);
      if(!b.rows[0]) throw new NotFoundException("Payroll batch not found");
      if(b.rows[0].status==="APPROVED") return {status:"APPROVED",changed:false};
      await client.query(
        `UPDATE payroll_accrual_batch SET status='APPROVED',approved_by_membership_id=$3,approved_at=now()
         WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,batchId,ctx.membershipId]);
      return {status:"APPROVED",changed:true};
    });
  }
}
