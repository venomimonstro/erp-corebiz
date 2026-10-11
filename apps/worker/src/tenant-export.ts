import { createHash } from "node:crypto";
import {createGzip} from "node:zlib";
import {Readable,Writable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {csvBatch} from "./export-safety.js";
import { Pool, type PoolClient } from "pg";

type ExportJob = {
  job_id: string;
  tenant_id: string;
  requested_by_membership_id: string;
  format: "JSON_GZIP" | "CSV_GZIP";
  schema_version: string;
  attempts: number;
};

type ExportEntity = {
  table: string;
  label: string;
};

const EXPORT_ENTITIES: ExportEntity[] = [
  { table: "legal_entity", label: "legal_entities" },
  { table: "branch", label: "branches" },
  { table: "team", label: "teams" },
  { table: "party", label: "parties" },
  { table: "party_role", label: "party_roles" },
  { table: "party_relationship", label: "party_relationships" },
  { table: "dance_student", label: "dance_students" },
  { table: "dance_program", label: "dance_programs" },
  { table: "dance_group", label: "dance_groups" },
  { table: "dance_group_member", label: "dance_group_members" },
  { table: "dance_group_waitlist", label: "dance_group_waitlist" },
  { table: "dance_lesson", label: "dance_lessons" },
  { table: "dance_lesson_participant", label: "dance_lesson_participants" },
  { table: "dance_package_redemption", label: "dance_package_redemptions" },
  { table: "dance_makeup_credit", label: "dance_makeup_credits" },
  { table: "dance_student_charge", label: "dance_student_charges" },
  { table: "crm_pipeline", label: "crm_pipelines" },
  { table: "crm_stage", label: "crm_stages" },
  { table: "crm_deal", label: "crm_deals" },
  { table: "crm_deal_stage_history", label: "crm_deal_stage_history" },
  { table: "crm_tag", label: "crm_tags" },
  { table: "crm_deal_tag", label: "crm_deal_tags" },
  { table: "crm_note", label: "crm_notes" },
  { table: "crm_activity", label: "crm_activities" },
  { table: "crm_automation_rule", label: "crm_automation_rules" },
  { table: "task", label: "tasks" },
  { table: "work_project", label: "projects" },
  { table: "work_project_milestone", label: "project_milestones" },
  { table: "work_project_time_entry", label: "project_time_entries" },
  { table: "work_project_member", label: "project_members" },
  { table: "work_project_deliverable", label: "project_deliverables" },
  { table: "work_project_monthly_statement", label: "project_monthly_statements" },
  { table: "work_project_client_approval", label: "project_client_approvals" },
  { table: "product", label: "products" },
  { table: "product_variant", label: "product_variants" },
  { table: "sku", label: "skus" },
  { table: "sales_order", label: "sales_orders" },
  { table: "sales_order_line", label: "sales_order_lines" },
  { table: "party_commercial_terms", label: "party_commercial_terms" },
  { table: "party_sku_price", label: "party_sku_prices" },
  { table: "purchase_order", label: "purchase_orders" },
  { table: "purchase_order_line", label: "purchase_order_lines" },
  { table: "goods_receipt", label: "goods_receipts" },
  { table: "goods_receipt_line", label: "goods_receipt_lines" },
  { table: "warehouse", label: "warehouses" },
  { table: "inventory_balance", label: "inventory_balances" },
  { table: "inventory_transaction", label: "inventory_transactions" },
  { table: "inventory_reservation", label: "inventory_reservations" },
  { table: "cash_account", label: "cash_accounts" },
  { table: "cash_flow_category", label: "cash_flow_categories" },
  { table: "financial_obligation", label: "financial_obligations" },
  { table: "payment", label: "payments" },
  { table: "payment_allocation", label: "payment_allocations" },
  { table: "accounting_account", label: "accounting_accounts" },
  { table: "accounting_period", label: "accounting_periods" },
  { table: "accounting_journal_entry", label: "accounting_journal_entries" },
  { table: "accounting_policy", label: "accounting_policies" },
  { table: "accounting_posting_rule", label: "accounting_posting_rules" },
  { table: "accounting_vat_document", label: "accounting_vat_documents" },
  { table: "accounting_vat_register", label: "accounting_vat_registers" },
  { table: "accounting_tax_profile", label: "accounting_tax_profiles" },
  { table: "accounting_npd_receipt", label: "accounting_npd_receipts" },
  { table: "accounting_npd_month", label: "accounting_npd_months" },
  { table: "accounting_compliance_obligation", label: "accounting_compliance_obligations" },
  { table: "accounting_compliance_event", label: "accounting_compliance_events" },
  { table: "accounting_reporting_connector", label: "accounting_reporting_connectors" },
  { table: "accounting_tax_calculation", label: "accounting_tax_calculations" },
  { table: "accounting_filing_package", label: "accounting_filing_packages" },
  { table: "accounting_submission_attempt", label: "accounting_submission_attempts" },
  { table: "accounting_ens_snapshot", label: "accounting_ens_snapshots" },
  { table: "accounting_compliance_packet", label: "accounting_compliance_packets" },
  { table: "accounting_compliance_line", label: "accounting_compliance_lines" },
  { table: "accounting_compliance_receipt", label: "accounting_compliance_receipts" },
  { table: "accounting_tax_payment_classification", label: "accounting_tax_payment_classifications" },
  { table: "accounting_tax_ledger_item", label: "accounting_tax_ledger_items" },
  { table: "service_catalog_item", label: "services" },
  { table: "service_asset", label: "service_assets" },
  { table: "automotive_vehicle", label: "automotive_vehicles" },
  { table: "automotive_work_order", label: "automotive_work_orders" },
  { table: "automotive_work_order_line", label: "automotive_work_order_lines" },
  { table: "automotive_part_fitment", label: "automotive_part_fitments" },
  { table: "automotive_donor_vehicle", label: "automotive_donor_vehicles" },
  { table: "automotive_dismantled_part", label: "automotive_dismantled_parts" },
  { table: "service_package_plan", label: "service_package_plans" },
  { table: "service_package", label: "service_packages" },
  { table: "service_package_redemption", label: "service_package_redemptions" },
  { table: "service_package_beneficiary", label: "service_package_beneficiaries" },
  { table: "service_package_plan_entitlement", label: "service_package_plan_entitlements" },
  { table: "service_package_entitlement", label: "service_package_entitlements" },
  { table: "service_package_freeze", label: "service_package_freezes" },
  { table: "service_resource", label: "service_resources" },
  { table: "service_booking", label: "service_bookings" },
  { table: "service_booking_charge", label: "service_booking_charges" },
  { table: "service_booking_resource", label: "service_booking_resources" },
  { table: "service_booking_material", label: "service_booking_materials" },
  { table: "service_delivery_rule", label: "service_delivery_rules" },
  { table: "service_technology_card", label: "service_technology_cards" },
  { table: "service_technology_card_line", label: "service_technology_card_lines" },
  { table: "service_resource_zone", label: "service_resource_zones" },
  { table: "service_employee_compensation_plan", label: "service_employee_compensation_plans" },
  { table: "service_employee_compensation_component", label: "service_employee_compensation_components" },
  { table: "service_employee_payroll_profile", label: "service_employee_payroll_profiles" },
  { table: "service_booking_profitability", label: "service_booking_profitability" },
  { table: "service_employee_booking_accrual", label: "service_employee_booking_accruals" },
  { table: "service_employee_payroll_statement", label: "service_employee_payroll_statements" },
  { table: "service_waitlist_entry", label: "service_waitlist_entries" },
  { table: "trainer_compensation_plan", label: "trainer_compensation_plans" },
  { table: "trainer_compensation_component", label: "trainer_compensation_components" },
  { table: "trainer_payroll_profile", label: "trainer_payroll_profiles" },
  { table: "trainer_payroll_statement", label: "trainer_payroll_statements" },
  { table: "trainer_payroll_adjustment", label: "trainer_payroll_adjustments" },
  { table: "trainer_compensation_accrual", label: "trainer_compensation_accruals" },
  { table: "room_rental_contract", label: "room_rental_contracts" },
  { table: "room_rental_slot", label: "room_rental_slots" },
  { table: "room_rental_statement", label: "room_rental_statements" },
  { table: "dance_lesson_profitability", label: "dance_lesson_profitability" },
  { table: "site", label: "sites" },
  { table: "site_page", label: "site_pages" },
  { table: "site_page_version", label: "site_page_versions" },
  { table: "storefront_config", label: "storefront_configs" },
  { table: "support_ticket", label: "support_tickets" },
  { table: "support_message", label: "support_messages" },
  { table: "marketing_campaign", label: "marketing_campaigns" },
  { table: "marketing_daily_stat", label: "marketing_daily_stats" },
  { table: "attribution_result", label: "attribution_results" },
  { table: "oms_order", label: "oms_orders" },
  { table: "oms_backorder_line", label: "oms_backorders" },
  { table: "return_request", label: "return_requests" },
  { table: "return_request_line", label: "return_request_lines" },
  { table: "warehouse_task", label: "wms_tasks" },
  { table: "inventory_owner", label: "inventory_owners" },
  { table: "accounting_entry", label: "accounting_entries" },
  { table: "accounting_entry_line", label: "accounting_entry_lines" },
  { table: "payroll_statement_review", label: "payroll_statement_reviews" },
  { table: "payroll_statement_review_event", label: "payroll_statement_review_events" },
  { table: "payroll_accrual_batch", label: "payroll_batches" },
  { table: "payroll_accrual_component", label: "payroll_accrual_components" },
  { table: "payroll_accrual_line", label: "payroll_lines" }
];

const SECRET_KEY =
  /(password|secret|token|credential|authorization|cookie|session|api[_-]?key|private[_-]?key|webhook[_-]?secret|ciphertext|hash)$/i;

const MAX_RAW_BYTES = 200 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const PAGE_SIZE = 5000;

async function tenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>,
  readOnlySnapshot = false
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    if(readOnlySnapshot){
      // Consistent as-of-start snapshot across all tables: do not combine
      // invoices from one moment with payments from another.
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await client.query("SET LOCAL statement_timeout = '45s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    }
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true)",
      [tenantId]
    );
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claim(pool: Pool): Promise<ExportJob | null> {
  const result = await pool.query<ExportJob>(
    "SELECT * FROM corebiz_claim_tenant_export_job()"
  );
  return result.rows[0] ?? null;
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanValue);
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (SECRET_KEY.test(key)) continue;
      output[key] = cleanValue(child);
    }
    return output;
  }

  return value;
}

async function tableExists(
  client: PoolClient,
  table: string
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    ["public." + table]
  );
  return Boolean(result.rows[0]?.exists);
}

async function hasTenantId(
  client: PoolClient,
  table: string
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name=$1
         AND column_name='tenant_id'
     ) AS exists`,
    [table]
  );
  return Boolean(result.rows[0]?.exists);
}

async function hasId(
  client: PoolClient,
  table: string
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name=$1
         AND column_name='id'
     ) AS exists`,
    [table]
  );
  return Boolean(result.rows[0]?.exists);
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error("UNSAFE_EXPORT_IDENTIFIER");
  }
  return '"' + value.replace(/"/g, '""') + '"';
}


async function* readEntity(
  client:PoolClient,tenantId:string,entity:ExportEntity
):AsyncGenerator<Record<string,unknown>[]>{
  if(!(await tableExists(client,entity.table))||
     !(await hasTenantId(client,entity.table)))return;
  const table=quoteIdentifier(entity.table);
  const byId=await hasId(client,entity.table);
  let lastId:unknown=null;
  let offset=0;
  for(;;){
    const query=byId
      ?"SELECT * FROM "+table+" WHERE tenant_id=$1 "+
        (lastId===null?"":"AND id>$3 ")+"ORDER BY id LIMIT $2"
      :"SELECT * FROM "+table+" WHERE tenant_id=$1 ORDER BY tenant_id LIMIT $2 OFFSET $3";
    const params=byId?(lastId===null?[tenantId,PAGE_SIZE]:[tenantId,PAGE_SIZE,lastId])
      :[tenantId,PAGE_SIZE,offset];
    const result=await client.query<Record<string,unknown>>(query,params);
    if(!result.rows.length)break;
    yield result.rows.map(row=>cleanValue(row) as Record<string,unknown>);
    if(byId){
      const tail=result.rows[result.rows.length-1]?.id;
      if(tail===null||tail===undefined||tail===lastId)
        throw new Error("EXPORT_CURSOR_STALLED");
      lastId=tail;
    }else{
      offset+=result.rows.length;
    }
    if(result.rows.length<PAGE_SIZE)break;
  }
}

export async function compressExport(
  source:AsyncIterable<string>
):Promise<{artifact:Buffer;rawBytes:number;compressedBytes:number}>{
  let rawBytes=0,compressedBytes=0;
  const compressed:Buffer[]=[];
  async function* metered(){
    for await(const chunk of source){
      rawBytes+=Buffer.byteLength(chunk);
      if(rawBytes>MAX_RAW_BYTES)
        throw new Error("EXPORT_TOO_LARGE_FOR_DATABASE_ARTIFACT");
      yield chunk;
    }
  }
  const sink=new Writable({
    write(chunk:Buffer,_encoding,callback){
      compressedBytes+=chunk.length;
      if(compressedBytes>MAX_ARTIFACT_BYTES)
        return callback(new Error("EXPORT_ARTIFACT_TOO_LARGE"));
      compressed.push(Buffer.from(chunk));
      callback();
    }
  });
  await pipeline(Readable.from(metered()),createGzip({level:6}),sink);
  return {artifact:Buffer.concat(compressed,compressedBytes),rawBytes,compressedBytes};
}

async function buildArtifact(pool:Pool,job:ExportJob):Promise<{
  artifact:Buffer;manifest:Record<string,unknown>;
  filename:string;contentType:string;
}>{
  return tenantTransaction(pool,job.tenant_id,async client=>{
    const tenant=await client.query<{
      id:string;name:string;slug:string;status:string;created_at:Date;
    }>(
      "SELECT id,name,slug,status,created_at FROM tenant WHERE id=$1",
      [job.tenant_id]
    );
    const row=tenant.rows[0];
    if(!row)throw new Error("TENANT_NOT_FOUND");
    const counts:Record<string,number>={};
    const generatedAt=new Date().toISOString();

    async function* jsonChunks():AsyncGenerator<string>{
      yield '{"schemaVersion":'+JSON.stringify(job.schema_version)+
        ',"generatedAt":'+JSON.stringify(generatedAt)+
        ',"tenant":'+JSON.stringify(cleanValue(row))+',"data":{';
      let firstEntity=true;
      for(const entity of EXPORT_ENTITIES){
        let firstRow=true,count=0;
        for await(const page of readEntity(client,job.tenant_id,entity)){
          if(firstRow){
            if(!firstEntity)yield ",";
            yield JSON.stringify(entity.label)+":[";
            firstEntity=false;
          }else yield ",";
          yield page.map(item=>JSON.stringify(item)).join(",");
          count+=page.length;firstRow=false;
        }
        if(!firstRow)yield "]";
        counts[entity.label]=count;
      }
      yield '},"manifest":'+JSON.stringify({
        format:"JSON_GZIP",entityCounts:counts,
        secretPolicy:"explicit business allowlist + recursive sensitive-key redaction"
      })+"}";
    }

    async function* csvChunks():AsyncGenerator<string>{
      yield "# CoreBiz CSV bundle\n# schemaVersion="+job.schema_version+
        "\n# generatedAt="+generatedAt+"\n\n";
      for(const entity of EXPORT_ENTITIES){
        let count=0;
        let columns:string[]=[];
        for await(const page of readEntity(client,job.tenant_id,entity)){
          if(count===0){
            columns=Object.keys(page[0]??{}).sort();
            yield "# file: "+entity.label+".csv\n";
          }
          yield csvBatch(page,columns,count===0);
          count+=page.length;
        }
        counts[entity.label]=count;
        if(count)yield "\n";
      }
    }

    const {artifact,rawBytes,compressedBytes}=await compressExport(
      job.format==="JSON_GZIP"?jsonChunks():csvChunks()
    );
    return {
      artifact,manifest:{
        schemaVersion:job.schema_version,format:job.format,
        entityCounts:counts,rawBytes,compressedBytes,
        ...(job.format==="CSV_GZIP"?
          {note:"gzip-compressed multi-section CSV bundle"}:{})
      },
      filename:"corebiz-"+row.slug+"-"+generatedAt.slice(0,10)+
        (job.format==="JSON_GZIP"?".json.gz":".csv.gz"),
      contentType:"application/gzip"
    };
  },true);
}

async function succeed(
  pool: Pool,
  job: ExportJob,
  result: Awaited<ReturnType<typeof buildArtifact>>
): Promise<void> {
  const checksum = createHash("sha256")
    .update(result.artifact)
    .digest("hex");

  await tenantTransaction(pool, job.tenant_id, async (client) => {
    await client.query(
      `UPDATE tenant_export_job
       SET status='READY',
           manifest=$3,
           artifact=$4,
           content_type=$5,
           filename=$6,
           size_bytes=$7,
           checksum_sha256=$8,
           expires_at=now()+interval '7 days',
           lease_until=NULL,
           completed_at=now(),
           last_error=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [
        job.tenant_id,
        job.job_id,
        JSON.stringify(result.manifest),
        result.artifact,
        result.contentType,
        result.filename,
        result.artifact.length,
        checksum
      ]
    );

    await client.query(
      `INSERT INTO audit_event(
         tenant_id,actor_membership_id,action,
         resource_type,resource_id,after_data
       ) VALUES ($1,$2,'data.export_ready','tenant_export_job',$3,$4)`,
      [
        job.tenant_id,
        job.requested_by_membership_id,
        job.job_id,
        JSON.stringify({
          format: job.format,
          checksumSha256: checksum,
          sizeBytes: result.artifact.length
        })
      ]
    );
  });
}

async function fail(
  pool: Pool,
  job: ExportJob,
  error: unknown
): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error);

  await tenantTransaction(pool, job.tenant_id, async (client) => {
    await client.query(
      `UPDATE tenant_export_job
       SET status='FAILED',
           lease_until=CASE
             WHEN attempts < 5 THEN now()+interval '5 minutes'
             ELSE NULL
           END,
           last_error=$3,
           updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [job.tenant_id, job.job_id, message.slice(0, 2000)]
    );
  });
}

export async function processTenantExportOnce(
  pool: Pool
): Promise<boolean> {
  const job = await claim(pool);
  if (!job) return false;

  try {
    const result = await buildArtifact(pool, job);
    await succeed(pool, job, result);
  } catch (error) {
    await fail(pool, job, error);
    process.stderr.write(
      "[worker] tenant export " +
        job.job_id +
        " failed: " +
        (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, " ")
          .slice(0, 1000) +
        "\n"
    );
  }

  return true;
}
