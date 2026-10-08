import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { DomainEventService } from "../../platform/events/domain-event.service";
import { InventoryService } from "../inventory/inventory.service";

@Injectable()
export class ServiceWorkspaceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventory: InventoryService,
    private readonly events: DomainEventService
  ) {}

  async today(
    context: TenantContext,
    date?: string
  ): Promise<{
    bookings: Array<Record<string, unknown>>;
    metrics: {
      total: number;
      completed: number;
      noShow: number;
      revenueMinor: string;
    };
  }> {
    const base = date ? new Date(date) : new Date();
    if (Number.isNaN(base.getTime())) {
      throw new BadRequestException("Некорректная дата");
    }

    const start = new Date(base);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86400000);

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT b.id,b.business_number,b.status,b.starts_at,b.ends_at," +
        "b.price_minor_snapshot::text,b.currency,b.version," +
        "p.display_name AS party_name,s.name AS service_name," +
        "COALESCE(json_agg(json_build_object(" +
        "'resourceId',r.id,'resourceName',r.name,'type',r.type" +
        ")) FILTER (WHERE r.id IS NOT NULL),'[]'::json) AS resources " +
        "FROM service_booking b " +
        "JOIN service_catalog_item s ON s.tenant_id=b.tenant_id AND s.id=b.service_id " +
        "LEFT JOIN party p ON p.tenant_id=b.tenant_id AND p.id=b.party_id " +
        "LEFT JOIN service_booking_resource br ON br.tenant_id=b.tenant_id AND br.booking_id=b.id " +
        "LEFT JOIN service_resource r ON r.tenant_id=br.tenant_id AND r.id=br.resource_id " +
        "WHERE b.tenant_id=$1 AND b.starts_at >= $2 AND b.starts_at < $3 " +
        "GROUP BY b.id,p.display_name,s.name ORDER BY b.starts_at",
        [context.tenantId, start, end]
      );

      let completed = 0;
      let noShow = 0;
      let revenue = 0n;

      for (const row of result.rows) {
        if (row.status === "COMPLETED") {
          completed += 1;
          revenue += BigInt(row.price_minor_snapshot);
        }
        if (row.status === "NO_SHOW") noShow += 1;
      }

      return {
        bookings: result.rows,
        metrics: {
          total: result.rowCount ?? 0,
          completed,
          noShow,
          revenueMinor: revenue.toString()
        }
      };
    });
  }

  async addMaterial(
    context: TenantContext,
    bookingId: string,
    input: {
      warehouseId: string;
      skuId: string;
      quantityMilli: string;
    }
  ): Promise<{ id: string }> {
    if (!/^\d+$/.test(input.quantityMilli)) {
      throw new BadRequestException("Некорректное количество");
    }

    const quantity = BigInt(input.quantityMilli);
    if (quantity <= 0n) {
      throw new BadRequestException("Количество должно быть больше нуля");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const booking = await client.query<{ status: string }>(
        "SELECT status FROM service_booking WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, bookingId]
      );

      const row = booking.rows[0];
      if (!row) throw new NotFoundException("Запись не найдена");
      if (["CANCELLED", "NO_SHOW"].includes(row.status)) {
        throw new BadRequestException("К этой записи нельзя добавить расход");
      }

      const warehouse = await client.query(
        "SELECT 1 FROM warehouse WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId, input.warehouseId]
      );
      if (!warehouse.rowCount) throw new NotFoundException("Склад не найден");

      const sku = await client.query<{ cost_price_minor: string }>(
        "SELECT cost_price_minor::text FROM sku " +
        "WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId, input.skuId]
      );
      const skuRow = sku.rows[0];
      if (!skuRow) throw new NotFoundException("SKU не найден");

      const result = await client.query<{ id: string }>(
        "INSERT INTO service_booking_material(" +
        "tenant_id,booking_id,warehouse_id,sku_id,planned_quantity_milli," +
        "unit_cost_minor_snapshot" +
        ") VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [
          context.tenantId,
          bookingId,
          input.warehouseId,
          input.skuId,
          quantity.toString(),
          skuRow.cost_price_minor
        ]
      );

      return result.rows[0]!;
    });
  }

  async materials(
    context: TenantContext,
    bookingId: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT m.id,m.warehouse_id,w.name AS warehouse_name," +
        "m.sku_id,s.code AS sku,p.name AS product_name," +
        "m.planned_quantity_milli::text,m.consumed_quantity_milli::text " +
        "FROM service_booking_material m " +
        "JOIN warehouse w ON w.tenant_id=m.tenant_id AND w.id=m.warehouse_id " +
        "JOIN sku s ON s.tenant_id=m.tenant_id AND s.id=m.sku_id " +
        "JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id " +
        "JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id " +
        "WHERE m.tenant_id=$1 AND m.booking_id=$2 ORDER BY m.created_at",
        [context.tenantId, bookingId]
      );

      return result.rows;
    });
  }

  async consumeMaterial(
    context: TenantContext,
    materialLineId: string,
    input: {
      quantityMilli: string;
      idempotencyKey: string;
    }
  ): Promise<{ applied: boolean; consumedQuantityMilli: string }> {
    if (!/^\d+$/.test(input.quantityMilli)) {
      throw new BadRequestException("Некорректное количество");
    }

    const quantity = BigInt(input.quantityMilli);
    if (quantity <= 0n) {
      throw new BadRequestException("Количество должно быть больше нуля");
    }

    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const lineResult = await client.query<{
        id: string;
        booking_id: string;
        warehouse_id: string;
        sku_id: string;
        planned_quantity_milli: string;
        consumed_quantity_milli: string;
        booking_status: string;
      }>(
        "SELECT m.id,m.booking_id,m.warehouse_id,m.sku_id," +
        "m.planned_quantity_milli::text,m.consumed_quantity_milli::text," +
        "b.status AS booking_status " +
        "FROM service_booking_material m " +
        "JOIN service_booking b ON b.tenant_id=m.tenant_id AND b.id=m.booking_id " +
        "WHERE m.tenant_id=$1 AND m.id=$2 FOR UPDATE OF m",
        [context.tenantId, materialLineId]
      );

      const line = lineResult.rows[0];
      if (!line) throw new NotFoundException("Строка материала не найдена");
      if (["CANCELLED", "NO_SHOW"].includes(line.booking_status)) {
        throw new BadRequestException("По отменённой записи расход невозможен");
      }

      const remaining =
        BigInt(line.planned_quantity_milli) -
        BigInt(line.consumed_quantity_milli);

      if (quantity > remaining) {
        throw new ConflictException("Расход превышает запланированное количество");
      }

      const movement = await this.inventory.consumeForService(client, context, {
        bookingId: line.booking_id,
        warehouseId: line.warehouse_id,
        materialLineId: line.id,
        skuId: line.sku_id,
        quantityMilli: quantity,
        idempotencyKey: input.idempotencyKey
      });

      let consumed = BigInt(line.consumed_quantity_milli);

      if (movement.applied) {
        consumed += quantity;

        await client.query(
          "UPDATE service_booking_material SET consumed_quantity_milli=$3," +
          "updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [context.tenantId, line.id, consumed.toString()]
        );

        await this.events.enqueue(client, context, {
          eventName: "service.material_consumed",
          entityType: "SERVICE_BOOKING",
          entityId: line.booking_id,
          payload: {
            bookingId: line.booking_id,
            materialLineId: line.id,
            skuId: line.sku_id,
            quantityMilli: quantity.toString()
          }
        });
      }

      return {
        applied: movement.applied,
        consumedQuantityMilli: consumed.toString()
      };
    });
  }

  async customerHistory(
    context: TenantContext,
    partyId: string
  ): Promise<{
    customer: { id: string; name: string };
    bookings: Array<Record<string, unknown>>;
    completedRevenueMinor: string;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const party = await client.query<{ id: string; display_name: string }>(
        "SELECT id,display_name FROM party WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, partyId]
      );

      const customer = party.rows[0];
      if (!customer) throw new NotFoundException("Клиент не найден");

      const bookings = await client.query(
        "SELECT b.id,b.business_number,b.status,b.starts_at,b.ends_at," +
        "b.price_minor_snapshot::text,b.currency,s.name AS service_name " +
        "FROM service_booking b " +
        "JOIN service_catalog_item s ON s.tenant_id=b.tenant_id AND s.id=b.service_id " +
        "WHERE b.tenant_id=$1 AND b.party_id=$2 " +
        "ORDER BY b.starts_at DESC LIMIT 100",
        [context.tenantId, partyId]
      );

      const revenue = bookings.rows.reduce(
        (sum, row) =>
          row.status === "COMPLETED"
            ? sum + BigInt(row.price_minor_snapshot)
            : sum,
        0n
      );

      return {
        customer: {
          id: customer.id,
          name: customer.display_name
        },
        bookings: bookings.rows,
        completedRevenueMinor: revenue.toString()
      };
    });
  }

  async analytics(
    context: TenantContext,
    fromInput?: string,
    toInput?: string
  ): Promise<{
    services: Array<Record<string, unknown>>;
    resources: Array<Record<string, unknown>>;
  }> {
    const to = toInput ? new Date(toInput) : new Date();
    const from = fromInput
      ? new Date(fromInput)
      : new Date(to.getTime() - 30 * 86400000);

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException("Некорректный период аналитики");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const services = await client.query(
        "SELECT s.id,s.name,count(b.id)::int AS bookings," +
        "count(b.id) FILTER (WHERE b.status='COMPLETED')::int AS completed," +
        "count(b.id) FILTER (WHERE b.status='NO_SHOW')::int AS no_show," +
        "COALESCE(sum(b.price_minor_snapshot) FILTER (WHERE b.status='COMPLETED'),0)::text AS revenue_minor " +
        "FROM service_catalog_item s " +
        "LEFT JOIN service_booking b ON b.tenant_id=s.tenant_id AND b.service_id=s.id " +
        "AND b.starts_at >= $2 AND b.starts_at < $3 " +
        "WHERE s.tenant_id=$1 GROUP BY s.id ORDER BY revenue_minor::bigint DESC,s.name",
        [context.tenantId, from, to]
      );

      const resources = await client.query(
        "SELECT r.id,r.name,r.type,count(DISTINCT b.id)::int AS bookings," +
        "COALESCE(sum(EXTRACT(EPOCH FROM (b.ends_at-b.starts_at))/60) FILTER (" +
        "WHERE b.status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED')),0)::bigint AS booked_minutes," +
        "count(DISTINCT b.id) FILTER (WHERE b.status='COMPLETED')::int AS completed " +
        "FROM service_resource r " +
        "LEFT JOIN service_booking_resource br ON br.tenant_id=r.tenant_id AND br.resource_id=r.id " +
        "LEFT JOIN service_booking b ON b.tenant_id=br.tenant_id AND b.id=br.booking_id " +
        "AND b.starts_at >= $2 AND b.starts_at < $3 " +
        "WHERE r.tenant_id=$1 AND r.status='ACTIVE' " +
        "GROUP BY r.id ORDER BY booked_minutes DESC,r.name",
        [context.tenantId, from, to]
      );

      return {
        services: services.rows,
        resources: resources.rows
      };
    });
  }
}
