import {
  createDecipheriv,
  createHash
} from "node:crypto";
import { Pool, type PoolClient } from "pg";

type MarketingJob = {
  job_id: string;
  tenant_id: string;
  connection_id: string;
  provider: string;
  period_from: string;
  period_to: string;
  report_name: string;
  attempts: number;
};

type Connection = {
  id: string;
  credentials_ciphertext: string;
  client_login: string | null;
};

const YANDEX_REPORTS_URL =
  "https://api.direct.yandex.com/json/v501/reports";

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("SESSION_SECRET is required for marketing sync");
  }

  return createHash("sha256")
    .update(secret + "|corebiz-integrations-v1")
    .digest();
}

function decryptCredentials(
  payload: string
): { oauthToken: string } {
  const [version, ivRaw, tagRaw, dataRaw] = payload.split(".");

  if (
    version !== "v1" ||
    !ivRaw ||
    !tagRaw ||
    !dataRaw
  ) {
    throw new Error("INTEGRATION_SECRET_FORMAT_INVALID");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url")
  );

  decipher.setAuthTag(
    Buffer.from(tagRaw, "base64url")
  );

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(dataRaw, "base64url")
    ),
    decipher.final()
  ]);

  const result = JSON.parse(
    decrypted.toString("utf8")
  ) as { oauthToken?: unknown };

  if (
    typeof result.oauthToken !== "string" ||
    result.oauthToken.length < 16
  ) {
    throw new Error("YANDEX_OAUTH_TOKEN_INVALID");
  }

  return { oauthToken: result.oauthToken };
}

async function claimJob(
  pool: Pool
): Promise<MarketingJob | null> {
  const result = await pool.query<MarketingJob>(
    "SELECT * FROM corebiz_claim_marketing_sync_job()"
  );

  return result.rows[0] ?? null;
}

async function withTenantTransaction<T>(
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

function yandexHeaders(
  token: string,
  clientLogin: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + token,
    "Accept-Language": "ru",
    "Content-Type":
      "application/json; charset=utf-8",
    processingMode: "auto",
    returnMoneyInMicros: "false",
    skipReportHeader: "true",
    skipReportSummary: "true"
  };

  if (clientLogin) {
    headers["Client-Login"] = clientLogin;
  }

  return headers;
}

function reportRequest(job: MarketingJob): unknown {
  return {
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
        "Cost",
        "Conversions"
      ],
      OrderBy: [
        {
          Field: "Date"
        }
      ],
      ReportName: job.report_name,
      ReportType:
        "CAMPAIGN_PERFORMANCE_REPORT",
      DateRangeType: "CUSTOM_DATE",
      Format: "TSV",
      IncludeVAT: "YES",
      IncludeDiscount: "NO"
    }
  };
}

function parseInteger(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return 0n;
  return BigInt(normalized);
}

function parseDecimal(value: string): number {
  const normalized = value
    .trim()
    .replace(",", ".");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parseTsv(
  body: string
): Array<Record<string, string>> {
  const lines = body
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  if (lines.length < 2) return [];

  const headers = lines[0]!.split("\t");

  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(
      headers.map((header, index) => [
        header,
        cells[index] ?? ""
      ])
    );
  });
}

async function markWaiting(
  pool: Pool,
  job: MarketingJob,
  retrySeconds: number,
  requestId: string | null
): Promise<void> {
  await withTenantTransaction(
    pool,
    job.tenant_id,
    async (client) => {
      await client.query(
        `UPDATE marketing_sync_job
         SET status = 'WAITING_PROVIDER',
             retry_at =
               now() + ($3::text || ' seconds')::interval,
             provider_request_id =
               COALESCE($4, provider_request_id),
             last_error = NULL
         WHERE tenant_id = $1
           AND id = $2`,
        [
          job.tenant_id,
          job.job_id,
          String(
            Math.max(
              5,
              Math.min(300, retrySeconds)
            )
          ),
          requestId
        ]
      );
    }
  );
}

async function markFailure(
  pool: Pool,
  job: MarketingJob,
  message: string
): Promise<void> {
  const retrySeconds = Math.min(
    900,
    15 * 2 ** Math.min(job.attempts, 6)
  );

  await withTenantTransaction(
    pool,
    job.tenant_id,
    async (client) => {
      await client.query(
        `UPDATE marketing_sync_job
         SET status = 'FAILED',
             retry_at =
               CASE
                 WHEN attempts < 5
                   THEN now() +
                     ($3::text || ' seconds')::interval
                 ELSE NULL
               END,
             last_error = $4,
             finished_at =
               CASE
                 WHEN attempts >= 5 THEN now()
                 ELSE finished_at
               END
         WHERE tenant_id = $1
           AND id = $2`,
        [
          job.tenant_id,
          job.job_id,
          String(retrySeconds),
          message.slice(0, 2000)
        ]
      );

      await client.query(
        `UPDATE marketing_connection
         SET status = 'DEGRADED',
             last_error = $3,
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2`,
        [
          job.tenant_id,
          job.connection_id,
          message.slice(0, 2000)
        ]
      );
    }
  );
}

async function persistReport(
  pool: Pool,
  job: MarketingJob,
  rows: Array<Record<string, string>>
): Promise<void> {
  await withTenantTransaction(
    pool,
    job.tenant_id,
    async (client) => {
      for (const row of rows) {
        const campaignId =
          row.CampaignId?.trim();
        const campaignName =
          row.CampaignName?.trim() ||
          campaignId;
        const statDate = row.Date?.trim();

        if (
          !campaignId ||
          !campaignName ||
          !statDate
        ) {
          continue;
        }

        const campaign =
          await client.query<{ id: string }>(
            `INSERT INTO marketing_campaign(
               tenant_id,
               connection_id,
               external_campaign_id,
               name,
               currency
             ) VALUES ($1,$2,$3,$4,'RUB')
             ON CONFLICT (
               connection_id,
               external_campaign_id
             )
             DO UPDATE SET
               name = EXCLUDED.name,
               updated_at = now()
             RETURNING id`,
            [
              job.tenant_id,
              job.connection_id,
              campaignId,
              campaignName
            ]
          );

        const campaignRow =
          campaign.rows[0];

        if (!campaignRow) continue;

        const cost = parseDecimal(
          row.Cost ?? "0"
        );

        const spendMinor = BigInt(
          Math.max(
            0,
            Math.round(cost * 100)
          )
        );

        await client.query(
          `INSERT INTO marketing_daily_stat(
             tenant_id,
             connection_id,
             campaign_id,
             stat_date,
             impressions,
             clicks,
             spend_minor,
             conversions,
             raw
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9
           )
           ON CONFLICT (
             connection_id,
             campaign_id,
             stat_date
           )
           DO UPDATE SET
             impressions =
               EXCLUDED.impressions,
             clicks = EXCLUDED.clicks,
             spend_minor =
               EXCLUDED.spend_minor,
             conversions =
               EXCLUDED.conversions,
             raw = EXCLUDED.raw,
             updated_at = now()`,
          [
            job.tenant_id,
            job.connection_id,
            campaignRow.id,
            statDate,
            parseInteger(
              row.Impressions ?? "0"
            ).toString(),
            parseInteger(
              row.Clicks ?? "0"
            ).toString(),
            spendMinor.toString(),
            String(
              Math.max(
                0,
                parseDecimal(
                  row.Conversions ?? "0"
                )
              )
            ),
            JSON.stringify(row)
          ]
        );
      }

      await client.query(
        `UPDATE marketing_sync_job
         SET status = 'SUCCEEDED',
             last_error = NULL,
             retry_at = NULL,
             finished_at = now()
         WHERE tenant_id = $1
           AND id = $2`,
        [
          job.tenant_id,
          job.job_id
        ]
      );

      await client.query(
        `UPDATE marketing_connection
         SET status = 'ACTIVE',
             last_synced_at = now(),
             last_error = NULL,
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2`,
        [
          job.tenant_id,
          job.connection_id
        ]
      );
    }
  );
}

async function processYandexJob(
  pool: Pool,
  job: MarketingJob
): Promise<void> {
  const connection =
    await withTenantTransaction(
      pool,
      job.tenant_id,
      async (client) => {
        const result =
          await client.query<Connection>(
            `SELECT
               id,
               credentials_ciphertext,
               client_login
             FROM marketing_connection
             WHERE tenant_id = $1
               AND id = $2
               AND provider =
                 'YANDEX_DIRECT'
               AND status <> 'DISABLED'`,
            [
              job.tenant_id,
              job.connection_id
            ]
          );

        return result.rows[0] ?? null;
      }
    );

  if (!connection) {
    throw new Error(
      "YANDEX_CONNECTION_UNAVAILABLE"
    );
  }

  const credentials =
    decryptCredentials(
      connection.credentials_ciphertext
    );

  const response = await fetch(
    YANDEX_REPORTS_URL,
    {
      method: "POST",
      headers: yandexHeaders(
        credentials.oauthToken,
        connection.client_login
      ),
      body: JSON.stringify(
        reportRequest(job)
      )
    }
  );

  const requestId =
    response.headers.get(
      "RequestId"
    ) ??
    response.headers.get(
      "request-id"
    );

  if (
    response.status === 201 ||
    response.status === 202
  ) {
    const retryRaw =
      response.headers.get(
        "retryIn"
      ) ??
      response.headers.get(
        "RetryIn"
      );

    const retry = Number(
      retryRaw ?? "30"
    );

    await markWaiting(
      pool,
      job,
      Number.isFinite(retry)
        ? retry
        : 30,
      requestId
    );

    return;
  }

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      "YANDEX_REPORT_HTTP_" +
        response.status +
        ": " +
        body.slice(0, 1200)
    );
  }

  await persistReport(
    pool,
    job,
    parseTsv(body)
  );
}

export async function
processMarketingSyncOnce(
  pool: Pool
): Promise<boolean> {
  const job = await claimJob(pool);
  if (!job) return false;

  try {
    if (
      job.provider ===
      "YANDEX_DIRECT"
    ) {
      await processYandexJob(
        pool,
        job
      );
    } else {
      throw new Error(
        "UNSUPPORTED_MARKETING_PROVIDER"
      );
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await markFailure(
      pool,
      job,
      message
    );

    process.stderr.write(
      "[worker] marketing sync " +
        job.job_id +
        " failed: " +
        message +
        "\n"
    );
  }

  return true;
}
