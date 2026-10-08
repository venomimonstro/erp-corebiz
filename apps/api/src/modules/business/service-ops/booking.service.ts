import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { DomainEventService } from "../../platform/events/domain-event.service";

type BookingStatus =
  | "DRAFT"
  | "CONFIRMED"
  | "ARRIVED"
  | "IN_SERVICE"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

@Injectable()
export class BookingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: DomainEventService
  ) {}

  async services(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           s.id, s.name, s.code, s.category, s.duration_minutes,
           s.buffer_before_minutes, s.buffer_after_minutes,
           s.price_minor::text, s.currency, s.metadata,
           COALESCE(
             json_agg(
               json_build_object(
                 'skillId', r.skill_id,
                 'minLevel', r.min_level,
                 'resourceType', r.resource_type
               )
             ) FILTER (WHERE r.skill_id IS NOT NULL),
             '[]'::json
           ) AS requirements
         FROM service_catalog_item s
         LEFT JOIN service_catalog_skill_requirement r
           ON r.tenant_id = s.tenant_id AND r.service_id = s.id
         WHERE s.tenant_id = $1 AND s.status = 'ACTIVE'
         GROUP BY s.id
         ORDER BY s.category NULLS LAST, s.name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createService(
    context: TenantContext,
    input: {
      name: string;
      code?: string;
      category?: string;
      durationMinutes: number;
      bufferBeforeMinutes?: number;
      bufferAfterMinutes?: number;
      priceMinor?: string;
      currency?: string;
    }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название услуги");
    }

    const duration = Math.floor(input.durationMinutes);
    if (duration < 5 || duration > 1440) {
      throw new BadRequestException("Длительность услуги должна быть от 5 до 1440 минут");
    }

    const before = Math.floor(input.bufferBeforeMinutes ?? 0);
    const after = Math.floor(input.bufferAfterMinutes ?? 0);
    if (before < 0 || before > 240 || after < 0 || after > 240) {
      throw new BadRequestException("Буфер должен быть от 0 до 240 минут");
    }

    const price = input.priceMinor ?? "0";
    if (!/^\d+$/.test(price)) {
      throw new BadRequestException("Некорректная цена услуги");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO service_catalog_item(
             tenant_id, name, code, category, duration_minutes,
             buffer_before_minutes, buffer_after_minutes,
             price_minor, currency
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id`,
          [
            context.tenantId,
            name,
            input.code?.trim() || null,
            input.category?.trim() || null,
            duration,
            before,
            after,
            price,
            input.currency?.trim().toUpperCase() || "RUB"
          ]
        );

        return result.rows[0]!;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException("Услуга с таким кодом уже существует");
        }
        throw error;
      }
    });
  }

  async addRequirement(
    context: TenantContext,
    serviceId: string,
    input: {
      skillId: string;
      minLevel?: number;
      resourceType?: string;
    }
  ): Promise<void> {
    const minLevel = Math.floor(input.minLevel ?? 1);
    if (minLevel < 1 || minLevel > 5) {
      throw new BadRequestException("Уровень навыка должен быть от 1 до 5");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      await this.assertService(client, context.tenantId, serviceId);

      const skill = await client.query(
        `SELECT 1 FROM service_skill
         WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
        [context.tenantId, input.skillId]
      );
      if (!skill.rowCount) throw new NotFoundException("Навык не найден");

      await client.query(
        `INSERT INTO service_catalog_skill_requirement(
           tenant_id, service_id, skill_id, min_level, resource_type
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (service_id, skill_id)
         DO UPDATE SET
           min_level = EXCLUDED.min_level,
           resource_type = EXCLUDED.resource_type`,
        [
          context.tenantId,
          serviceId,
          input.skillId,
          minLevel,
          input.resourceType?.trim().toUpperCase() || "EMPLOYEE"
        ]
      );
    });
  }

  async availability(
    context: TenantContext,
    input: {
      serviceId: string;
      from: string;
      to: string;
      resourceType?: string;
      slotStepMinutes?: number;
    }
  ): Promise<Array<{
    resourceId: string;
    resourceName: string;
    startsAt: string;
    endsAt: string;
  }>> {
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 31 * 86400000
    ) {
      throw new BadRequestException("Некорректный период availability");
    }

    const step = Math.max(5, Math.min(120, Math.floor(input.slotStepMinutes ?? 30)));

    return this.database.withTenantTransaction(context, async (client) => {
      const service = await this.getService(client, context.tenantId, input.serviceId);

      const resources = await client.query<{
        id: string;
        name: string;
        type: string;
        capacity: number;
        timezone: string;
      }>(
        `SELECT r.id, r.name, r.type, r.capacity, r.timezone
         FROM service_resource r
         WHERE r.tenant_id = $1
           AND r.status = 'ACTIVE'
           AND ($2::text IS NULL OR r.type = $2)
           AND NOT EXISTS (
             SELECT 1
             FROM service_catalog_skill_requirement req
             WHERE req.tenant_id = r.tenant_id
               AND req.service_id = $3
               AND req.resource_type = r.type
               AND NOT EXISTS (
                 SELECT 1
                 FROM service_resource_skill rs
                 WHERE rs.tenant_id = r.tenant_id
                   AND rs.resource_id = r.id
                   AND rs.skill_id = req.skill_id
                   AND rs.level >= req.min_level
               )
           )
         ORDER BY r.name
         LIMIT 100`,
        [
          context.tenantId,
          input.resourceType?.trim().toUpperCase() || null,
          input.serviceId
        ]
      );

      const result: Array<{
        resourceId: string;
        resourceName: string;
        startsAt: string;
        endsAt: string;
      }> = [];

      for (const resource of resources.rows) {
        let cursor = new Date(from);
        while (cursor < to && result.length < 500) {
          const endsAt = new Date(
            cursor.getTime() + service.duration_minutes * 60000
          );

          if (endsAt > to) break;

          const ok = await this.resourceAvailable(
            client,
            context.tenantId,
            resource.id,
            cursor,
            endsAt,
            service.buffer_before_minutes,
            service.buffer_after_minutes,
            1
          );

          if (ok) {
            result.push({
              resourceId: resource.id,
              resourceName: resource.name,
              startsAt: cursor.toISOString(),
              endsAt: endsAt.toISOString()
            });
          }

          cursor = new Date(cursor.getTime() + step * 60000);
        }
      }

      return result;
    });
  }

  async bookings(
    context: TenantContext,
    from?: string,
    to?: string
  ): Promise<Array<Record<string, unknown>>> {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 86400000);
    const toDate = to ? new Date(to) : new Date(Date.now() + 30 * 86400000);

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           b.id, b.business_number, b.status, b.source,
           b.starts_at, b.ends_at, b.price_minor_snapshot::text,
           b.currency, b.version, b.notes,
           p.display_name AS party_name,
           s.name AS service_name,
           COALESCE(
             json_agg(
               json_build_object(
                 'resourceId', r.id,
                 'resourceName', r.name,
                 'type', r.type,
                 'capacityUnits', br.capacity_units
               )
             ) FILTER (WHERE r.id IS NOT NULL),
             '[]'::json
           ) AS resources
         FROM service_booking b
         JOIN service_catalog_item s
           ON s.tenant_id = b.tenant_id AND s.id = b.service_id
         LEFT JOIN party p
           ON p.tenant_id = b.tenant_id AND p.id = b.party_id
         LEFT JOIN service_booking_resource br
           ON br.tenant_id = b.tenant_id AND br.booking_id = b.id
         LEFT JOIN service_resource r
           ON r.tenant_id = br.tenant_id AND r.id = br.resource_id
         WHERE b.tenant_id = $1
           AND b.starts_at < $3
           AND b.ends_at > $2
         GROUP BY b.id, p.display_name, s.name
         ORDER BY b.starts_at`,
        [context.tenantId, fromDate, toDate]
      );

      return result.rows;
    });
  }

  async createBooking(
    context: TenantContext,
    input: {
      serviceId: string;
      resourceIds: string[];
      startsAt: string;
      partyId?: string;
      branchId?: string;
      notes?: string;
      source?: "MANUAL" | "PUBLIC_SITE" | "PHONE" | "API" | "IMPORT";
      idempotencyKey?: string;
    }
  ): Promise<{ id: string; number: string; version: number }> {
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException("Некорректное время записи");
    }

    const resourceIds = Array.from(new Set(input.resourceIds ?? [])).sort();
    if (!resourceIds.length || resourceIds.length > 10) {
      throw new BadRequestException("Выберите от 1 до 10 ресурсов");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.idempotencyKey) {
        const existing = await client.query<{
          id: string;
          business_number: string;
          version: number;
        }>(
          `SELECT id, business_number, version
           FROM service_booking
           WHERE tenant_id = $1 AND idempotency_key = $2`,
          [context.tenantId, input.idempotencyKey]
        );

        if (existing.rows[0]) {
          return {
            id: existing.rows[0].id,
            number: existing.rows[0].business_number,
            version: existing.rows[0].version
          };
        }
      }

      const service = await this.getService(client, context.tenantId, input.serviceId);
      const endsAt = new Date(
        startsAt.getTime() + service.duration_minutes * 60000
      );

      if (input.partyId) {
        const party = await client.query(
          `SELECT 1 FROM party
           WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
          [context.tenantId, input.partyId]
        );
        if (!party.rowCount) throw new NotFoundException("Клиент не найден");
      }

      const resources = await this.lockResources(
        client,
        context.tenantId,
        resourceIds
      );

      await this.assertRequirements(
        client,
        context.tenantId,
        input.serviceId,
        resources
      );

      for (const resource of resources) {
        const available = await this.resourceAvailable(
          client,
          context.tenantId,
          resource.id,
          startsAt,
          endsAt,
          service.buffer_before_minutes,
          service.buffer_after_minutes,
          1
        );

        if (!available) {
          throw new ConflictException(
            "Ресурс недоступен в выбранное время: " + resource.name
          );
        }
      }

      const number = await this.nextNumber(
        client,
        context.tenantId,
        "service_booking",
        "BOOK"
      );

      const result = await client.query<{
        id: string;
        business_number: string;
        version: number;
      }>(
        `INSERT INTO service_booking(
           tenant_id, business_number, party_id, service_id, branch_id,
           status, source, starts_at, ends_at,
           price_minor_snapshot, currency,
           duration_minutes_snapshot,
           buffer_before_minutes_snapshot,
           buffer_after_minutes_snapshot,
           notes, idempotency_key, created_by_membership_id
         ) VALUES (
           $1,$2,$3,$4,$5,'CONFIRMED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         )
         RETURNING id, business_number, version`,
        [
          context.tenantId,
          number,
          input.partyId ?? null,
          input.serviceId,
          input.branchId ?? null,
          input.source ?? "MANUAL",
          startsAt,
          endsAt,
          service.price_minor,
          service.currency,
          service.duration_minutes,
          service.buffer_before_minutes,
          service.buffer_after_minutes,
          input.notes?.trim() || null,
          input.idempotencyKey?.trim() || null,
          context.membershipId
        ]
      );

      const booking = result.rows[0];
      if (!booking) throw new Error("SERVICE_BOOKING_CREATE_FAILED");

      for (const resource of resources) {
        await client.query(
          `INSERT INTO service_booking_resource(
             tenant_id, booking_id, resource_id, capacity_units,
             cost_per_hour_minor_snapshot
           ) VALUES ($1,$2,$3,1,$4)`,
          [
            context.tenantId,
            booking.id,
            resource.id,
            resource.cost_per_hour_minor
          ]
        );
      }

      await this.events.enqueue(client, context, {
        eventName: "service.booking_created",
        entityType: "SERVICE_BOOKING",
        entityId: booking.id,
        payload: {
          bookingId: booking.id,
          number,
          serviceId: input.serviceId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          partyId: input.partyId ?? null,
          resourceIds
        }
      });

      return {
        id: booking.id,
        number: booking.business_number,
        version: booking.version
      };
    });
  }

  async reschedule(
    context: TenantContext,
    bookingId: string,
    input: {
      startsAt: string;
      resourceIds?: string[];
      version: number;
    }
  ): Promise<{ version: number }> {
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException("Некорректное время записи");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const bookingResult = await client.query<{
        id: string;
        service_id: string;
        status: BookingStatus;
        duration_minutes_snapshot: number;
        buffer_before_minutes_snapshot: number;
        buffer_after_minutes_snapshot: number;
        version: number;
      }>(
        `SELECT id, service_id, status,
                duration_minutes_snapshot,
                buffer_before_minutes_snapshot,
                buffer_after_minutes_snapshot,
                version
         FROM service_booking
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, bookingId]
      );

      const booking = bookingResult.rows[0];
      if (!booking) throw new NotFoundException("Запись не найдена");
      if (booking.version !== input.version) {
        throw new ConflictException("Запись уже была изменена");
      }
      if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(booking.status)) {
        throw new BadRequestException("Эту запись нельзя перенести");
      }

      let resourceIds = input.resourceIds?.length
        ? Array.from(new Set(input.resourceIds)).sort()
        : (
            await client.query<{ resource_id: string }>(
              `SELECT resource_id
               FROM service_booking_resource
               WHERE tenant_id = $1 AND booking_id = $2
               ORDER BY resource_id`,
              [context.tenantId, bookingId]
            )
          ).rows.map((row) => row.resource_id);

      const resources = await this.lockResources(
        client,
        context.tenantId,
        resourceIds
      );

      const endsAt = new Date(
        startsAt.getTime() + booking.duration_minutes_snapshot * 60000
      );

      await this.assertRequirements(
        client,
        context.tenantId,
        booking.service_id,
        resources
      );

      for (const resource of resources) {
        const available = await this.resourceAvailable(
          client,
          context.tenantId,
          resource.id,
          startsAt,
          endsAt,
          booking.buffer_before_minutes_snapshot,
          booking.buffer_after_minutes_snapshot,
          1,
          bookingId
        );

        if (!available) {
          throw new ConflictException(
            "Ресурс недоступен в выбранное время: " + resource.name
          );
        }
      }

      await client.query(
        `DELETE FROM service_booking_resource
         WHERE tenant_id = $1 AND booking_id = $2`,
        [context.tenantId, bookingId]
      );

      for (const resource of resources) {
        await client.query(
          `INSERT INTO service_booking_resource(
             tenant_id, booking_id, resource_id, capacity_units,
             cost_per_hour_minor_snapshot
           ) VALUES ($1,$2,$3,1,$4)`,
          [
            context.tenantId,
            bookingId,
            resource.id,
            resource.cost_per_hour_minor
          ]
        );
      }

      const update = await client.query<{ version: number }>(
        `UPDATE service_booking
         SET starts_at = $3,
             ends_at = $4,
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING version`,
        [context.tenantId, bookingId, startsAt, endsAt]
      );

      await this.events.enqueue(client, context, {
        eventName: "service.booking_rescheduled",
        entityType: "SERVICE_BOOKING",
        entityId: bookingId,
        payload: {
          bookingId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          resourceIds
        }
      });

      return { version: update.rows[0]!.version };
    });
  }

  async setStatus(
    context: TenantContext,
    bookingId: string,
    status: "ARRIVED" | "IN_SERVICE" | "COMPLETED" | "CANCELLED" | "NO_SHOW",
    version: number
  ): Promise<{ version: number; status: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ version: number; status: string }>(
        `UPDATE service_booking
         SET status = $3,
             version = version + 1,
             updated_at = now(),
             cancelled_at = CASE WHEN $3 = 'CANCELLED' THEN now() ELSE cancelled_at END,
             completed_at = CASE WHEN $3 = 'COMPLETED' THEN now() ELSE completed_at END
         WHERE tenant_id = $1
           AND id = $2
           AND version = $4
           AND status NOT IN ('COMPLETED','CANCELLED','NO_SHOW')
         RETURNING version, status`,
        [context.tenantId, bookingId, status, version]
      );

      const row = result.rows[0];
      if (!row) {
        throw new ConflictException("Запись уже изменена или переход недоступен");
      }

      await this.events.enqueue(client, context, {
        eventName: "service.booking_status_changed",
        entityType: "SERVICE_BOOKING",
        entityId: bookingId,
        payload: {
          bookingId,
          status: row.status,
          version: row.version
        }
      });

      return row;
    });
  }

  private async resourceAvailable(
    client: PoolClient,
    tenantId: string,
    resourceId: string,
    startsAt: Date,
    endsAt: Date,
    bufferBeforeMinutes: number,
    bufferAfterMinutes: number,
    capacityUnits: number,
    ignoreBookingId?: string
  ): Promise<boolean> {
    const reservedStart = new Date(
      startsAt.getTime() - bufferBeforeMinutes * 60000
    );
    const reservedEnd = new Date(
      endsAt.getTime() + bufferAfterMinutes * 60000
    );

    const schedule = await client.query(
      `SELECT 1
       FROM service_resource r
       JOIN service_resource_schedule s
         ON s.tenant_id = r.tenant_id
        AND s.resource_id = r.id
       WHERE r.tenant_id = $1
         AND r.id = $2
         AND s.weekday = EXTRACT(ISODOW FROM ($3::timestamptz AT TIME ZONE r.timezone))
         AND (
           EXTRACT(HOUR FROM ($3::timestamptz AT TIME ZONE r.timezone))::int * 60
           + EXTRACT(MINUTE FROM ($3::timestamptz AT TIME ZONE r.timezone))::int
         ) >= s.start_minute
         AND (
           EXTRACT(HOUR FROM ($4::timestamptz AT TIME ZONE r.timezone))::int * 60
           + EXTRACT(MINUTE FROM ($4::timestamptz AT TIME ZONE r.timezone))::int
         ) <= s.end_minute
         AND (s.valid_from IS NULL OR s.valid_from <= ($3::timestamptz AT TIME ZONE r.timezone)::date)
         AND (s.valid_to IS NULL OR s.valid_to >= ($3::timestamptz AT TIME ZONE r.timezone)::date)
       LIMIT 1`,
      [tenantId, resourceId, reservedStart, reservedEnd]
    );

    if (!schedule.rowCount) return false;

    const blocked = await client.query(
      `SELECT 1
       FROM service_resource_block
       WHERE tenant_id = $1
         AND resource_id = $2
         AND starts_at < $4
         AND ends_at > $3
       LIMIT 1`,
      [tenantId, resourceId, reservedStart, reservedEnd]
    );

    if (blocked.rowCount) return false;

    const capacity = await client.query<{
      capacity: number;
      occupied: string;
    }>(
      `SELECT
         r.capacity,
         COALESCE(sum(
           CASE WHEN b.id IS NOT NULL THEN br.capacity_units ELSE 0 END
         ), 0)::text AS occupied
       FROM service_resource r
       LEFT JOIN service_booking_resource br
         ON br.tenant_id = r.tenant_id
        AND br.resource_id = r.id
       LEFT JOIN service_booking b
         ON b.tenant_id = br.tenant_id
        AND b.id = br.booking_id
        AND b.status IN ('CONFIRMED','ARRIVED','IN_SERVICE')
        AND b.id <> COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND (
          (b.starts_at - make_interval(mins => b.buffer_before_minutes_snapshot)) < $4
          AND
          (b.ends_at + make_interval(mins => b.buffer_after_minutes_snapshot)) > $3
        )
       WHERE r.tenant_id = $1 AND r.id = $2
       GROUP BY r.id`,
      [tenantId, resourceId, reservedStart, reservedEnd, ignoreBookingId ?? null]
    );

    const row = capacity.rows[0];
    if (!row) return false;

    return Number(row.occupied) + capacityUnits <= row.capacity;
  }

  private async lockResources(
    client: PoolClient,
    tenantId: string,
    resourceIds: string[]
  ): Promise<Array<{
    id: string;
    name: string;
    type: string;
    capacity: number;
    cost_per_hour_minor: string;
  }>> {
    const result = await client.query<{
      id: string;
      name: string;
      type: string;
      capacity: number;
      cost_per_hour_minor: string;
    }>(
      `SELECT id, name, type, capacity, cost_per_hour_minor::text
       FROM service_resource
       WHERE tenant_id = $1
         AND id = ANY($2::uuid[])
         AND status = 'ACTIVE'
       ORDER BY id
       FOR UPDATE`,
      [tenantId, resourceIds]
    );

    if (result.rowCount !== resourceIds.length) {
      throw new NotFoundException("Один или несколько ресурсов недоступны");
    }

    return result.rows;
  }

  private async assertRequirements(
    client: PoolClient,
    tenantId: string,
    serviceId: string,
    resources: Array<{ id: string; type: string }>
  ): Promise<void> {
    const requirements = await client.query<{
      skill_id: string;
      min_level: number;
      resource_type: string;
    }>(
      `SELECT skill_id, min_level, resource_type
       FROM service_catalog_skill_requirement
       WHERE tenant_id = $1 AND service_id = $2`,
      [tenantId, serviceId]
    );

    for (const requirement of requirements.rows) {
      const eligibleResourceIds = resources
        .filter((resource) => resource.type === requirement.resource_type)
        .map((resource) => resource.id);

      if (!eligibleResourceIds.length) {
        throw new BadRequestException(
          "Не выбран ресурс типа " + requirement.resource_type
        );
      }

      const qualified = await client.query(
        `SELECT 1
         FROM service_resource_skill
         WHERE tenant_id = $1
           AND resource_id = ANY($2::uuid[])
           AND skill_id = $3
           AND level >= $4
         LIMIT 1`,
        [
          tenantId,
          eligibleResourceIds,
          requirement.skill_id,
          requirement.min_level
        ]
      );

      if (!qualified.rowCount) {
        throw new BadRequestException("Выбранные ресурсы не соответствуют навыкам услуги");
      }
    }
  }

  private async getService(
    client: PoolClient,
    tenantId: string,
    serviceId: string
  ): Promise<{
    id: string;
    duration_minutes: number;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
    price_minor: string;
    currency: string;
  }> {
    const result = await client.query<{
      id: string;
      duration_minutes: number;
      buffer_before_minutes: number;
      buffer_after_minutes: number;
      price_minor: string;
      currency: string;
    }>(
      `SELECT id, duration_minutes, buffer_before_minutes,
              buffer_after_minutes, price_minor::text, currency
       FROM service_catalog_item
       WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [tenantId, serviceId]
    );

    const row = result.rows[0];
    if (!row) throw new NotFoundException("Услуга не найдена");
    return row;
  }

  private async assertService(
    client: PoolClient,
    tenantId: string,
    serviceId: string
  ): Promise<void> {
    await this.getService(client, tenantId, serviceId);
  }

  private async nextNumber(
    client: PoolClient,
    tenantId: string,
    counterKey: string,
    prefix: string
  ): Promise<string> {
    const counter = await client.query<{ value: string }>(
      `INSERT INTO tenant_counter(tenant_id, counter_key, value)
       VALUES ($1,$2,1)
       ON CONFLICT (tenant_id, counter_key)
       DO UPDATE SET
         value = tenant_counter.value + 1,
         updated_at = now()
       RETURNING value::text`,
      [tenantId, counterKey]
    );

    const sequence = BigInt(counter.rows[0]?.value ?? "0");
    const year = new Date().getUTCFullYear();
    return `${prefix}-${year}-${sequence.toString().padStart(6, "0")}`;
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
    );
  }
}
