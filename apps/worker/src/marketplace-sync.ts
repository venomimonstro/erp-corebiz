import {
  createDecipheriv,
  createHash
} from "node:crypto";
import { Pool, type PoolClient } from "pg";

type SyncJob = {
  job_id: string;
  tenant_id: string;
  connection_id: string;
  provider: "OZON" | "WILDBERRIES";
  period_from: Date;
  period_to: Date;
  cursor: Record<string, unknown>;
  attempts: number;
  credentials_ciphertext: string;
  config: Record<string, unknown>;
};

type NormalizedOrder = {
  externalOrderId: string;
  externalStatus: string | null;
  currency: string;
  orderedAt: string | null;
  payload: Record<string, unknown>;
  lines: Array<{
    externalLineId: string | null;
    externalOfferId: string;
    title: string | null;
    quantityMilli: string;
    unitPriceMinor: string;
    discountMinor: string;
  }>;
};

class ProviderRateLimitError extends Error {
  constructor(
    message: string,
    readonly retrySeconds: number
  ) {
    super(message);
  }
}

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("SESSION_SECRET is required for marketplace sync");
  }

  return createHash("sha256")
    .update(secret + "|corebiz-channels-v1")
    .digest();
}

function decryptCredentials(
  payload: string
): Record<string, unknown> {
  const [version, ivRaw, tagRaw, dataRaw] = payload.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error("CHANNEL_SECRET_FORMAT_INVALID");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64url")),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8")) as Record<string, unknown>;
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

async function claimJob(pool: Pool): Promise<SyncJob | null> {
  const result = await pool.query<SyncJob>(
    "SELECT * FROM corebiz_claim_channel_sync_job()"
  );
  return result.rows[0] ?? null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.trim() !== ""
    ) {
      return value.trim();
    }
    if (
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      return String(value);
    }
  }
  return null;
}

function toMinor(value: unknown): string {
  let raw: unknown = value;

  if (raw && typeof raw === "object") {
    const object = raw as Record<string, unknown>;
    raw =
      object.amount ??
      object.value ??
      object.price ??
      object.rubles ??
      0;
  }

  const number =
    typeof raw === "number"
      ? raw
      : Number(String(raw ?? "0").replace(",", "."));

  if (!Number.isFinite(number) || number < 0) return "0";
  return String(Math.round(number * 100));
}

function integerQuantityMilli(value: unknown): string {
  const number = Number(value ?? 1);
  if (!Number.isFinite(number) || number <= 0) return "1000";
  return String(Math.max(1, Math.round(number * 1000)));
}

function safeIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function currencyFromWb(value: unknown): string {
  const code = Number(value);
  if (code === 643) return "RUB";
  if (code === 933) return "BYN";
  if (code === 398) return "KZT";
  return "RUB";
}

async function persistOrder(
  pool: Pool,
  job: SyncJob,
  order: NormalizedOrder
): Promise<"created" | "updated" | "unchanged" | "imported"> {
  const normalizedPayload = {
    provider: job.provider,
    externalOrderId: order.externalOrderId,
    externalStatus: order.externalStatus,
    currency: order.currency,
    orderedAt: order.orderedAt,
    payload: order.payload,
    lines: order.lines
  };

  const payloadHash = createHash("sha256")
    .update(JSON.stringify(normalizedPayload))
    .digest("hex");

  return withTenantTransaction(
    pool,
    job.tenant_id,
    async (client) => {
      const existingResult = await client.query<{
        id: string;
        status: string;
        payload_hash: string;
      }>(
        `SELECT id,status,payload_hash
         FROM channel_order_inbox
         WHERE tenant_id=$1
           AND connection_id=$2
           AND external_order_id=$3
         FOR UPDATE`,
        [
          job.tenant_id,
          job.connection_id,
          order.externalOrderId
        ]
      );

      const existing = existingResult.rows[0];

      await client.query(
        `INSERT INTO channel_event(
           tenant_id,connection_id,external_event_id,event_type,payload_hash
         ) VALUES ($1,$2,$3,'marketplace.order.sync',$4)
         ON CONFLICT (connection_id,external_event_id) DO NOTHING`,
        [
          job.tenant_id,
          job.connection_id,
          job.provider +
            ":" +
            order.externalOrderId +
            ":" +
            payloadHash,
          payloadHash
        ]
      );

      if (existing?.status === "IMPORTED") {
        return "imported";
      }

      if (existing && existing.payload_hash === payloadHash) {
        return "unchanged";
      }

      let inboxId: string;
      let outcome: "created" | "updated";

      if (existing) {
        await client.query(
          `UPDATE channel_order_inbox
           SET external_status=$4,
               currency=$5,
               ordered_at=$6,
               customer_hint='{}'::jsonb,
               payload=$7,
               payload_hash=$8,
               status='RECEIVED',
               last_error=NULL,
               updated_at=now()
           WHERE tenant_id=$1
             AND id=$2
             AND connection_id=$3`,
          [
            job.tenant_id,
            existing.id,
            job.connection_id,
            order.externalStatus,
            order.currency,
            order.orderedAt,
            JSON.stringify(order.payload),
            payloadHash
          ]
        );

        await client.query(
          `DELETE FROM channel_order_line_inbox
           WHERE tenant_id=$1 AND inbox_order_id=$2`,
          [job.tenant_id, existing.id]
        );

        inboxId = existing.id;
        outcome = "updated";
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO channel_order_inbox(
             tenant_id,connection_id,external_order_id,external_status,
             currency,ordered_at,customer_hint,payload,payload_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8)
           RETURNING id`,
          [
            job.tenant_id,
            job.connection_id,
            order.externalOrderId,
            order.externalStatus,
            order.currency,
            order.orderedAt,
            JSON.stringify(order.payload),
            payloadHash
          ]
        );

        inboxId = inserted.rows[0]!.id;
        outcome = "created";
      }

      for (const line of order.lines) {
        const mapping = await client.query<{ sku_id: string }>(
          `SELECT sku_id
           FROM channel_product_mapping
           WHERE tenant_id=$1
             AND connection_id=$2
             AND external_offer_id=$3
             AND status='ACTIVE'
           LIMIT 1`,
          [
            job.tenant_id,
            job.connection_id,
            line.externalOfferId
          ]
        );

        await client.query(
          `INSERT INTO channel_order_line_inbox(
             tenant_id,inbox_order_id,external_line_id,external_offer_id,
             title,quantity_milli,unit_price_minor,discount_minor,mapped_sku_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            job.tenant_id,
            inboxId,
            line.externalLineId,
            line.externalOfferId,
            line.title,
            line.quantityMilli,
            line.unitPriceMinor,
            line.discountMinor,
            mapping.rows[0]?.sku_id ?? null
          ]
        );
      }

      const missing = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM channel_order_line_inbox
         WHERE tenant_id=$1
           AND inbox_order_id=$2
           AND mapped_sku_id IS NULL`,
        [job.tenant_id, inboxId]
      );

      await client.query(
        `UPDATE channel_order_inbox
         SET status=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          job.tenant_id,
          inboxId,
          Number(missing.rows[0]?.count ?? "0") > 0
            ? "NEEDS_MAPPING"
            : "READY"
        ]
      );

      return outcome;
    }
  );
}

async function checkpoint(
  pool: Pool,
  job: SyncJob,
  cursor: Record<string, unknown>,
  imported: number,
  updated: number
): Promise<void> {
  await withTenantTransaction(
    pool,
    job.tenant_id,
    async (client) => {
      await client.query(
        `UPDATE channel_sync_job
         SET cursor=$3,
             imported_orders=$4,
             updated_orders=$5,
             retry_at=now()+interval '10 minutes'
         WHERE tenant_id=$1 AND id=$2`,
        [
          job.tenant_id,
          job.job_id,
          JSON.stringify(cursor),
          imported,
          updated
        ]
      );
    }
  );
}

async function completeJob(
  pool: Pool,
  job: SyncJob,
  imported: number,
  updated: number,
  cursor: Record<string, unknown>
): Promise<void> {
  await withTenantTransaction(
    pool,
    job.tenant_id,
    async (client) => {
      await client.query(
        `UPDATE channel_sync_job
         SET status='SUCCEEDED',
             cursor=$3,
             imported_orders=$4,
             updated_orders=$5,
             retry_at=NULL,
             last_error=NULL,
             finished_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          job.tenant_id,
          job.job_id,
          JSON.stringify(cursor),
          imported,
          updated
        ]
      );

      await client.query(
        `UPDATE channel_connection
         SET status='ACTIVE',
             last_synced_at=now(),
             last_error=NULL,
             sync_cursor=$3,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          job.tenant_id,
          job.connection_id,
          JSON.stringify({
            provider: job.provider,
            lastPeriodTo: new Date(job.period_to).toISOString(),
            ...cursor
          })
        ]
      );
    }
  );
}

async function failJob(
  pool: Pool,
  job: SyncJob,
  error: unknown
): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error);

  const explicitRetry =
    error instanceof ProviderRateLimitError
      ? error.retrySeconds
      : null;

  const retrySeconds =
    explicitRetry ??
    Math.min(1800, 15 * 2 ** Math.min(job.attempts, 7));

  await withTenantTransaction(
    pool,
    job.tenant_id,
    async (client) => {
      await client.query(
        `UPDATE channel_sync_job
         SET status='FAILED',
             retry_at=CASE
               WHEN attempts < 8
               THEN now()+($3::text || ' seconds')::interval
               ELSE NULL
             END,
             last_error=$4,
             finished_at=CASE WHEN attempts >= 8 THEN now() ELSE finished_at END
         WHERE tenant_id=$1 AND id=$2`,
        [
          job.tenant_id,
          job.job_id,
          String(Math.max(5, Math.min(3600, retrySeconds))),
          message.slice(0, 2000)
        ]
      );

      await client.query(
        `UPDATE channel_connection
         SET status='DEGRADED',
             last_error=$3,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          job.tenant_id,
          job.connection_id,
          message.slice(0, 2000)
        ]
      );
    }
  );
}

function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 60;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;

  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(
      5,
      Math.ceil((date.getTime() - Date.now()) / 1000)
    );
  }
  return 60;
}

async function fetchJson(
  url: string,
  init: RequestInit
): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.text();

  if (response.status === 429) {
    throw new ProviderRateLimitError(
      "MARKETPLACE_RATE_LIMITED",
      retryAfterSeconds(response)
    );
  }

  if (!response.ok) {
    throw new Error(
      "MARKETPLACE_HTTP_" +
        response.status +
        ":" +
        body.replace(/\s+/g, " ").slice(0, 1000)
    );
  }

  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("MARKETPLACE_RESPONSE_INVALID_JSON");
  }
}

function normalizeOzonPosting(posting: any): NormalizedOrder | null {
  const externalOrderId = firstString(
    posting?.posting_number,
    posting?.order_number,
    posting?.order_id
  );
  if (!externalOrderId) return null;

  const products = Array.isArray(posting?.products)
    ? posting.products
    : [];

  const lines = products
    .map((product: any, index: number) => {
      const offer = firstString(
        product?.offer_id,
        product?.product_offer_id,
        product?.offerId,
        product?.product_id,
        product?.sku
      );
      if (!offer) return null;

      const currency =
        firstString(
          product?.marketplace_seller_price_currency_code,
          asObject(product?.price).currency_code,
          asObject(product?.price).currency
        ) ?? "RUB";

      return {
        externalLineId:
          firstString(product?.product_id, product?.sku) ??
          externalOrderId + ":" + index,
        externalOfferId: offer,
        title:
          firstString(product?.name, product?.product_name) ??
          offer,
        quantityMilli: integerQuantityMilli(
          product?.quantity ?? product?.number_of_units ?? 1
        ),
        unitPriceMinor: toMinor(product?.price),
        discountMinor: "0",
        currency
      };
    })
    .filter(Boolean) as Array<{
      externalLineId: string | null;
      externalOfferId: string;
      title: string | null;
      quantityMilli: string;
      unitPriceMinor: string;
      discountMinor: string;
      currency: string;
    }>;

  if (!lines.length) return null;

  const currency =
    lines.find((line) => /^[A-Z]{3}$/.test(line.currency))
      ?.currency ?? "RUB";

  const deliveryMethod = asObject(posting?.delivery_method);

  return {
    externalOrderId,
    externalStatus:
      firstString(posting?.status, posting?.substatus),
    currency,
    orderedAt:
      safeIso(posting?.in_process_at) ??
      safeIso(posting?.created_at) ??
      safeIso(posting?.shipment_date),
    payload: {
      postingNumber: externalOrderId,
      orderId: firstString(posting?.order_id),
      shipmentDate: safeIso(posting?.shipment_date),
      warehouseId: firstString(
        deliveryMethod.warehouse_id,
        asObject(posting?.analytics_data).warehouse_id
      ),
      integrationType: firstString(
        posting?.integration_type_flow,
        posting?.tpl_integration_type
      )
    },
    lines: lines.map(({ currency: _currency, ...line }) => line)
  };
}

async function processOzon(
  pool: Pool,
  job: SyncJob
): Promise<void> {
  const credentials = decryptCredentials(job.credentials_ciphertext);
  const clientId = String(credentials.clientId ?? "");
  const apiKey = String(credentials.apiKey ?? "");

  if (!clientId || apiKey.length < 16) {
    throw new Error("OZON_CREDENTIALS_INVALID");
  }

  let cursor =
    typeof job.cursor?.cursor === "string"
      ? String(job.cursor.cursor)
      : "";
  let imported = Number(job.cursor?.importedOrders ?? 0);
  let updated = Number(job.cursor?.updatedOrders ?? 0);

  for (let page = 0; page < 100; page += 1) {
    const data = await fetchJson(
      "https://api-seller.ozon.ru/v4/posting/fbs/list",
      {
        method: "POST",
        headers: {
          "Client-Id": clientId,
          "Api-Key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sort_dir: "asc",
          filter: {
            since: new Date(job.period_from).toISOString(),
            to: new Date(job.period_to).toISOString()
          },
          limit: 1000,
          cursor,
          with: {
            analytics_data: true,
            barcodes: false,
            financial_data: false,
            legal_info: false,
            translit: false
          }
        })
      }
    );

    const postings = Array.isArray(data?.postings)
      ? data.postings
      : [];

    for (const posting of postings) {
      const normalized = normalizeOzonPosting(posting);
      if (!normalized) continue;
      const outcome = await persistOrder(pool, job, normalized);
      if (outcome === "created") imported += 1;
      if (outcome === "updated") updated += 1;
    }

    const nextCursor =
      typeof data?.cursor === "string" ? data.cursor : cursor;

    cursor = nextCursor;

    await checkpoint(
      pool,
      job,
      {
        cursor,
        importedOrders: imported,
        updatedOrders: updated
      },
      imported,
      updated
    );

    if (!data?.has_next || postings.length === 0) {
      await completeJob(
        pool,
        job,
        imported,
        updated,
        {
          cursor,
          importedOrders: imported,
          updatedOrders: updated
        }
      );
      return;
    }
  }

  throw new Error("OZON_PAGINATION_LIMIT_REACHED");
}

async function wbStatuses(
  token: string,
  ids: number[]
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();

  const data = await fetchJson(
    "https://marketplace-api.wildberries.ru/api/v3/orders/status",
    {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ orders: ids.slice(0, 1000) })
    }
  );

  const result = new Map<string, string>();
  for (const row of Array.isArray(data?.orders) ? data.orders : []) {
    const id = firstString(row?.id, row?.orderId);
    if (!id) continue;
    const status = [
      firstString(row?.supplierStatus),
      firstString(row?.wbStatus)
    ].filter(Boolean).join("/");
    result.set(id, status || "UNKNOWN");
  }
  return result;
}

function normalizeWbOrder(
  order: any,
  status: string | undefined
): NormalizedOrder | null {
  const externalOrderId = firstString(order?.id, order?.orderId);
  if (!externalOrderId) return null;

  const skus = Array.isArray(order?.skus) ? order.skus : [];
  const offer =
    firstString(order?.article, skus[0], order?.nmId, order?.chrtId);
  if (!offer) return null;

  const unitPrice =
    order?.finalPrice ??
    order?.convertedFinalPrice ??
    order?.price ??
    order?.convertedPrice ??
    0;

  return {
    externalOrderId,
    externalStatus: status ?? "UNKNOWN",
    currency: currencyFromWb(
      order?.convertedCurrencyCode ?? order?.currencyCode
    ),
    orderedAt: safeIso(order?.createdAt),
    payload: {
      orderUid: firstString(order?.orderUid),
      warehouseId: firstString(order?.warehouseId),
      officeId: firstString(order?.officeId),
      nmId: firstString(order?.nmId),
      chrtId: firstString(order?.chrtId),
      supplyId: firstString(order?.supplyId),
      deliveryType: firstString(order?.deliveryType)
    },
    lines: [
      {
        externalLineId: externalOrderId,
        externalOfferId: offer,
        title: firstString(order?.article) ?? offer,
        quantityMilli: "1000",
        unitPriceMinor: toMinor(unitPrice),
        discountMinor: "0"
      }
    ]
  };
}

async function processWildberries(
  pool: Pool,
  job: SyncJob
): Promise<void> {
  const credentials = decryptCredentials(job.credentials_ciphertext);
  const token = String(credentials.apiToken ?? "");
  if (token.length < 32) {
    throw new Error("WILDBERRIES_CREDENTIALS_INVALID");
  }

  let next = Number(job.cursor?.next ?? 0);
  let imported = Number(job.cursor?.importedOrders ?? 0);
  let updated = Number(job.cursor?.updatedOrders ?? 0);

  const dateFrom = Math.floor(
    new Date(job.period_from).getTime() / 1000
  );
  const dateTo = Math.floor(
    new Date(job.period_to).getTime() / 1000
  );

  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      "https://marketplace-api.wildberries.ru/api/v3/orders"
    );
    url.searchParams.set("limit", "1000");
    url.searchParams.set("next", String(next));
    url.searchParams.set("dateFrom", String(dateFrom));
    url.searchParams.set("dateTo", String(dateTo));

    const data = await fetchJson(url.toString(), {
      headers: {
        Authorization: token,
        Accept: "application/json"
      }
    });

    const orders = Array.isArray(data?.orders) ? data.orders : [];
    const unique = new Map<string, any>();

    for (const order of orders) {
      const id = firstString(order?.id, order?.orderId);
      if (id) unique.set(id, order);
    }

    const numericIds = Array.from(unique.keys())
      .map((id) => Number(id))
      .filter((id) => Number.isSafeInteger(id));

    const statuses = await wbStatuses(token, numericIds);

    for (const [id, order] of unique) {
      const normalized = normalizeWbOrder(order, statuses.get(id));
      if (!normalized) continue;
      const outcome = await persistOrder(pool, job, normalized);
      if (outcome === "created") imported += 1;
      if (outcome === "updated") updated += 1;
    }

    const responseNext = Number(data?.next ?? 0);

    await checkpoint(
      pool,
      job,
      {
        next: responseNext,
        importedOrders: imported,
        updatedOrders: updated
      },
      imported,
      updated
    );

    if (
      unique.size === 0 ||
      !Number.isFinite(responseNext) ||
      responseNext === 0 ||
      responseNext === next
    ) {
      await completeJob(
        pool,
        job,
        imported,
        updated,
        {
          next: responseNext,
          importedOrders: imported,
          updatedOrders: updated
        }
      );
      return;
    }

    next = responseNext;

    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  throw new Error("WILDBERRIES_PAGINATION_LIMIT_REACHED");
}

export async function processMarketplaceSyncOnce(
  pool: Pool
): Promise<boolean> {
  const job = await claimJob(pool);
  if (!job) return false;

  try {
    if (job.provider === "OZON") {
      await processOzon(pool, job);
    } else if (job.provider === "WILDBERRIES") {
      await processWildberries(pool, job);
    } else {
      throw new Error("UNSUPPORTED_MARKETPLACE_PROVIDER");
    }
  } catch (error) {
    await failJob(pool, job, error);

    const message =
      error instanceof Error ? error.message : String(error);
    process.stderr.write(
      "[worker] marketplace sync " +
        job.job_id +
        " failed: " +
        message.replace(/\s+/g, " ").slice(0, 1000) +
        "\n"
    );
  }

  return true;
}
