import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";

type ResourceType =
  | "EMPLOYEE"
  | "ROOM"
  | "EQUIPMENT"
  | "VEHICLE"
  | "WORKPLACE"
  | "HALL"
  | "MACHINE"
  | "OTHER";

@Injectable()
export class ResourcesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async list(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    const access = await this.serviceScope(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           r.id, r.branch_id, b.name AS branch_name, r.membership_id,
           r.type, r.name, r.code, r.capacity,
           r.cost_per_hour_minor::text, r.currency, r.timezone,
           r.status, r.metadata,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', s.id,
                 'code', s.code,
                 'name', s.name,
                 'level', rs.level
               )
             ) FILTER (WHERE s.id IS NOT NULL),
             '[]'::json
           ) AS skills
         FROM service_resource r
         LEFT JOIN branch b
           ON b.tenant_id = r.tenant_id AND b.id = r.branch_id
         LEFT JOIN service_resource_skill rs
           ON rs.tenant_id = r.tenant_id AND rs.resource_id = r.id
         LEFT JOIN service_skill s
           ON s.tenant_id = rs.tenant_id AND s.id = rs.skill_id
         WHERE r.tenant_id = $1
           AND r.status = 'ACTIVE'
           AND (
             $2::uuid[] IS NULL
             OR r.membership_id IS NULL
             OR r.membership_id = ANY($2::uuid[])
           )
         GROUP BY r.id, b.name
         ORDER BY r.type, r.name`,
        [context.tenantId, access.membershipIds]
      );

      return result.rows;
    });
  }

  async create(
    context: TenantContext,
    input: {
      type: ResourceType;
      name: string;
      code?: string;
      branchId?: string;
      membershipId?: string;
      capacity?: number;
      costPerHourMinor?: string;
      currency?: string;
      timezone?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название ресурса");
    }

    const capacity = Math.floor(input.capacity ?? 1);
    if (capacity < 1 || capacity > 100000) {
      throw new BadRequestException("Некорректная вместимость");
    }

    const cost = input.costPerHourMinor ?? "0";
    if (!/^\d+$/.test(cost)) {
      throw new BadRequestException("Некорректная стоимость часа");
    }

    const access = await this.serviceScope(context, "service.write");
    if (
      access.membershipIds !== null &&
      (!input.membershipId || !access.membershipIds.includes(input.membershipId))
    ) {
      throw new ForbiddenException(
        "Можно создавать только собственный ресурс сотрудника"
      );
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.branchId) {
        const branch = await client.query(
          `SELECT 1 FROM branch
           WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
          [context.tenantId, input.branchId]
        );
        if (!branch.rowCount) throw new NotFoundException("Филиал не найден");
      }

      if (input.membershipId) {
        const membership = await client.query(
          `SELECT 1 FROM tenant_membership
           WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
          [context.tenantId, input.membershipId]
        );
        if (!membership.rowCount) {
          throw new NotFoundException("Сотрудник не найден");
        }
      }

      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO service_resource(
             tenant_id, branch_id, membership_id, type, name, code,
             capacity, cost_per_hour_minor, currency, timezone, metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            context.tenantId,
            input.branchId ?? null,
            input.membershipId ?? null,
            input.type,
            name,
            input.code?.trim() || null,
            capacity,
            cost,
            input.currency?.trim().toUpperCase() || "RUB",
            input.timezone?.trim() || "Europe/Moscow",
            JSON.stringify(input.metadata ?? {})
          ]
        );

        const row = result.rows[0];
        if (!row) throw new Error("SERVICE_RESOURCE_CREATE_FAILED");

        await this.audit(
          client,
          context,
          "service.resource_created",
          "service_resource",
          row.id,
          { type: input.type, name }
        );

        return row;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException("Ресурс с таким кодом уже существует");
        }
        throw error;
      }
    });
  }

  async createSkill(
    context: TenantContext,
    input: { code: string; name: string }
  ): Promise<{ id: string }> {
    const access = await this.serviceScope(context, "service.write");
    if (access.scope !== "all") {
      throw new ForbiddenException(
        "Справочник навыков доступен только администратору сервиса"
      );
    }
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();

    if (!/^[A-Z0-9_-]{2,60}$/.test(code)) {
      throw new BadRequestException("Некорректный код навыка");
    }
    if (name.length < 2 || name.length > 120) {
      throw new BadRequestException("Некорректное название навыка");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO service_skill(tenant_id, code, name)
           VALUES ($1,$2,$3)
           RETURNING id`,
          [context.tenantId, code, name]
        );
        return result.rows[0]!;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException("Навык с таким кодом уже существует");
        }
        throw error;
      }
    });
  }

  async assignSkill(
    context: TenantContext,
    resourceId: string,
    skillId: string,
    level: number
  ): Promise<void> {
    const normalizedLevel = Math.floor(level);
    if (normalizedLevel < 1 || normalizedLevel > 5) {
      throw new BadRequestException("Уровень навыка должен быть от 1 до 5");
    }

    const access = await this.serviceScope(context, "service.write");
    await this.database.withTenantTransaction(context, async (client) => {
      await this.assertResource(
        client,
        context.tenantId,
        resourceId,
        access.membershipIds,
        access.scope === "all"
      );
      const skill = await client.query(
        `SELECT 1 FROM service_skill
         WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
        [context.tenantId, skillId]
      );
      if (!skill.rowCount) throw new NotFoundException("Навык не найден");

      await client.query(
        `INSERT INTO service_resource_skill(
           tenant_id, resource_id, skill_id, level
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (resource_id, skill_id)
         DO UPDATE SET level = EXCLUDED.level`,
        [context.tenantId, resourceId, skillId, normalizedLevel]
      );
    });
  }

  async replaceSchedule(
    context: TenantContext,
    resourceId: string,
    windows: Array<{
      weekday: number;
      startMinute: number;
      endMinute: number;
      validFrom?: string;
      validTo?: string;
    }>
  ): Promise<void> {
    if (windows.length > 28) {
      throw new BadRequestException("Слишком много окон расписания");
    }

    for (const window of windows) {
      if (
        !Number.isInteger(window.weekday) ||
        window.weekday < 1 ||
        window.weekday > 7 ||
        !Number.isInteger(window.startMinute) ||
        !Number.isInteger(window.endMinute) ||
        window.startMinute < 0 ||
        window.endMinute > 1440 ||
        window.endMinute <= window.startMinute
      ) {
        throw new BadRequestException("Некорректное окно расписания");
      }
    }

    const access = await this.serviceScope(context, "service.write");
    await this.database.withTenantTransaction(context, async (client) => {
      await this.assertResource(
        client,
        context.tenantId,
        resourceId,
        access.membershipIds,
        access.scope === "all"
      );

      await client.query(
        `DELETE FROM service_resource_schedule
         WHERE tenant_id = $1 AND resource_id = $2`,
        [context.tenantId, resourceId]
      );

      for (const window of windows) {
        await client.query(
          `INSERT INTO service_resource_schedule(
             tenant_id, resource_id, weekday,
             start_minute, end_minute, valid_from, valid_to
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            context.tenantId,
            resourceId,
            window.weekday,
            window.startMinute,
            window.endMinute,
            window.validFrom ?? null,
            window.validTo ?? null
          ]
        );
      }

      await this.audit(
        client,
        context,
        "service.schedule_replaced",
        "service_resource",
        resourceId,
        { windows: windows.length }
      );
    });
  }

  async schedule(
    context: TenantContext,
    resourceId: string
  ): Promise<Array<Record<string, unknown>>> {
    const access = await this.serviceScope(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertResource(
        client,
        context.tenantId,
        resourceId,
        access.membershipIds,
        true
      );
      const result = await client.query(
        `SELECT id, weekday, start_minute, end_minute, valid_from, valid_to
         FROM service_resource_schedule
         WHERE tenant_id = $1 AND resource_id = $2
         ORDER BY weekday, start_minute`,
        [context.tenantId, resourceId]
      );
      return result.rows;
    });
  }

  async addBlock(
    context: TenantContext,
    resourceId: string,
    input: {
      startsAt: string;
      endsAt: string;
      type?: "UNAVAILABLE" | "VACATION" | "SICK" | "MAINTENANCE" | "OTHER";
      reason?: string;
    }
  ): Promise<{ id: string }> {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);

    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      throw new BadRequestException("Некорректный период недоступности");
    }

    const access = await this.serviceScope(context, "service.write");
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertResource(
        client,
        context.tenantId,
        resourceId,
        access.membershipIds,
        access.scope === "all"
      );

      const result = await client.query<{ id: string }>(
        `INSERT INTO service_resource_block(
           tenant_id, resource_id, starts_at, ends_at,
           reason, type, created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          context.tenantId,
          resourceId,
          startsAt,
          endsAt,
          input.reason?.trim() || null,
          input.type ?? "UNAVAILABLE",
          context.membershipId
        ]
      );

      return result.rows[0]!;
    });
  }

  async blocks(
    context: TenantContext,
    resourceId: string,
    from?: string,
    to?: string
  ): Promise<Array<Record<string, unknown>>> {
    const access = await this.serviceScope(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertResource(
        client,
        context.tenantId,
        resourceId,
        access.membershipIds,
        true
      );

      const fromDate = from ? new Date(from) : new Date();
      const toDate = to
        ? new Date(to)
        : new Date(fromDate.getTime() + 90 * 86400000);

      const result = await client.query(
        `SELECT id, starts_at, ends_at, reason, type
         FROM service_resource_block
         WHERE tenant_id = $1
           AND resource_id = $2
           AND starts_at < $4
           AND ends_at > $3
         ORDER BY starts_at`,
        [context.tenantId, resourceId, fromDate, toDate]
      );

      return result.rows;
    });
  }

  private async serviceScope(
    context: TenantContext,
    permission: "service.read" | "service.write"
  ): Promise<{
    scope: "own" | "team" | "branch" | "all";
    membershipIds: string[] | null;
  }> {
    const scope = await this.authorization.resolveScope(context, permission);
    if (!scope) throw new ForbiddenException("Недостаточно прав");
    return {
      scope,
      membershipIds: await this.authorization.membershipIdsForScope(
        context,
        scope
      )
    };
  }

  private async assertResource(
    client: PoolClient,
    tenantId: string,
    resourceId: string,
    scopedMembershipIds: string[] | null,
    allowShared: boolean
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1
       FROM service_resource
       WHERE tenant_id=$1
         AND id=$2
         AND status='ACTIVE'
         AND (
           $3::uuid[] IS NULL
           OR membership_id = ANY($3::uuid[])
           OR ($4::boolean AND membership_id IS NULL)
         )`,
      [tenantId, resourceId, scopedMembershipIds, allowShared]
    );
    if (!result.rowCount) throw new NotFoundException("Ресурс не найден");
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id, actor_user_id, actor_membership_id,
         action, resource_type, resource_id, after_data
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

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
    );
  }
}
