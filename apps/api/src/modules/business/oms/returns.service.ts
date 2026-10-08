import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { InventoryService } from "../inventory/inventory.service";

type Disposition =
  | "RESTOCK"
  | "QUARANTINE"
  | "DAMAGED"
  | "RETURN_TO_SUPPLIER"
  | "SCRAP"
  | "REJECT";

@Injectable()
export class ReturnsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventory: InventoryService
  ) {}

  async list(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           r.id,r.business_number,r.sales_order_id,r.status,r.reason,r.notes,
           r.requested_at,r.authorized_at,r.received_at,r.completed_at,
           so.business_number AS sales_order_number,
           p.display_name AS party_name,
           count(l.id)::int AS lines,
           COALESCE(sum(l.requested_quantity_milli),0)::text AS requested_quantity_milli,
           COALESCE(sum(l.received_quantity_milli),0)::text AS received_quantity_milli
         FROM return_request r
         JOIN sales_order so
           ON so.tenant_id=r.tenant_id AND so.id=r.sales_order_id
         LEFT JOIN party p
           ON p.tenant_id=r.tenant_id AND p.id=r.party_id
         LEFT JOIN return_request_line l
           ON l.tenant_id=r.tenant_id AND l.return_request_id=r.id
         WHERE r.tenant_id=$1
         GROUP BY r.id,so.business_number,p.display_name
         ORDER BY r.requested_at DESC
         LIMIT 500`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async details(
    context: TenantContext,
    returnId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const request = await client.query(
        `SELECT
           r.*,so.business_number AS sales_order_number,
           p.display_name AS party_name
         FROM return_request r
         JOIN sales_order so
           ON so.tenant_id=r.tenant_id AND so.id=r.sales_order_id
         LEFT JOIN party p
           ON p.tenant_id=r.tenant_id AND p.id=r.party_id
         WHERE r.tenant_id=$1 AND r.id=$2`,
        [context.tenantId, returnId]
      );

      if (!request.rows[0]) {
        throw new NotFoundException("Возврат не найден");
      }

      const lines = await client.query(
        `SELECT
           l.id,l.sales_order_line_id,l.sku_id,s.code AS sku_code,
           sol.description,
           l.requested_quantity_milli::text,
           l.authorized_quantity_milli::text,
           l.received_quantity_milli::text,
           l.disposition,l.warehouse_id,w.name AS warehouse_name,
           l.inspection_note
         FROM return_request_line l
         JOIN sales_order_line sol
           ON sol.tenant_id=l.tenant_id AND sol.id=l.sales_order_line_id
         LEFT JOIN sku s
           ON s.tenant_id=l.tenant_id AND s.id=l.sku_id
         LEFT JOIN warehouse w
           ON w.tenant_id=l.tenant_id AND w.id=l.warehouse_id
         WHERE l.tenant_id=$1 AND l.return_request_id=$2
         ORDER BY l.created_at`,
        [context.tenantId, returnId]
      );

      return { request: request.rows[0], lines: lines.rows };
    });
  }

  async create(
    context: TenantContext,
    input: {
      salesOrderId: string;
      reason?: string;
      notes?: string;
      lines: Array<{
        salesOrderLineId: string;
        quantityMilli: string;
      }>;
    }
  ): Promise<{ id: string; number: string }> {
    if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 200) {
      throw new BadRequestException("Добавьте позиции возврата");
    }

    const uniqueLineIds = new Set(input.lines.map((line) => line.salesOrderLineId));
    if (uniqueLineIds.size !== input.lines.length) {
      throw new BadRequestException("Строка заказа повторяется в возврате");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const order = await client.query<{
        party_id: string | null;
        order_status: string;
        fulfillment_status: string;
      }>(
        `SELECT party_id,order_status,fulfillment_status
         FROM sales_order
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, input.salesOrderId]
      );

      const orderRow = order.rows[0];
      if (!orderRow) throw new NotFoundException("Заказ не найден");
      if (orderRow.fulfillment_status !== "SHIPPED") {
        throw new BadRequestException(
          "Возврат можно оформить только после фактической отгрузки"
        );
      }

      const prepared: Array<{
        lineId: string;
        skuId: string | null;
        quantity: bigint;
      }> = [];

      for (const line of input.lines) {
        if (!/^\d+$/.test(line.quantityMilli)) {
          throw new BadRequestException("Некорректное количество возврата");
        }

        const quantity = BigInt(line.quantityMilli);
        if (quantity <= 0n) {
          throw new BadRequestException("Количество возврата должно быть больше нуля");
        }

        const orderLine = await client.query<{
          sku_id: string | null;
          quantity_milli: string;
        }>(
          `SELECT sku_id,quantity_milli::text
           FROM sales_order_line
           WHERE tenant_id=$1 AND id=$2 AND order_id=$3`,
          [
            context.tenantId,
            line.salesOrderLineId,
            input.salesOrderId
          ]
        );

        const row = orderLine.rows[0];
        if (!row) throw new NotFoundException("Строка исходного заказа не найдена");

        const activeReturns = await client.query<{ quantity_milli: string }>(
          `SELECT COALESCE(sum(rl.requested_quantity_milli),0)::text AS quantity_milli
           FROM return_request_line rl
           JOIN return_request rr
             ON rr.tenant_id=rl.tenant_id AND rr.id=rl.return_request_id
           WHERE rl.tenant_id=$1
             AND rl.sales_order_line_id=$2
             AND rr.status NOT IN ('REJECTED','CANCELLED')`,
          [context.tenantId, line.salesOrderLineId]
        );

        const alreadyRequested = BigInt(
          activeReturns.rows[0]?.quantity_milli ?? "0"
        );
        const sold = BigInt(row.quantity_milli);

        if (alreadyRequested + quantity > sold) {
          throw new ConflictException(
            "Суммарный возврат превышает отгруженное количество"
          );
        }

        prepared.push({
          lineId: line.salesOrderLineId,
          skuId: row.sku_id,
          quantity
        });
      }

      const counter = await client.query<{ value: string }>(
        `INSERT INTO tenant_counter(tenant_id,counter_key,value)
         VALUES ($1,'return_request',1)
         ON CONFLICT (tenant_id,counter_key)
         DO UPDATE SET value=tenant_counter.value+1,updated_at=now()
         RETURNING value::text`,
        [context.tenantId]
      );

      const number =
        "RET-" +
        new Date().getUTCFullYear() +
        "-" +
        BigInt(counter.rows[0]?.value ?? "0").toString().padStart(6, "0");

      const request = await client.query<{ id: string }>(
        `INSERT INTO return_request(
           tenant_id,business_number,sales_order_id,party_id,
           reason,notes,created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          context.tenantId,
          number,
          input.salesOrderId,
          orderRow.party_id,
          input.reason?.trim() || null,
          input.notes?.trim() || null,
          context.membershipId
        ]
      );

      const returnId = request.rows[0]!.id;

      for (const line of prepared) {
        await client.query(
          `INSERT INTO return_request_line(
             tenant_id,return_request_id,sales_order_line_id,sku_id,
             requested_quantity_milli
           ) VALUES ($1,$2,$3,$4,$5)`,
          [
            context.tenantId,
            returnId,
            line.lineId,
            line.skuId,
            line.quantity.toString()
          ]
        );
      }

      await this.audit(
        client,
        context,
        "return.request_created",
        "return_request",
        returnId,
        {
          salesOrderId: input.salesOrderId,
          number,
          lines: prepared.length
        }
      );

      return { id: returnId, number };
    });
  }

  async authorize(
    context: TenantContext,
    returnId: string,
    input?: {
      lines?: Array<{
        returnLineId: string;
        authorizedQuantityMilli: string;
      }>;
    }
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const request = await client.query<{ status: string }>(
        `SELECT status FROM return_request
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, returnId]
      );

      const row = request.rows[0];
      if (!row) throw new NotFoundException("Возврат не найден");
      if (row.status === "AUTHORIZED") return;
      if (row.status !== "REQUESTED") {
        throw new BadRequestException("Возврат нельзя авторизовать в текущем статусе");
      }

      const overrides = new Map(
        (input?.lines ?? []).map((line) => [
          line.returnLineId,
          line.authorizedQuantityMilli
        ])
      );

      const lines = await client.query<{
        id: string;
        requested_quantity_milli: string;
      }>(
        `SELECT id,requested_quantity_milli::text
         FROM return_request_line
         WHERE tenant_id=$1 AND return_request_id=$2
         FOR UPDATE`,
        [context.tenantId, returnId]
      );

      for (const line of lines.rows) {
        const raw = overrides.get(line.id) ?? line.requested_quantity_milli;
        if (!/^\d+$/.test(raw)) {
          throw new BadRequestException("Некорректное разрешённое количество");
        }

        const authorized = BigInt(raw);
        if (
          authorized < 0n ||
          authorized > BigInt(line.requested_quantity_milli)
        ) {
          throw new BadRequestException(
            "Разрешённое количество превышает запрошенное"
          );
        }

        await client.query(
          `UPDATE return_request_line
           SET authorized_quantity_milli=$3,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, line.id, authorized.toString()]
        );
      }

      await client.query(
        `UPDATE return_request
         SET status='AUTHORIZED',
             authorized_at=now(),
             authorized_by_membership_id=$3,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, returnId, context.membershipId]
      );

      await this.audit(
        client,
        context,
        "return.authorized",
        "return_request",
        returnId
      );
    });
  }

  async receiveLine(
    context: TenantContext,
    returnId: string,
    lineId: string,
    input: {
      quantityMilli: string;
      disposition: Disposition;
      warehouseId?: string;
      inspectionNote?: string;
      idempotencyKey: string;
    }
  ): Promise<{ receivedQuantityMilli: string; restocked: boolean }> {
    if (!/^\d+$/.test(input.quantityMilli)) {
      throw new BadRequestException("Некорректное количество приёмки");
    }

    const quantity = BigInt(input.quantityMilli);
    if (quantity <= 0n) {
      throw new BadRequestException("Количество приёмки должно быть больше нуля");
    }

    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const lineResult = await client.query<{
        id: string;
        sku_id: string | null;
        authorized_quantity_milli: string;
        received_quantity_milli: string;
        request_status: string;
      }>(
        `SELECT
           l.id,l.sku_id,l.authorized_quantity_milli::text,
           l.received_quantity_milli::text,
           r.status AS request_status
         FROM return_request_line l
         JOIN return_request r
           ON r.tenant_id=l.tenant_id AND r.id=l.return_request_id
         WHERE l.tenant_id=$1
           AND l.id=$2
           AND l.return_request_id=$3
         FOR UPDATE OF l,r`,
        [context.tenantId, lineId, returnId]
      );

      const line = lineResult.rows[0];
      if (!line) throw new NotFoundException("Строка возврата не найдена");
      if (!["AUTHORIZED","IN_TRANSIT","RECEIVED"].includes(line.request_status)) {
        throw new BadRequestException("Возврат ещё не авторизован");
      }

      const current = BigInt(line.received_quantity_milli);
      const authorized = BigInt(line.authorized_quantity_milli);
      if (current + quantity > authorized) {
        throw new ConflictException(
          "Принятое количество превышает разрешённое"
        );
      }

      let restocked = false;

      if (input.disposition === "RESTOCK") {
        if (!line.sku_id) {
          throw new BadRequestException(
            "Нельзя вернуть в остаток строку без SKU"
          );
        }
        if (!input.warehouseId) {
          throw new BadRequestException(
            "Для RESTOCK требуется склад"
          );
        }

        const movement = await this.inventory.receiveCustomerReturn(
          client,
          context,
          {
            returnRequestId: returnId,
            returnLineId: lineId,
            warehouseId: input.warehouseId,
            skuId: line.sku_id,
            quantityMilli: quantity,
            idempotencyKey: input.idempotencyKey
          }
        );
        restocked = movement.applied;
      }

      const next = current + quantity;

      await client.query(
        `UPDATE return_request_line
         SET received_quantity_milli=$4,
             disposition=$5,
             warehouse_id=$6,
             inspection_note=$7,
             updated_at=now()
         WHERE tenant_id=$1
           AND id=$2
           AND return_request_id=$3`,
        [
          context.tenantId,
          lineId,
          returnId,
          next.toString(),
          input.disposition,
          input.warehouseId ?? null,
          input.inspectionNote?.trim() || null
        ]
      );

      const remaining = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM return_request_line
         WHERE tenant_id=$1
           AND return_request_id=$2
           AND received_quantity_milli < authorized_quantity_milli`,
        [context.tenantId, returnId]
      );

      await client.query(
        `UPDATE return_request
         SET status=$3,
             received_at=CASE WHEN $3='RECEIVED' THEN COALESCE(received_at,now()) ELSE received_at END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,
          returnId,
          Number(remaining.rows[0]?.count ?? "0") === 0
            ? "RECEIVED"
            : "IN_TRANSIT"
        ]
      );

      return {
        receivedQuantityMilli: next.toString(),
        restocked
      };
    });
  }

  async complete(
    context: TenantContext,
    returnId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const request = await client.query<{ status: string }>(
        `SELECT status FROM return_request
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, returnId]
      );

      const row = request.rows[0];
      if (!row) throw new NotFoundException("Возврат не найден");
      if (row.status === "COMPLETED") return;
      if (row.status !== "RECEIVED") {
        throw new BadRequestException(
          "Сначала полностью примите авторизованный возврат"
        );
      }

      const invalid = await client.query(
        `SELECT 1 FROM return_request_line
         WHERE tenant_id=$1
           AND return_request_id=$2
           AND (
             received_quantity_milli <> authorized_quantity_milli
             OR (authorized_quantity_milli > 0 AND disposition IS NULL)
           )
         LIMIT 1`,
        [context.tenantId, returnId]
      );

      if (invalid.rowCount) {
        throw new ConflictException("Не все строки возврата проверены");
      }

      await client.query(
        `UPDATE return_request
         SET status='COMPLETED',completed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, returnId]
      );

      await this.audit(
        client,
        context,
        "return.completed",
        "return_request",
        returnId,
        { refundAutomatic: false }
      );
    });
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
      `INSERT INTO audit_event(
         tenant_id,actor_user_id,actor_membership_id,
         action,resource_type,resource_id,after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
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
