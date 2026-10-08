import { processMarketingSyncOnce } from "./marketing-sync.js";
import { processMarketplaceSyncOnce } from "./marketplace-sync.js";
import { createDecipheriv, createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

type OutboxEvent = {
  id: string;
  tenant_id: string;
  event_name: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_membership_id: string | null;
  payload: Record<string, unknown>;
  depth: number;
  attempts: number;
};

type MarketingJob = {
  job_id: string;
  tenant_id: string;
  connection_id: string;
  provider: string;
  period_from: string;
  period_to: string;
  report_name: string;
  attempts: number;
  credentials_ciphertext: string;
  client_login: string | null;
};

type OfflineConversionJob = {
  job_id: string;
  tenant_id: string;
  connection_id: string;
  counter_id: string;
  target: string;
  credentials_ciphertext: string;
  conversion_type: string;
  conversion_id: string;
  yclid: string;
  occurred_at: Date;
  value_minor: string;
  currency: string;
  attempts: number;
};

type OfflineConversionStatusJob = {
  job_id: string;
  tenant_id: string;
  connection_id: string;
  counter_id: string;
  credentials_ciphertext: string;
  provider_upload_id: string;
};

type Condition = {
  path: string;
  operator: "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE" | "IN" | "EXISTS";
  value?: unknown;
};

type Action =
  | { type: "CREATE_TASK"; title: string; assigneeMembershipId?: string; dueInHours?: number; linkedType?: string; linkedIdPath?: string }
  | { type: "ADD_TAG"; tag: string; entityType?: string; entityIdPath?: string }
  | { type: "NOTIFY"; recipientMembershipId?: string; title: string; body?: string; linkedType?: string; linkedIdPath?: string };

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });
let stopping = false;

function readPath(source: unknown, path: string): unknown {
  const clean = path.replace(/^payload\./, "");
  if (!clean) return source;

  return clean.split(".").reduce<unknown>((current, key) => {
    if (
      current &&
      typeof current === "object" &&
      key in (current as Record<string, unknown>)
    ) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

function matches(
  conditions: Condition[],
  payload: Record<string, unknown>
): boolean {
  return conditions.every((condition) => {
    const actual = readPath(payload, condition.path);

    if (condition.operator === "EXISTS") {
      return actual !== undefined && actual !== null;
    }
    if (condition.operator === "EQ") return actual === condition.value;
    if (condition.operator === "NEQ") return actual !== condition.value;
    if (condition.operator === "IN") {
      return Array.isArray(condition.value) && condition.value.includes(actual);
    }

    const left = Number(actual);
    const right = Number(condition.value);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;

    if (condition.operator === "GT") return left > right;
    if (condition.operator === "GTE") return left >= right;
    if (condition.operator === "LT") return left < right;
    if (condition.operator === "LTE") return left <= right;
    return false;
  });
}

async function claimEvent(client: PoolClient): Promise<OutboxEvent | null> {
  const result = await client.query<OutboxEvent>(
    `SELECT id, tenant_id, event_name, entity_type, entity_id,
            actor_user_id, actor_membership_id, payload, depth, attempts
     FROM domain_event_outbox
     WHERE status IN ('PENDING','FAILED')
       AND next_attempt_at <= now()
       AND attempts < 5
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1`
  );

  const event = result.rows[0];
  if (!event) return null;

  await client.query(
    `UPDATE domain_event_outbox
     SET status = 'PROCESSING',
         locked_at = now(),
         attempts = attempts + 1
     WHERE id = $1`,
    [event.id]
  );

  return event;
}

async function executeAction(
  client: PoolClient,
  event: OutboxEvent,
  action: Action
): Promise<Record<string, unknown>> {
  if (action.type === "CREATE_TASK") {
    const responsible =
      action.assigneeMembershipId ??
      event.actor_membership_id;

    if (!responsible) {
      throw new Error("CREATE_TASK has no assignee");
    }

    const member = await client.query(
      `SELECT 1 FROM tenant_membership
       WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [event.tenant_id, responsible]
    );
    if (!member.rowCount) throw new Error("CREATE_TASK assignee unavailable");

    const linkedId = action.linkedIdPath
      ? String(readPath(event.payload, action.linkedIdPath) ?? "")
      : event.entity_id;

    const dueAt =
      action.dueInHours && action.dueInHours > 0
        ? new Date(Date.now() + action.dueInHours * 3600000)
        : null;

    const result = await client.query<{ id: string }>(
      `INSERT INTO task(
         tenant_id, title, type, priority, due_at,
         responsible_membership_id, linked_type, linked_id,
         created_by_membership_id
       ) VALUES ($1,$2,'OTHER','NORMAL',$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        event.tenant_id,
        action.title.trim(),
        dueAt,
        responsible,
        action.linkedType?.trim().toUpperCase() ?? event.entity_type,
        linkedId || null,
        event.actor_membership_id ?? responsible
      ]
    );

    return { type: action.type, taskId: result.rows[0]!.id };
  }

  if (action.type === "ADD_TAG") {
    const entityId = action.entityIdPath
      ? String(readPath(event.payload, action.entityIdPath) ?? "")
      : event.entity_id;
    const entityType = action.entityType ?? event.entity_type;

    if (!entityId || !entityType) {
      throw new Error("ADD_TAG has no entity");
    }

    await client.query(
      `INSERT INTO entity_tag(
         tenant_id, entity_type, entity_id, tag, created_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [
        event.tenant_id,
        entityType,
        entityId,
        action.tag.trim(),
        event.actor_membership_id
      ]
    );

    return { type: action.type, tag: action.tag };
  }

  const recipient =
    action.recipientMembershipId ??
    event.actor_membership_id;

  if (!recipient) {
    throw new Error("NOTIFY has no recipient");
  }

  const linkedId = action.linkedIdPath
    ? String(readPath(event.payload, action.linkedIdPath) ?? "")
    : event.entity_id;

  const result = await client.query<{ id: string }>(
    `INSERT INTO notification(
       tenant_id, recipient_membership_id, kind,
       title, body, linked_type, linked_id
     ) VALUES ($1,$2,'WORKFLOW',$3,$4,$5,$6)
     RETURNING id`,
    [
      event.tenant_id,
      recipient,
      action.title.trim(),
      action.body?.trim() || null,
      action.linkedType ?? event.entity_type,
      linkedId || null
    ]
  );

  return { type: action.type, notificationId: result.rows[0]!.id };
}

async function processEvent(event: OutboxEvent): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      [event.tenant_id]
    );

    const workflows = await client.query<{
      workflow_id: string;
      version_id: string;
      conditions: Condition[];
      actions: Action[];
    }>(
      `SELECT
         d.id AS workflow_id,
         v.id AS version_id,
         v.conditions,
         v.actions
       FROM workflow_definition d
       JOIN workflow_version v
         ON v.tenant_id = d.tenant_id
        AND v.workflow_id = d.id
        AND v.status = 'PUBLISHED'
       WHERE d.tenant_id = $1
         AND d.enabled = true
         AND d.trigger_event = $2
         AND (d.entity_type IS NULL OR d.entity_type = $3)`,
      [event.tenant_id, event.event_name, event.entity_type]
    );

    for (const workflow of workflows.rows) {
      const existing = await client.query(
        `SELECT 1 FROM workflow_execution
         WHERE workflow_version_id = $1 AND event_id = $2`,
        [workflow.version_id, event.id]
      );
      if (existing.rowCount) continue;

      const conditions = Array.isArray(workflow.conditions)
        ? workflow.conditions
        : [];
      const actions = Array.isArray(workflow.actions)
        ? workflow.actions
        : [];

      if (!matches(conditions, event.payload)) {
        await client.query(
          `INSERT INTO workflow_execution(
             tenant_id, workflow_id, workflow_version_id,
             event_id, status, depth, input_payload, finished_at
           ) VALUES ($1,$2,$3,$4,'SKIPPED',$5,$6,now())`,
          [
            event.tenant_id,
            workflow.workflow_id,
            workflow.version_id,
            event.id,
            event.depth,
            JSON.stringify(event.payload)
          ]
        );
        continue;
      }

      if (event.depth >= 5) {
        throw new Error("Workflow recursion depth limit reached");
      }

      const execution = await client.query<{ id: string }>(
        `INSERT INTO workflow_execution(
           tenant_id, workflow_id, workflow_version_id,
           event_id, status, depth, input_payload
         ) VALUES ($1,$2,$3,$4,'RUNNING',$5,$6)
         RETURNING id`,
        [
          event.tenant_id,
          workflow.workflow_id,
          workflow.version_id,
          event.id,
          event.depth,
          JSON.stringify(event.payload)
        ]
      );

      const outputs: Record<string, unknown>[] = [];

      try {
        for (const action of actions) {
          outputs.push(await executeAction(client, event, action));
        }

        await client.query(
          `UPDATE workflow_execution
           SET status = 'SUCCEEDED',
               output_payload = $2,
               finished_at = now()
           WHERE id = $1`,
          [execution.rows[0]!.id, JSON.stringify({ actions: outputs })]
        );
      } catch (error) {
        await client.query(
          `UPDATE workflow_execution
           SET status = 'FAILED',
               error_message = $2,
               finished_at = now()
           WHERE id = $1`,
          [
            execution.rows[0]!.id,
            error instanceof Error ? error.message : String(error)
          ]
        );
        throw error;
      }
    }

    await client.query(
      `UPDATE domain_event_outbox
       SET status = 'PROCESSED',
           processed_at = now(),
           locked_at = NULL,
           last_error = NULL
       WHERE id = $1`,
      [event.id]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    const delaySeconds = Math.min(
      300,
      2 ** Math.min(event.attempts + 1, 8)
    );

    await pool.query(
      `UPDATE domain_event_outbox
       SET status = 'FAILED',
           locked_at = NULL,
           last_error = $2,
           next_attempt_at = now() + ($3::text || ' seconds')::interval
       WHERE id = $1`,
      [
        event.id,
        error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        String(delaySeconds)
      ]
    );

    process.stderr.write(
      `[worker] outbox ${event.id} failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  } finally {
    client.release();
  }
}

function decryptIntegrationSecret(
  payload: string
): Record<string, unknown> {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required for integration jobs");
  }

  const [version, ivRaw, tagRaw, dataRaw] = payload.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error("INTEGRATION_SECRET_FORMAT_INVALID");
  }

  const key = createHash("sha256")
    .update(sessionSecret + "|corebiz-integrations-v1")
    .digest();

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64url")),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8")) as Record<string, unknown>;
}

async function claimMarketingJob(): Promise<MarketingJob | null> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<MarketingJob>(
      "SELECT * FROM corebiz_claim_marketing_sync_job()"
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function moneyToMinor(value: string): string {
  const normalized = value.trim().replace(",", ".");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("YANDEX_COST_INVALID");
  }
  return String(Math.round(amount * 100));
}

async function postponeMarketingJob(
  job: MarketingJob,
  retrySeconds: number,
  status: "WAITING_PROVIDER" | "FAILED",
  errorMessage?: string
): Promise<void> {
  const safeDelay = Math.max(5, Math.min(3600, Math.floor(retrySeconds)));

  await pool.query(
    "UPDATE marketing_sync_job SET status=$2,retry_at=now()+($3::text || ' seconds')::interval," +
    "last_error=$4 WHERE id=$1",
    [
      job.job_id,
      status,
      String(safeDelay),
      errorMessage?.slice(0, 2000) ?? null
    ]
  );
}

async function processMarketingJob(job: MarketingJob): Promise<void> {
  if (job.provider !== "YANDEX_DIRECT") {
    await postponeMarketingJob(
      job,
      3600,
      "FAILED",
      "Unsupported marketing provider"
    );
    return;
  }

  try {
    const credentials = decryptIntegrationSecret(job.credentials_ciphertext);
    const oauthToken = String(credentials.oauthToken ?? "");
    if (!oauthToken) throw new Error("YANDEX_OAUTH_TOKEN_MISSING");

    const headers: Record<string, string> = {
      "Authorization": "Bearer " + oauthToken,
      "Accept-Language": "ru",
      "Content-Type": "application/json",
      "processingMode": "auto",
      "returnMoneyInMicros": "false",
      "skipReportHeader": "true",
      "skipColumnHeader": "true",
      "skipReportSummary": "true"
    };

    if (job.client_login) {
      headers["Client-Login"] = job.client_login;
    }

    const body = {
      params: {
        SelectionCriteria: {
          DateFrom: job.period_from,
          DateTo: job.period_to
        },
        FieldNames: [
          "Date",
          "CampaignId",
          "CampaignName",
          "Impressions",
          "Clicks",
          "Cost"
        ],
        ReportName: job.report_name,
        ReportType: "CUSTOM_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "NO",
        IncludeDiscount: "NO"
      }
    };

    const response = await fetch(
      "https://api.direct.yandex.com/json/v501/reports",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }
    );

    if (response.status === 201 || response.status === 202) {
      const retryIn = Number(response.headers.get("retryIn") ?? "30");
      await postponeMarketingJob(
        job,
        Number.isFinite(retryIn) ? retryIn : 30,
        "WAITING_PROVIDER"
      );
      return;
    }

    const text = await response.text();

    if (response.status !== 200) {
      throw new Error(
        "YANDEX_DIRECT_HTTP_" +
        response.status +
        ":" +
        text.replace(/\s+/g, " ").slice(0, 500)
      );
    }

    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true)",
        [job.tenant_id]
      );

      for (const line of rows) {
        const columns = line.split("\t");
        if (columns.length < 6) continue;

        const [
          statDate,
          campaignExternalId,
          campaignName,
          impressionsRaw,
          clicksRaw,
          costRaw
        ] = columns;

        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(statDate ?? "") ||
          !campaignExternalId
        ) {
          continue;
        }

        const impressions = Math.max(0, Number(impressionsRaw ?? "0") || 0);
        const clicks = Math.max(0, Number(clicksRaw ?? "0") || 0);
        const spendMinor = moneyToMinor(costRaw ?? "0");

        const campaign = await client.query<{ id: string }>(
          "INSERT INTO marketing_campaign(" +
          "tenant_id,connection_id,external_campaign_id,name,status,currency" +
          ") VALUES ($1,$2,$3,$4,'UNKNOWN','RUB') " +
          "ON CONFLICT (connection_id,external_campaign_id) DO UPDATE SET " +
          "name=EXCLUDED.name,updated_at=now() RETURNING id",
          [
            job.tenant_id,
            job.connection_id,
            campaignExternalId,
            (campaignName || "Campaign " + campaignExternalId).slice(0, 500)
          ]
        );

        await client.query(
          "INSERT INTO marketing_campaign_alias(" +
          "tenant_id,campaign_id,alias_type,alias_value" +
          ") VALUES ($1,$2,'EXTERNAL_ID',$3) ON CONFLICT DO NOTHING",
          [
            job.tenant_id,
            campaign.rows[0]!.id,
            campaignExternalId
          ]
        );

        if (campaignName) {
          await client.query(
            "INSERT INTO marketing_campaign_alias(" +
            "tenant_id,campaign_id,alias_type,alias_value" +
            ") VALUES ($1,$2,'NAME',$3) ON CONFLICT DO NOTHING",
            [
              job.tenant_id,
              campaign.rows[0]!.id,
              campaignName.slice(0, 500)
            ]
          );
        }

        await client.query(
          "INSERT INTO marketing_daily_stat(" +
          "tenant_id,connection_id,campaign_id,stat_date,impressions,clicks,spend_minor,raw" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) " +
          "ON CONFLICT (connection_id,campaign_id,stat_date) DO UPDATE SET " +
          "impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks," +
          "spend_minor=EXCLUDED.spend_minor,raw=EXCLUDED.raw,updated_at=now()",
          [
            job.tenant_id,
            job.connection_id,
            campaign.rows[0]!.id,
            statDate,
            Math.trunc(impressions),
            Math.trunc(clicks),
            spendMinor,
            JSON.stringify({ provider: "YANDEX_DIRECT" })
          ]
        );
      }

      await client.query(
        "UPDATE marketing_sync_job SET status='SUCCEEDED',retry_at=NULL,last_error=NULL," +
        "finished_at=now() WHERE tenant_id=$1 AND id=$2",
        [job.tenant_id, job.job_id]
      );

      await client.query(
        "UPDATE marketing_connection SET status='ACTIVE',last_synced_at=now()," +
        "last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [job.tenant_id, job.connection_id]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    const retrySeconds = Math.min(
      1800,
      2 ** Math.min(job.attempts + 2, 10)
    );

    await postponeMarketingJob(
      job,
      retrySeconds,
      "FAILED",
      message
    );

    await pool.query(
      "UPDATE marketing_connection SET status='DEGRADED',last_error=$3,updated_at=now() " +
      "WHERE tenant_id=$1 AND id=$2",
      [job.tenant_id, job.connection_id, message.slice(0, 2000)]
    );

    process.stderr.write(
      "[worker] marketing job " +
      job.job_id +
      " failed: " +
      message.replace(/\s+/g, " ").slice(0, 500) +
      "\n"
    );
  }
}

async function claimOfflineConversionJob(): Promise<OfflineConversionJob | null> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<OfflineConversionJob>(
      "SELECT * FROM corebiz_claim_offline_conversion_job()"
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimOfflineConversionStatusJob(): Promise<OfflineConversionStatusJob | null> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<OfflineConversionStatusJob>(
      "SELECT * FROM corebiz_claim_offline_conversion_status_job()"
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function csvCell(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function processOfflineConversionJob(
  job: OfflineConversionJob
): Promise<void> {
  try {
    const credentials = decryptIntegrationSecret(job.credentials_ciphertext);
    const oauthToken = String(credentials.oauthToken ?? "");
    if (!oauthToken) throw new Error("YANDEX_METRICA_OAUTH_TOKEN_MISSING");

    const timestamp = Math.floor(
      new Date(job.occurred_at).getTime() / 1000
    );
    if (!Number.isFinite(timestamp) || timestamp > Math.floor(Date.now() / 1000)) {
      throw new Error("OFFLINE_CONVERSION_DATETIME_INVALID");
    }

    const price = (Number(job.value_minor) / 100).toFixed(2);
    const csv = [
      "Yclid,Target,DateTime,Price,Currency",
      [
        csvCell(job.yclid),
        csvCell(job.target),
        String(timestamp),
        price,
        csvCell(job.currency)
      ].join(",")
    ].join("\n");

    const form = new FormData();
    form.append(
      "file",
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      "corebiz-offline-conversion.csv"
    );

    const url =
      "https://api-metrika.yandex.net/management/v1/counter/" +
      encodeURIComponent(job.counter_id) +
      "/offline_conversions/upload?type=BASIC&comment=" +
      encodeURIComponent("CoreBiz " + job.conversion_type);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "OAuth " + oauthToken
      },
      body: form
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        "YANDEX_METRIKA_UPLOAD_HTTP_" +
        response.status +
        ":" +
        body.replace(/\s+/g, " ").slice(0, 500)
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("YANDEX_METRIKA_UPLOAD_RESPONSE_INVALID");
    }

    const uploading = parsed?.uploading;
    const uploadId = uploading?.id;
    const providerStatus = String(uploading?.status ?? "UPLOADED");

    if (uploadId === undefined || uploadId === null) {
      throw new Error("YANDEX_METRIKA_UPLOAD_ID_MISSING");
    }

    await pool.query(
      "UPDATE offline_conversion_job SET status='UPLOADED'," +
      "provider_upload_id=$2,provider_status=$3,uploaded_at=now()," +
      "retry_at=now()+interval '2 minutes',last_error=NULL " +
      "WHERE id=$1",
      [job.job_id, String(uploadId), providerStatus]
    );

    await pool.query(
      "UPDATE offline_conversion_connection SET status='ACTIVE'," +
      "last_export_at=now(),last_error=NULL,updated_at=now() " +
      "WHERE tenant_id=$1 AND id=$2",
      [job.tenant_id, job.connection_id]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retrySeconds = Math.min(
      1800,
      2 ** Math.min(job.attempts + 2, 10)
    );

    await pool.query(
      "UPDATE offline_conversion_job SET status='FAILED'," +
      "retry_at=now()+($2::text || ' seconds')::interval,last_error=$3 " +
      "WHERE id=$1",
      [job.job_id, String(retrySeconds), message.slice(0, 2000)]
    );

    await pool.query(
      "UPDATE offline_conversion_connection SET status='DEGRADED'," +
      "last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [job.tenant_id, job.connection_id, message.slice(0, 2000)]
    );

    process.stderr.write(
      "[worker] offline conversion " +
      job.job_id +
      " failed: " +
      message.replace(/\s+/g, " ").slice(0, 500) +
      "\n"
    );
  }
}

async function processOfflineConversionStatus(
  job: OfflineConversionStatusJob
): Promise<void> {
  try {
    const credentials = decryptIntegrationSecret(job.credentials_ciphertext);
    const oauthToken = String(credentials.oauthToken ?? "");
    if (!oauthToken) throw new Error("YANDEX_METRIKA_OAUTH_TOKEN_MISSING");

    const url =
      "https://api-metrika.yandex.net/management/v1/counter/" +
      encodeURIComponent(job.counter_id) +
      "/offline_conversions/uploading/" +
      encodeURIComponent(job.provider_upload_id);

    const response = await fetch(url, {
      headers: {
        Authorization: "OAuth " + oauthToken
      }
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        "YANDEX_METRIKA_STATUS_HTTP_" +
        response.status +
        ":" +
        body.replace(/\s+/g, " ").slice(0, 500)
      );
    }

    const parsed = JSON.parse(body);
    const uploading = parsed?.uploading ?? parsed;
    const status = String(uploading?.status ?? "UNKNOWN");

    if (status === "PROCESSED") {
      await pool.query(
        "UPDATE offline_conversion_job SET status='PROCESSED'," +
        "provider_status=$2,processed_at=now(),retry_at=NULL,last_error=NULL " +
        "WHERE id=$1",
        [job.job_id, status]
      );
      return;
    }

    if (status === "LINKAGE_FAILURE") {
      await pool.query(
        "UPDATE offline_conversion_job SET status='FAILED'," +
        "provider_status=$2,retry_at=NULL,last_error='Yandex Metrica linkage failure' " +
        "WHERE id=$1",
        [job.job_id, status]
      );
      return;
    }

    if (["PREPARED","UPLOADED","EXPORTED","MATCHED"].includes(status)) {
      await pool.query(
        "UPDATE offline_conversion_job SET provider_status=$2," +
        "retry_at=now()+interval '2 minutes' WHERE id=$1",
        [job.job_id, status]
      );
      return;
    }

    await pool.query(
      "UPDATE offline_conversion_job SET provider_status=$2," +
      "retry_at=now()+interval '5 minutes' WHERE id=$1",
      [job.job_id, status]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      "UPDATE offline_conversion_job SET last_error=$2," +
      "retry_at=now()+interval '5 minutes' WHERE id=$1",
      [job.job_id, message.slice(0, 2000)]
    );
  }
}

async function workOnce(): Promise<boolean> {
  const client = await pool.connect();
  let event: OutboxEvent | null = null;

  try {
    await client.query("BEGIN");
    event = await claimEvent(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (event) {
    await processEvent(event);
    return true;
  }

  const marketingJob = await claimMarketingJob();
  if (marketingJob) {
    await processMarketingJob(marketingJob);
    return true;
  }

  const offlineJob = await claimOfflineConversionJob();
  if (offlineJob) {
    await processOfflineConversionJob(offlineJob);
    return true;
  }

  const offlineStatusJob = await claimOfflineConversionStatusJob();
  if (offlineStatusJob) {
    await processOfflineConversionStatus(offlineStatusJob);
    return true;
  }

  if (await processMarketplaceSyncOnce(pool)) {
    return true;
  }

  return false;
}

async function loop(): Promise<void> {
  process.stdout.write("[worker] CoreBiz background worker started\n");

  while (!stopping) {
    try {
      const workflowWorked = await workOnce();
      const marketingWorked = await processMarketingSyncOnce(pool);

      if (!workflowWorked && !marketingWorked) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      process.stderr.write(
        `[worker] loop error: ${error instanceof Error ? error.message : String(error)}\n`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  await pool.end();
  process.stdout.write("[worker] stopped\n");
}

async function shutdown(signal: string): Promise<void> {
  process.stdout.write(`[worker] received ${signal}, shutting down\n`);
  stopping = true;
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void loop();
