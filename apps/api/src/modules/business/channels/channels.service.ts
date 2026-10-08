import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { SalesService } from "../sales/sales.service";
import { ChannelCryptoService } from "./channel-crypto.service";

type ChannelProvider =
  | "OWN_SITE"
  | "API"
  | "OZON"
  | "WILDBERRIES"
  | "YANDEX_MARKET";

@Injectable()
export class ChannelsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sales: SalesService,
    private readonly crypto: ChannelCryptoService
  ) {}

  async connections(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT id,provider,name,status,config,sync_cursor,last_synced_at," +
        "last_received_at,last_error,created_at,updated_at " +
        "FROM channel_connection WHERE tenant_id=$1 ORDER BY created_at DESC",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createConnection(
    context: TenantContext,
    input: {
      provider: ChannelProvider;
      name: string;
      config?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    webhookSecret: string | null;
  }> {
    if (!["OWN_SITE", "API"].includes(input.provider)) {
      throw new BadRequestException(
        "Marketplace-каналы подключаются только через профильный endpoint с credentials"
      );
    }

    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название канала");
    }

    if (["OZON", "WILDBERRIES", "YANDEX_MARKET"].includes(input.provider)) {
      throw new BadRequestException(
        "Marketplace нужно подключать через профильный endpoint с credentials"
      );
    }

    const webhookEnabled =
      input.provider === "OWN_SITE" || input.provider === "API";

    const secret = webhookEnabled
      ? randomBytes(32).toString("base64url")
      : null;

    const secretHash = secret
      ? createHash("sha256").update(secret).digest("hex")
      : null;

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO channel_connection(" +
        "tenant_id,provider,name,webhook_secret_hash,config,created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [
          context.tenantId,
          input.provider,
          name,
          secretHash,
          JSON.stringify(this.sanitizeObject(input.config ?? {}, 8000)),
          context.membershipId
        ]
      );

      const row = result.rows[0];
      if (!row) throw new Error("CHANNEL_CONNECTION_CREATE_FAILED");

      await this.audit(
        client,
        context,
        "channel.connection_created",
        "channel_connection",
        row.id,
        { provider: input.provider, name }
      );

      return {
        id: row.id,
        webhookSecret: secret
      };
    });
  }

  async createMarketplaceConnection(
    context: TenantContext,
    input:
      | {
          provider: "OZON";
          name: string;
          clientId: string;
          apiKey: string;
        }
      | {
          provider: "WILDBERRIES";
          name: string;
          apiToken: string;
        }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название подключения");
    }

    let credentials: Record<string, unknown>;
    let config: Record<string, unknown>;

    if (input.provider === "OZON") {
      const clientId = input.clientId.trim();
      const apiKey = input.apiKey.trim();
      if (clientId.length < 2 || clientId.length > 100) {
        throw new BadRequestException("Некорректный Ozon Client-Id");
      }
      if (apiKey.length < 16 || apiKey.length > 4096) {
        throw new BadRequestException("Некорректный Ozon Api-Key");
      }

      credentials = { clientId, apiKey };
      config = {
        mode: "FBS",
        apiVersion: "v4",
        ordersEndpoint: "/v4/posting/fbs/list"
      };
    } else {
      const apiToken = input.apiToken.trim();
      if (apiToken.length < 32 || apiToken.length > 8192) {
        throw new BadRequestException("Некорректный Wildberries API token");
      }

      credentials = { apiToken };
      config = {
        mode: "FBS",
        apiVersion: "v3",
        ordersEndpoint: "/api/v3/orders"
      };
    }

    const encrypted = this.crypto.encrypt(credentials);

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO channel_connection(
           tenant_id,provider,name,credentials_ciphertext,config,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          input.provider,
          name,
          encrypted,
          JSON.stringify(config),
          context.membershipId
        ]
      );

      const row = result.rows[0];
      if (!row) throw new Error("MARKETPLACE_CONNECTION_CREATE_FAILED");

      await this.audit(
        client,
        context,
        "channel.marketplace_connection_created",
        "channel_connection",
        row.id,
        { provider: input.provider, name }
      );

      return row;
    });
  }

  async requestSync(
    context: TenantContext,
    connectionId: string,
    input: {
      from?: string;
      to?: string;
    }
  ): Promise<{ jobId: string; status: string }> {
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from
      ? new Date(input.from)
      : new Date(to.getTime() - 7 * 86400000);

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 31 * 86400000
    ) {
      throw new BadRequestException(
        "Период sync должен быть больше 0 и не более 31 дня"
      );
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const connection = await client.query<{
        provider: string;
        status: string;
        credentials_ciphertext: string | null;
      }>(
        `SELECT provider,status,credentials_ciphertext
         FROM channel_connection
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, connectionId]
      );

      const row = connection.rows[0];
      if (!row) throw new NotFoundException("Канал не найден");
      if (!["OZON","WILDBERRIES"].includes(row.provider)) {
        throw new BadRequestException(
          "Ручная синхронизация доступна только marketplace-коннекторам"
        );
      }
      if (row.status === "DISABLED") {
        throw new BadRequestException("Канал отключён");
      }
      if (!row.credentials_ciphertext) {
        throw new BadRequestException("У канала не настроены credentials");
      }

      const job = await client.query<{ id: string; status: string }>(
        `INSERT INTO channel_sync_job(
           tenant_id,connection_id,provider,period_from,period_to
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id,status`,
        [
          context.tenantId,
          connectionId,
          row.provider,
          from,
          to
        ]
      );

      return {
        jobId: job.rows[0]!.id,
        status: job.rows[0]!.status
      };
    });
  }

  async syncJobs(
    context: TenantContext,
    connectionId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           j.id,j.connection_id,c.name AS connection_name,
           j.provider,j.period_from,j.period_to,j.status,j.attempts,
           j.imported_orders,j.updated_orders,j.last_error,
           j.started_at,j.finished_at,j.created_at
         FROM channel_sync_job j
         JOIN channel_connection c
           ON c.tenant_id=j.tenant_id AND c.id=j.connection_id
         WHERE j.tenant_id=$1
           AND ($2::uuid IS NULL OR j.connection_id=$2)
         ORDER BY j.created_at DESC
         LIMIT 200`,
        [context.tenantId, connectionId ?? null]
      );
      return result.rows;
    });
  }


  async ingestOrder(
    connectionId: string,
    webhookSecret: string,
    input: {
      externalEventId: string;
      eventType?: string;
      order: {
        externalOrderId: string;
        externalStatus?: string;
        currency?: string;
        orderedAt?: string;
        customerHint?: Record<string, unknown>;
        lines: Array<{
          externalLineId?: string;
          externalOfferId: string;
          title?: string;
          quantityMilli: string;
          unitPriceMinor: string;
          discountMinor?: string;
        }>;
      };
    }
  ): Promise<{
    accepted: true;
    inboxOrderId: string;
    status: string;
    duplicateEvent: boolean;
  }> {
    const lookup = await this.database.query<{
      connection_id: string;
      tenant_id: string;
      provider: ChannelProvider;
      webhook_secret_hash: string | null;
      status: string;
    }>(
      "SELECT * FROM corebiz_resolve_channel_webhook($1)",
      [connectionId]
    );

    const connection = lookup.rows[0];
    if (!connection || connection.status === "DISABLED") {
      throw new NotFoundException("Канал не найден");
    }

    if (!connection.webhook_secret_hash) {
      throw new ForbiddenException(
        "Для этого канала webhook ingestion не включён"
      );
    }

    this.assertWebhookSecret(
      webhookSecret,
      connection.webhook_secret_hash
    );

    this.validateOrder(input);
    const normalized = this.normalizeIncoming(input);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");

    return this.database.withTenantTransaction(
      {
        tenantId: connection.tenant_id,
        userId: "00000000-0000-0000-0000-000000000000",
        membershipId: "00000000-0000-0000-0000-000000000000"
      },
      async (client) => {
        const event = await client.query(
          "INSERT INTO channel_event(" +
          "tenant_id,connection_id,external_event_id,event_type,payload_hash" +
          ") VALUES ($1,$2,$3,$4,$5) " +
          "ON CONFLICT (connection_id,external_event_id) DO NOTHING RETURNING id",
          [
            connection.tenant_id,
            connection.connection_id,
            normalized.externalEventId,
            normalized.eventType,
            payloadHash
          ]
        );

        const existingResult = await client.query<{
          id: string;
          status: string;
          payload_hash: string;
        }>(
          "SELECT id,status,payload_hash FROM channel_order_inbox " +
          "WHERE tenant_id=$1 AND connection_id=$2 AND external_order_id=$3 FOR UPDATE",
          [
            connection.tenant_id,
            connection.connection_id,
            normalized.order.externalOrderId
          ]
        );

        const existing = existingResult.rows[0];

        if (existing?.status === "IMPORTED") {
          await client.query(
            "UPDATE channel_connection SET status='ACTIVE',last_received_at=now()," +
            "last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [connection.tenant_id, connection.connection_id]
          );

          return {
            accepted: true as const,
            inboxOrderId: existing.id,
            status: existing.status,
            duplicateEvent: !event.rowCount
          };
        }

        let inboxId: string;

        if (existing) {
          if (existing.payload_hash !== payloadHash) {
            await client.query(
              "UPDATE channel_order_inbox SET external_status=$4,currency=$5," +
              "ordered_at=$6,customer_hint=$7,payload=$8,payload_hash=$9," +
              "status='RECEIVED',last_error=NULL,updated_at=now() " +
              "WHERE tenant_id=$1 AND id=$2 AND connection_id=$3",
              [
                connection.tenant_id,
                existing.id,
                connection.connection_id,
                normalized.order.externalStatus,
                normalized.order.currency,
                normalized.order.orderedAt,
                JSON.stringify(normalized.order.customerHint),
                JSON.stringify(normalized.order.payload),
                payloadHash
              ]
            );

            await client.query(
              "DELETE FROM channel_order_line_inbox " +
              "WHERE tenant_id=$1 AND inbox_order_id=$2",
              [connection.tenant_id, existing.id]
            );
          }
          inboxId = existing.id;
        } else {
          const inserted = await client.query<{ id: string }>(
            "INSERT INTO channel_order_inbox(" +
            "tenant_id,connection_id,external_order_id,external_status,currency," +
            "ordered_at,customer_hint,payload,payload_hash" +
            ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
            [
              connection.tenant_id,
              connection.connection_id,
              normalized.order.externalOrderId,
              normalized.order.externalStatus,
              normalized.order.currency,
              normalized.order.orderedAt,
              JSON.stringify(normalized.order.customerHint),
              JSON.stringify(normalized.order.payload),
              payloadHash
            ]
          );
          inboxId = inserted.rows[0]!.id;
        }

        const lineCount = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM channel_order_line_inbox " +
          "WHERE tenant_id=$1 AND inbox_order_id=$2",
          [connection.tenant_id, inboxId]
        );

        if (Number(lineCount.rows[0]?.count ?? "0") === 0) {
          for (const line of normalized.order.lines) {
            const mapping = await client.query<{ sku_id: string }>(
              "SELECT sku_id FROM channel_product_mapping " +
              "WHERE tenant_id=$1 AND connection_id=$2 " +
              "AND external_offer_id=$3 AND status='ACTIVE' LIMIT 1",
              [
                connection.tenant_id,
                connection.connection_id,
                line.externalOfferId
              ]
            );

            await client.query(
              "INSERT INTO channel_order_line_inbox(" +
              "tenant_id,inbox_order_id,external_line_id,external_offer_id,title," +
              "quantity_milli,unit_price_minor,discount_minor,mapped_sku_id" +
              ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                connection.tenant_id,
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
        }

        const missing = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM channel_order_line_inbox " +
          "WHERE tenant_id=$1 AND inbox_order_id=$2 AND mapped_sku_id IS NULL",
          [connection.tenant_id, inboxId]
        );

        const inboxStatus =
          Number(missing.rows[0]?.count ?? "0") > 0
            ? "NEEDS_MAPPING"
            : "READY";

        await client.query(
          "UPDATE channel_order_inbox SET status=$3,updated_at=now() " +
          "WHERE tenant_id=$1 AND id=$2 AND status<>'IMPORTED'",
          [connection.tenant_id, inboxId, inboxStatus]
        );

        await client.query(
          "UPDATE channel_connection SET status='ACTIVE',last_received_at=now()," +
          "last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [connection.tenant_id, connection.connection_id]
        );

        return {
          accepted: true as const,
          inboxOrderId: inboxId,
          status: inboxStatus,
          duplicateEvent: !event.rowCount
        };
      }
    );
  }

  async inbox(
    context: TenantContext,
    status?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT o.id,o.connection_id,c.name AS connection_name,c.provider," +
        "o.external_order_id,o.external_status,o.currency,o.ordered_at,o.status," +
        "o.sales_order_id,o.customer_hint,o.attempts,o.last_error,o.received_at," +
        "count(l.id)::int AS line_count," +
        "count(l.id) FILTER (WHERE l.mapped_sku_id IS NULL)::int AS unmapped_lines " +
        "FROM channel_order_inbox o " +
        "JOIN channel_connection c ON c.tenant_id=o.tenant_id AND c.id=o.connection_id " +
        "LEFT JOIN channel_order_line_inbox l ON l.tenant_id=o.tenant_id AND l.inbox_order_id=o.id " +
        "WHERE o.tenant_id=$1 AND ($2::text IS NULL OR o.status=$2) " +
        "GROUP BY o.id,c.name,c.provider ORDER BY o.received_at DESC LIMIT 500",
        [context.tenantId, status ?? null]
      );
      return result.rows;
    });
  }

  async inboxOrder(
    context: TenantContext,
    id: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const order = await client.query(
        "SELECT o.*,c.name AS connection_name,c.provider " +
        "FROM channel_order_inbox o JOIN channel_connection c " +
        "ON c.tenant_id=o.tenant_id AND c.id=o.connection_id " +
        "WHERE o.tenant_id=$1 AND o.id=$2",
        [context.tenantId, id]
      );

      if (!order.rows[0]) throw new NotFoundException("Inbox order не найден");

      const lines = await client.query(
        "SELECT l.id,l.external_line_id,l.external_offer_id,l.title," +
        "l.quantity_milli::text,l.unit_price_minor::text,l.discount_minor::text," +
        "l.mapped_sku_id,s.code AS sku_code " +
        "FROM channel_order_line_inbox l LEFT JOIN sku s " +
        "ON s.tenant_id=l.tenant_id AND s.id=l.mapped_sku_id " +
        "WHERE l.tenant_id=$1 AND l.inbox_order_id=$2 ORDER BY l.created_at",
        [context.tenantId, id]
      );

      return {
        order: order.rows[0],
        lines: lines.rows
      };
    });
  }

  async mapOffer(
    context: TenantContext,
    connectionId: string,
    input: {
      externalOfferId: string;
      skuId: string;
      externalBarcode?: string;
    }
  ): Promise<void> {
    const offer = input.externalOfferId.trim();
    if (!offer || offer.length > 300) {
      throw new BadRequestException("Некорректный externalOfferId");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      const connection = await client.query(
        "SELECT 1 FROM channel_connection WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, connectionId]
      );
      if (!connection.rowCount) throw new NotFoundException("Канал не найден");

      const sku = await client.query(
        "SELECT 1 FROM sku WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId, input.skuId]
      );
      if (!sku.rowCount) throw new NotFoundException("SKU не найден");

      await client.query(
        "INSERT INTO channel_product_mapping(" +
        "tenant_id,connection_id,external_offer_id,external_barcode,sku_id," +
        "created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6) " +
        "ON CONFLICT (connection_id,external_offer_id) DO UPDATE SET " +
        "external_barcode=EXCLUDED.external_barcode,sku_id=EXCLUDED.sku_id," +
        "status='ACTIVE',updated_at=now()",
        [
          context.tenantId,
          connectionId,
          offer,
          input.externalBarcode?.trim() || null,
          input.skuId,
          context.membershipId
        ]
      );

      await client.query(
        "UPDATE channel_order_line_inbox SET mapped_sku_id=$4 " +
        "WHERE tenant_id=$1 AND external_offer_id=$2 " +
        "AND inbox_order_id IN (" +
        "SELECT id FROM channel_order_inbox WHERE tenant_id=$1 " +
        "AND connection_id=$3 AND status IN ('RECEIVED','NEEDS_MAPPING','READY','FAILED')" +
        ")",
        [context.tenantId, offer, connectionId, input.skuId]
      );

      await client.query(
        "UPDATE channel_order_inbox o SET status='READY',last_error=NULL,updated_at=now() " +
        "WHERE o.tenant_id=$1 AND o.connection_id=$2 " +
        "AND o.status IN ('RECEIVED','NEEDS_MAPPING','FAILED') " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM channel_order_line_inbox l " +
        "WHERE l.tenant_id=o.tenant_id AND l.inbox_order_id=o.id AND l.mapped_sku_id IS NULL" +
        ")",
        [context.tenantId, connectionId]
      );
    });
  }

  async importOrder(
    context: TenantContext,
    inboxOrderId: string
  ): Promise<{
    salesOrderId: string;
    number: string;
    reused: boolean;
  }> {
    const data = await this.database.withTenantTransaction(
      context,
      async (client) => {
        const order = await client.query<{
          id: string;
          connection_id: string;
          external_order_id: string;
          currency: string;
          status: string;
          sales_order_id: string | null;
          provider: string;
          connection_name: string;
        }>(
          "SELECT o.id,o.connection_id,o.external_order_id,o.currency,o.status," +
          "o.sales_order_id,c.provider,c.name AS connection_name " +
          "FROM channel_order_inbox o JOIN channel_connection c " +
          "ON c.tenant_id=o.tenant_id AND c.id=o.connection_id " +
          "WHERE o.tenant_id=$1 AND o.id=$2 FOR UPDATE OF o",
          [context.tenantId, inboxOrderId]
        );

        const row = order.rows[0];
        if (!row) throw new NotFoundException("Inbox order не найден");

        if (row.status === "IGNORED") {
          throw new BadRequestException("Игнорируемый заказ нельзя импортировать");
        }

        const lines = await client.query<{
          mapped_sku_id: string | null;
          title: string | null;
          quantity_milli: string;
          unit_price_minor: string;
          discount_minor: string;
        }>(
          "SELECT mapped_sku_id,title,quantity_milli::text,unit_price_minor::text," +
          "discount_minor::text FROM channel_order_line_inbox " +
          "WHERE tenant_id=$1 AND inbox_order_id=$2 ORDER BY created_at",
          [context.tenantId, inboxOrderId]
        );

        if (!lines.rowCount) {
          throw new BadRequestException("В заказе нет строк");
        }

        if (lines.rows.some((line) => !line.mapped_sku_id)) {
          throw new ConflictException("Не все внешние товары сопоставлены с SKU");
        }

        await client.query(
          "UPDATE channel_order_inbox SET status='IMPORTING',attempts=attempts+1," +
          "last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 " +
          "AND status<>'IMPORTED'",
          [context.tenantId, inboxOrderId]
        );

        return {
          ...row,
          lines: lines.rows
        };
      }
    );

    const idempotencyKey =
      "channel:" +
      data.connection_id +
      ":" +
      data.external_order_id;

    try {
      const salesOrder = await this.sales.create(context, {
        currency: data.currency,
        idempotencyKey,
        notes:
          "Канал " +
          data.connection_name +
          " / внешний заказ " +
          data.external_order_id,
        lines: data.lines.map((line) => ({
          skuId: line.mapped_sku_id!,
          description: line.title ?? undefined,
          quantityMilli: line.quantity_milli,
          unitPriceMinor: line.unit_price_minor,
          discountMinor: line.discount_minor
        }))
      });

      await this.database.withTenantTransaction(context, async (client) => {
        await client.query(
          "UPDATE channel_order_inbox SET status='IMPORTED',sales_order_id=$3," +
          "imported_at=COALESCE(imported_at,now()),last_error=NULL,updated_at=now() " +
          "WHERE tenant_id=$1 AND id=$2",
          [context.tenantId, inboxOrderId, salesOrder.id]
        );

        await this.audit(
          client,
          context,
          "channel.order_imported",
          "channel_order_inbox",
          inboxOrderId,
          { salesOrderId: salesOrder.id }
        );
      });

      return {
        salesOrderId: salesOrder.id,
        number: salesOrder.number,
        reused: Boolean(data.sales_order_id)
      };
    } catch (error) {
      await this.database.withTenantTransaction(context, async (client) => {
        await client.query(
          "UPDATE channel_order_inbox SET status='FAILED',last_error=$3,updated_at=now() " +
          "WHERE tenant_id=$1 AND id=$2 AND status<>'IMPORTED'",
          [
            context.tenantId,
            inboxOrderId,
            (error instanceof Error ? error.message : String(error)).slice(0, 2000)
          ]
        );
      });
      throw error;
    }
  }

  async ignore(
    context: TenantContext,
    inboxOrderId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "UPDATE channel_order_inbox SET status='IGNORED',updated_at=now() " +
        "WHERE tenant_id=$1 AND id=$2 AND status<>'IMPORTED' RETURNING id",
        [context.tenantId, inboxOrderId]
      );
      if (!result.rowCount) {
        throw new BadRequestException("Заказ нельзя игнорировать");
      }
    });
  }

  private validateOrder(input: any): void {
    if (!input?.externalEventId?.trim() || input.externalEventId.length > 250) {
      throw new BadRequestException("Некорректный externalEventId");
    }
    if (!input.order?.externalOrderId?.trim() || input.order.externalOrderId.length > 250) {
      throw new BadRequestException("Некорректный externalOrderId");
    }
    if (!Array.isArray(input.order.lines) || input.order.lines.length < 1 || input.order.lines.length > 200) {
      throw new BadRequestException("Заказ должен содержать от 1 до 200 строк");
    }

    for (const line of input.order.lines) {
      if (!line.externalOfferId?.trim() || line.externalOfferId.length > 300) {
        throw new BadRequestException("Некорректный externalOfferId");
      }
      if (!/^\d+$/.test(line.quantityMilli) || BigInt(line.quantityMilli) <= 0n) {
        throw new BadRequestException("Некорректное количество");
      }
      if (!/^\d+$/.test(line.unitPriceMinor)) {
        throw new BadRequestException("Некорректная цена");
      }
      if (
        line.discountMinor !== undefined &&
        !/^\d+$/.test(line.discountMinor)
      ) {
        throw new BadRequestException("Некорректная скидка");
      }
    }

    if (JSON.stringify(input).length > 128000) {
      throw new BadRequestException("Payload заказа слишком большой");
    }
  }

  private normalizeIncoming(input: any): any {
    const orderedAt = input.order.orderedAt
      ? new Date(input.order.orderedAt)
      : null;

    if (orderedAt && Number.isNaN(orderedAt.getTime())) {
      throw new BadRequestException("Некорректный orderedAt");
    }

    const currency =
      String(input.order.currency ?? "RUB").trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Некорректная валюта");
    }

    return {
      externalEventId: input.externalEventId.trim(),
      eventType: String(input.eventType ?? "order.upsert").slice(0, 120),
      order: {
        externalOrderId: input.order.externalOrderId.trim(),
        externalStatus:
          String(input.order.externalStatus ?? "").slice(0, 120) || null,
        currency,
        orderedAt: orderedAt?.toISOString() ?? null,
        customerHint: this.sanitizeObject(input.order.customerHint ?? {}, 4000),
        payload: {},
        lines: input.order.lines.map((line: any) => ({
          externalLineId:
            String(line.externalLineId ?? "").slice(0, 250) || null,
          externalOfferId: line.externalOfferId.trim(),
          title: String(line.title ?? "").slice(0, 500) || null,
          quantityMilli: line.quantityMilli,
          unitPriceMinor: line.unitPriceMinor,
          discountMinor: line.discountMinor ?? "0"
        }))
      }
    };
  }

  private assertWebhookSecret(
    supplied: string,
    expectedHex: string
  ): void {
    const actual = createHash("sha256").update(supplied).digest();
    const expected = Buffer.from(expectedHex, "hex");

    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new ForbiddenException("Некорректный webhook secret");
    }
  }

  private sanitizeObject(
    input: Record<string, unknown>,
    maxJsonLength: number
  ): Record<string, unknown> {
    const blocked = new Set([
      "password","token","authorization","cookie","card","cvv","cvc"
    ]);
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input).slice(0, 50)) {
      if (blocked.has(key.toLowerCase().replace(/[^a-z]/g, ""))) continue;
      if (typeof value === "string") output[key] = value.slice(0, 500);
      else if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        output[key] = value;
      }
    }

    if (JSON.stringify(output).length > maxJsonLength) {
      throw new BadRequestException("Слишком большой metadata payload");
    }

    return output;
  }

  private async audit(
    client: import("pg").PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_event(" +
      "tenant_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,after_data" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        data ? JSON.stringify(data) : null
      ]
    );
  }
}
