import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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
  { table: "task", label: "tasks" },
  { table: "work_project", label: "projects" },
  { table: "work_project_milestone", label: "project_milestones" },
  { table: "work_project_time_entry", label: "project_time_entries" },
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
  { table: "service_catalog_item", label: "services" },
  { table: "service_asset", label: "service_assets" },
  { table: "service_package_plan", label: "service_package_plans" },
  { table: "service_package", label: "service_packages" },
  { table: "service_package_redemption", label: "service_package_redemptions" },
  { table: "service_package_beneficiary", label: "service_package_beneficiaries" },
  { table: "service_package_plan_entitlement", label: "service_package_plan_entitlements" },
  { table: "service_package_entitlement", label: "service_package_entitlements" },
  { table: "service_package_freeze", label: "service_package_freezes" },
  { table: "service_resource", label: "service_resources" },
  { table: "service_booking", label: "service_bookings" },
  { table: "service_booking_resource", label: "service_booking_resources" },
  { table: "service_booking_material", label: "service_booking_materials" },
  { table: "trainer_compensation_plan", label: "trainer_compensation_plans" },
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
  { table: "payroll_accrual_batch", label: "payroll_batches" },
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
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
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

async function readEntity(
  client: PoolClient,
  tenantId: string,
  entity: ExportEntity,
  onRows: (rows: Record<string, unknown>[]) => void
): Promise<number> {
  if (!(await tableExists(client, entity.table))) return 0;
  if (!(await hasTenantId(client, entity.table))) return 0;

  const table = quoteIdentifier(entity.table);
  const order = (await hasId(client, entity.table))
    ? "id"
    : "tenant_id";

  let offset = 0;
  let total = 0;

  for (;;) {
    const result = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM ${table}
       WHERE tenant_id=$1
       ORDER BY ${quoteIdentifier(order)}
       LIMIT $2 OFFSET $3`,
      [tenantId, PAGE_SIZE, offset]
    );

    if (!result.rowCount) break;

    const cleaned = result.rows.map(
      (row) => cleanValue(row) as Record<string, unknown>
    );

    onRows(cleaned);
    total += cleaned.length;
    offset += cleaned.length;

    if (cleaned.length < PAGE_SIZE) break;
  }

  return total;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw =
    typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return '"' + raw.replace(/"/g, '""') + '"';
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";

  const columns = Array.from(
    rows.reduce<Set<string>>((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>())
  ).sort();

  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column])).join(",")
    )
  ].join("\n");
}

async function buildArtifact(
  pool: Pool,
  job: ExportJob
): Promise<{
  artifact: Buffer;
  manifest: Record<string, unknown>;
  filename: string;
  contentType: string;
}> {
  return tenantTransaction(pool, job.tenant_id, async (client) => {
    const tenant = await client.query<{
      id: string;
      name: string;
      slug: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT id,name,slug,status,created_at
       FROM tenant
       WHERE id=$1`,
      [job.tenant_id]
    );

    const tenantRow = tenant.rows[0];
    if (!tenantRow) throw new Error("TENANT_NOT_FOUND");

    const counts: Record<string, number> = {};
    let rawBytes = 0;

    if (job.format === "JSON_GZIP") {
      const data: Record<string, unknown[]> = {};

      for (const entity of EXPORT_ENTITIES) {
        const rows: Record<string, unknown>[] = [];
        const count = await readEntity(
          client,
          job.tenant_id,
          entity,
          (batch) => {
            rows.push(...batch);
            rawBytes += Buffer.byteLength(JSON.stringify(batch));
            if (rawBytes > MAX_RAW_BYTES) {
              throw new Error("EXPORT_TOO_LARGE_FOR_DATABASE_ARTIFACT");
            }
          }
        );
        counts[entity.label] = count;
        if (count > 0) data[entity.label] = rows;
      }

      const payload = {
        schemaVersion: job.schema_version,
        generatedAt: new Date().toISOString(),
        tenant: cleanValue(tenantRow),
        manifest: {
          format: "JSON_GZIP",
          entityCounts: counts,
          secretPolicy: "explicit business allowlist + recursive sensitive-key redaction"
        },
        data
      };

      const artifact = gzipSync(
        Buffer.from(JSON.stringify(payload), "utf8"),
        { level: 6 }
      );

      if (artifact.length > MAX_ARTIFACT_BYTES) {
        throw new Error("EXPORT_ARTIFACT_TOO_LARGE");
      }

      return {
        artifact,
        manifest: {
          schemaVersion: job.schema_version,
          format: job.format,
          entityCounts: counts,
          rawBytes,
          compressedBytes: artifact.length
        },
        filename:
          "corebiz-" +
          tenantRow.slug +
          "-" +
          new Date().toISOString().slice(0, 10) +
          ".json.gz",
        contentType: "application/gzip"
      };
    }

    const sections: string[] = [
      "# CoreBiz CSV bundle",
      "# schemaVersion=" + job.schema_version,
      "# generatedAt=" + new Date().toISOString(),
      ""
    ];

    for (const entity of EXPORT_ENTITIES) {
      const rows: Record<string, unknown>[] = [];
      const count = await readEntity(
        client,
        job.tenant_id,
        entity,
        (batch) => {
          rows.push(...batch);
          rawBytes += Buffer.byteLength(JSON.stringify(batch));
          if (rawBytes > MAX_RAW_BYTES) {
            throw new Error("EXPORT_TOO_LARGE_FOR_DATABASE_ARTIFACT");
          }
        }
      );

      counts[entity.label] = count;
      if (!count) continue;

      sections.push("# file: " + entity.label + ".csv");
      sections.push(rowsToCsv(rows));
      sections.push("");
    }

    const artifact = gzipSync(
      Buffer.from(sections.join("\n"), "utf8"),
      { level: 6 }
    );

    if (artifact.length > MAX_ARTIFACT_BYTES) {
      throw new Error("EXPORT_ARTIFACT_TOO_LARGE");
    }

    return {
      artifact,
      manifest: {
        schemaVersion: job.schema_version,
        format: job.format,
        entityCounts: counts,
        rawBytes,
        compressedBytes: artifact.length,
        note: "gzip-compressed multi-section CSV bundle"
      },
      filename:
        "corebiz-" +
        tenantRow.slug +
        "-" +
        new Date().toISOString().slice(0, 10) +
        ".csv.gz",
      contentType: "application/gzip"
    };
  });
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
