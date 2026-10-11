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
import { DomainEventService } from "../../platform/events/domain-event.service";
import { AttributionService } from "../growth/attribution.service";
import { InventoryService } from "../inventory/inventory.service";
import { ServiceEconomicsService } from "./service-economics.service";

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
    private readonly events: DomainEventService,
    private readonly attribution: AttributionService,
    private readonly authorization: AuthorizationService,
    private readonly inventory: InventoryService,
    private readonly economics: ServiceEconomicsService
  ) {}

  async services(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           s.id, s.name, s.code, s.category, s.duration_minutes,
           s.buffer_before_minutes, s.buffer_after_minutes,
           s.price_minor::text, s.currency, s.delivery_format,
           s.group_capacity, s.metadata,
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
      deliveryFormat?: "INDIVIDUAL" | "GROUP" | "SELF_PRACTICE" | "RENTAL";
      groupCapacity?: number;
    }
  ): Promise<{ id: string }> {
    await this.requireServiceAll(context, "service.write");
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

    const deliveryFormat = input.deliveryFormat ?? "INDIVIDUAL";
    if (!["INDIVIDUAL","GROUP","SELF_PRACTICE","RENTAL"].includes(deliveryFormat)) {
      throw new BadRequestException("Некорректный формат услуги");
    }
    const groupCapacity = Math.floor(input.groupCapacity ?? 1);
    if (groupCapacity < 1 || groupCapacity > 100000) {
      throw new BadRequestException("Некорректная вместимость услуги");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO service_catalog_item(
             tenant_id, name, code, category, duration_minutes,
             buffer_before_minutes, buffer_after_minutes,
             price_minor, currency, delivery_format, group_capacity
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
            input.currency?.trim().toUpperCase() || "RUB",
            deliveryFormat,
            groupCapacity
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

  async deliveryRules(
    context: TenantContext,
    serviceId?: string
  ): Promise<Array<Record<string, unknown>>> {
    await this.requireServiceAll(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           r.id,r.service_id,s.name AS service_name,
           r.employee_resource_id,e.name AS employee_name,
           r.branch_id,b.name AS branch_name,r.delivery_format,
           r.price_minor::text,r.price_max_minor::text,
           r.duration_minutes,r.capacity_units,r.technology_card_id,
           tc.name AS technology_card_name,r.weekdays,
           r.start_minute,r.end_minute,r.priority,
           r.valid_from,r.valid_to,r.status,r.metadata
         FROM service_delivery_rule r
         JOIN service_catalog_item s
           ON s.tenant_id=r.tenant_id AND s.id=r.service_id
         LEFT JOIN service_resource e
           ON e.tenant_id=r.tenant_id AND e.id=r.employee_resource_id
         LEFT JOIN branch b
           ON b.tenant_id=r.tenant_id AND b.id=r.branch_id
         LEFT JOIN service_technology_card tc
           ON tc.tenant_id=r.tenant_id AND tc.id=r.technology_card_id
         WHERE r.tenant_id=$1
           AND r.status='ACTIVE'
           AND ($2::uuid IS NULL OR r.service_id=$2)
         ORDER BY s.name,e.name NULLS LAST,r.priority,r.start_minute`,
        [context.tenantId, serviceId ?? null]
      );
      return result.rows;
    });
  }

  async createDeliveryRule(
    context: TenantContext,
    input: {
      serviceId: string;
      employeeResourceId?: string;
      branchId?: string;
      deliveryFormat?: "INDIVIDUAL" | "GROUP" | "SELF_PRACTICE" | "RENTAL";
      priceMinor?: string;
      priceMaxMinor?: string;
      durationMinutes?: number;
      capacityUnits?: number;
      technologyCardId?: string;
      weekdays?: number[];
      startMinute?: number;
      endMinute?: number;
      priority?: number;
      validFrom?: string;
      validTo?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ id: string }> {
    await this.requireServiceAll(context, "service.write");

    const format = input.deliveryFormat ?? "INDIVIDUAL";
    if (!["INDIVIDUAL","GROUP","SELF_PRACTICE","RENTAL"].includes(format)) {
      throw new BadRequestException("Некорректный формат оказания услуги");
    }
    for (const value of [input.priceMinor,input.priceMaxMinor]) {
      if (value !== undefined && !/^\d+$/.test(value)) {
        throw new BadRequestException("Некорректная цена");
      }
    }
    if (
      input.priceMinor !== undefined &&
      input.priceMaxMinor !== undefined &&
      BigInt(input.priceMaxMinor) < BigInt(input.priceMinor)
    ) {
      throw new BadRequestException("Максимальная цена меньше минимальной");
    }

    const duration =
      input.durationMinutes === undefined ? null : Math.floor(input.durationMinutes);
    if (duration !== null && (duration < 5 || duration > 1440)) {
      throw new BadRequestException("Некорректная длительность");
    }
    const capacity = Math.floor(input.capacityUnits ?? 1);
    if (capacity < 1 || capacity > 100000) {
      throw new BadRequestException("Некорректная доля ресурса");
    }
    const weekdays = Array.from(new Set(input.weekdays ?? [1,2,3,4,5,6,7]))
      .map(Number)
      .sort((a,b)=>a-b);
    if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new BadRequestException("Некорректные дни недели");
    }
    const startMinute = Math.floor(input.startMinute ?? 0);
    const endMinute = Math.floor(input.endMinute ?? 1440);
    if (startMinute < 0 || startMinute > 1439 || endMinute < 1 ||
        endMinute > 1440 || endMinute <= startMinute) {
      throw new BadRequestException("Некорректный временной интервал");
    }
    const priority = Math.floor(input.priority ?? 100);
    if (priority < 1 || priority > 100000) {
      throw new BadRequestException("Некорректный приоритет");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const service = await client.query(
        "SELECT 1 FROM service_catalog_item WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,input.serviceId]
      );
      if (!service.rowCount) throw new NotFoundException("Услуга не найдена");

      if (input.employeeResourceId) {
        const employee = await client.query(
          `SELECT 1 FROM service_resource
           WHERE tenant_id=$1 AND id=$2 AND type='EMPLOYEE' AND status='ACTIVE'`,
          [context.tenantId,input.employeeResourceId]
        );
        if (!employee.rowCount) throw new NotFoundException("Сотрудник не найден");
      }
      if (input.technologyCardId) {
        const card = await client.query(
          `SELECT 1 FROM service_technology_card
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.technologyCardId]
        );
        if (!card.rowCount) throw new NotFoundException("Технологическая карта не найдена");
      }

      try {
        const result = await client.query<{id:string}>(
          `INSERT INTO service_delivery_rule(
             tenant_id,service_id,employee_resource_id,branch_id,delivery_format,
             price_minor,price_max_minor,duration_minutes,capacity_units,
             technology_card_id,weekdays,start_minute,end_minute,priority,
             valid_from,valid_to,metadata
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::smallint[],$12,$13,$14,
             coalesce($15::date,current_date),$16::date,$17
           )
           RETURNING id`,
          [
            context.tenantId,input.serviceId,input.employeeResourceId ?? null,
            input.branchId ?? null,format,input.priceMinor ?? null,
            input.priceMaxMinor ?? null,duration,capacity,
            input.technologyCardId ?? null,weekdays,startMinute,endMinute,
            priority,input.validFrom ?? null,input.validTo ?? null,
            JSON.stringify(input.metadata ?? {})
          ]
        );
        return result.rows[0]!;
      } catch (error) {
        const message=error instanceof Error?error.message:String(error);
        if (message.includes("SERVICE_DELIVERY_RULE_AMBIGUOUS")) {
          throw new ConflictException(
            "Для этой услуги уже есть пересекающееся правило с тем же приоритетом"
          );
        }
        throw error;
      }
    });
  }

  async archiveDeliveryRule(
    context:TenantContext,
    ruleId:string
  ):Promise<{id:string;status:string;changed:boolean}>{
    await this.requireServiceAll(context,"service.write");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{status:string}>(
        `SELECT status
         FROM service_delivery_rule
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,ruleId]
      );
      const row=result.rows[0];
      if(!row) throw new NotFoundException("Правило оказания услуги не найдено");
      if(row.status==="ARCHIVED"){
        return {id:ruleId,status:"ARCHIVED",changed:false};
      }
      await client.query(
        `UPDATE service_delivery_rule
         SET status='ARCHIVED',updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,ruleId]
      );
      return {id:ruleId,status:"ARCHIVED",changed:true};
    });
  }

  async technologyCards(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    await this.requireServiceAll(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           c.id,c.name,c.code,c.description,c.status,c.metadata,
           coalesce(json_agg(json_build_object(
             'id',l.id,
             'warehouseId',l.warehouse_id,
             'warehouseName',w.name,
             'skuId',l.sku_id,
             'sku',sku.code,
             'productName',p.name,
             'quantityMilli',l.quantity_milli::text,
             'wasteBps',l.waste_bps
           ) ORDER BY l.created_at) FILTER (WHERE l.id IS NOT NULL),'[]'::json) AS lines
         FROM service_technology_card c
         LEFT JOIN service_technology_card_line l
           ON l.tenant_id=c.tenant_id AND l.card_id=c.id
         LEFT JOIN warehouse w
           ON w.tenant_id=l.tenant_id AND w.id=l.warehouse_id
         LEFT JOIN sku
           ON sku.tenant_id=l.tenant_id AND sku.id=l.sku_id
         LEFT JOIN product_variant v
           ON v.tenant_id=sku.tenant_id AND v.id=sku.variant_id
         LEFT JOIN product p
           ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE c.tenant_id=$1 AND c.status='ACTIVE'
         GROUP BY c.id
         ORDER BY c.name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createTechnologyCard(
    context: TenantContext,
    input: {
      name: string;
      code?: string;
      description?: string;
      lines: Array<{
        warehouseId: string;
        skuId: string;
        quantityMilli: string;
        wasteBps?: number;
        metadata?: Record<string, unknown>;
      }>;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ id: string }> {
    await this.requireServiceAll(context, "service.write");
    const name=input.name?.trim();
    if (!name || name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название технологической карты");
    }
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 200) {
      throw new BadRequestException("Добавьте от 1 до 200 расходников");
    }
    for (const line of input.lines) {
      if (!/^\d+$/.test(line.quantityMilli) || BigInt(line.quantityMilli) <= 0n) {
        throw new BadRequestException("Некорректная норма расхода");
      }
      const waste=Math.floor(line.wasteBps ?? 0);
      if (waste < 0 || waste > 10000) {
        throw new BadRequestException("Некорректный процент технологических потерь");
      }
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const card=await client.query<{id:string}>(
        `INSERT INTO service_technology_card(
           tenant_id,name,code,description,metadata
         ) VALUES($1,$2,$3,$4,$5)
         RETURNING id`,
        [
          context.tenantId,name,input.code?.trim() || null,
          input.description?.trim() || null,JSON.stringify(input.metadata ?? {})
        ]
      );
      const id=card.rows[0]?.id;
      if (!id) throw new Error("SERVICE_TECH_CARD_CREATE_FAILED");

      for (const line of input.lines) {
        const refs=await client.query(
          `SELECT
             EXISTS(SELECT 1 FROM warehouse w
               WHERE w.tenant_id=$1 AND w.id=$2 AND w.status='ACTIVE') AS warehouse_ok,
             EXISTS(SELECT 1 FROM sku s
               WHERE s.tenant_id=$1 AND s.id=$3 AND s.status='ACTIVE') AS sku_ok`,
          [context.tenantId,line.warehouseId,line.skuId]
        );
        if (!refs.rows[0]?.warehouse_ok) throw new NotFoundException("Склад не найден");
        if (!refs.rows[0]?.sku_ok) throw new NotFoundException("Расходник не найден");

        await client.query(
          `INSERT INTO service_technology_card_line(
             tenant_id,card_id,warehouse_id,sku_id,quantity_milli,waste_bps,metadata
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            context.tenantId,id,line.warehouseId,line.skuId,line.quantityMilli,
            Math.floor(line.wasteBps ?? 0),JSON.stringify(line.metadata ?? {})
          ]
        );
      }
      return {id};
    });
  }

  async archiveTechnologyCard(
    context:TenantContext,
    cardId:string
  ):Promise<{id:string;status:string;changed:boolean}>{
    await this.requireServiceAll(context,"service.write");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{status:string}>(
        `SELECT status
         FROM service_technology_card
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,cardId]
      );
      const row=result.rows[0];
      if(!row) throw new NotFoundException("Технологическая карта не найдена");
      if(row.status==="ARCHIVED"){
        return {id:cardId,status:"ARCHIVED",changed:false};
      }

      const activeRule=await client.query(
        `SELECT 1
         FROM service_delivery_rule
         WHERE tenant_id=$1
           AND technology_card_id=$2
           AND status='ACTIVE'
         LIMIT 1`,
        [context.tenantId,cardId]
      );
      if(activeRule.rowCount){
        throw new ConflictException(
          "Сначала отключите активные правила услуг, использующие эту техкарту"
        );
      }

      await client.query(
        `UPDATE service_technology_card
         SET status='ARCHIVED',updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,cardId]
      );
      return {id:cardId,status:"ARCHIVED",changed:true};
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
    await this.requireServiceAll(context, "service.write");
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
    const scopedMembershipIds = await this.serviceScope(context, "service.read");

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
           AND (
             $4::uuid[] IS NULL
             OR r.membership_id IS NULL
             OR r.membership_id = ANY($4::uuid[])
           )
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
          input.serviceId,
          scopedMembershipIds
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

  async packagePlans(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           p.id,p.name,p.code,p.description,p.applicable_service_id,
           s.name AS applicable_service_name,
           p.package_kind,p.dance_program_id,p.dance_group_id,
           p.visit_limit,p.duration_days,p.price_minor::text,p.currency,
           p.management_visit_value_minor::text,
           p.freeze_days_allowed,p.makeup_days_valid,p.allow_makeup,
           p.family_eligible,p.activation_policy,p.allowed_debt_minor::text,
           p.grace_period_days,
           coalesce((
             SELECT json_agg(json_build_object(
               'id',e.id,
               'serviceId',e.service_id,
               'trainerResourceId',e.trainer_resource_id,
               'lessonType',e.lesson_type,
               'danceProgramId',e.dance_program_id,
               'danceGroupId',e.dance_group_id,
               'weekdays',e.weekdays,
               'startMinute',e.start_minute,
               'endMinute',e.end_minute,
               'visitLimit',e.visit_limit,
               'managementVisitValueMinor',e.management_visit_value_minor::text,
               'priority',e.priority
             ) ORDER BY e.priority,e.id)
             FROM service_package_plan_entitlement e
             WHERE e.tenant_id=p.tenant_id AND e.plan_id=p.id
           ),'[]'::json) AS entitlements,
           p.no_show_policy,p.status,p.metadata,p.created_at,p.updated_at
         FROM service_package_plan p
         LEFT JOIN service_catalog_item s
           ON s.tenant_id=p.tenant_id AND s.id=p.applicable_service_id
         WHERE p.tenant_id=$1 AND p.status='ACTIVE'
         ORDER BY p.name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createPackagePlan(
    context: TenantContext,
    input: {
      name: string;
      code?: string;
      description?: string;
      applicableServiceId?: string;
      packageKind?: "VISITS" | "PERIOD" | "UNLIMITED" | "FAMILY" | "INDIVIDUAL" | "COMBO" | "TRIAL" | "GIFT";
      danceProgramId?: string;
      danceGroupId?: string;
      visitLimit?: number;
      durationDays: number;
      priceMinor?: string | number;
      managementVisitValueMinor?: string | number;
      freezeDaysAllowed?: number;
      makeupDaysValid?: number;
      allowMakeup?: boolean;
      familyEligible?: boolean;
      activationPolicy?: "FULL_PAYMENT" | "IMMEDIATE" | "PROPORTIONAL" | "GRACE_PERIOD";
      allowedDebtMinor?: string | number;
      gracePeriodDays?: number;
      entitlements?: Array<{
        serviceId?: string;
        trainerResourceId?: string;
        lessonType?: "GROUP" | "INDIVIDUAL" | "TRIAL" | "MASTER_CLASS" | "OPEN_CLASS" | "REHEARSAL" | "RENTAL_EVENT" | "SELF_PRACTICE";
        danceProgramId?: string;
        danceGroupId?: string;
        weekdays?: number[];
        startMinute?: number;
        endMinute?: number;
        visitLimit?: number | null;
        managementVisitValueMinor?: string | number;
        priority?: number;
      }>;
      currency?: string;
      noShowPolicy?: "RELEASE" | "CONSUME";
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ id: string }> {
    await this.requireServiceAll(context, "service.write");
    const name = input.name?.trim();
    if (!name || name.length > 180) {
      throw new BadRequestException("Некорректное название абонемента");
    }
    const packageKind = input.packageKind ?? "VISITS";
    if (![
      "VISITS","PERIOD","UNLIMITED","FAMILY","INDIVIDUAL","COMBO","TRIAL","GIFT"
    ].includes(packageKind)) {
      throw new BadRequestException("Некорректный тип абонемента");
    }
    const visitLimit =
      packageKind === "UNLIMITED" ? null : Number(input.visitLimit);
    const durationDays = Number(input.durationDays);
    if (
      packageKind !== "UNLIMITED" &&
      (!Number.isSafeInteger(visitLimit) ||
        Number(visitLimit) < 1 ||
        Number(visitLimit) > 10000)
    ) {
      throw new BadRequestException("Количество посещений должно быть от 1 до 10000");
    }
    if (
      !Number.isSafeInteger(durationDays) ||
      durationDays < 1 ||
      durationDays > 3650
    ) {
      throw new BadRequestException("Срок действия должен быть от 1 до 3650 дней");
    }
    const priceMinor = String(input.priceMinor ?? "0");
    if (!/^\d+$/.test(priceMinor)) {
      throw new BadRequestException("Некорректная цена абонемента");
    }
    const managementVisitValueMinor = String(
      input.managementVisitValueMinor ?? "0"
    );
    const allowedDebtMinor = String(input.allowedDebtMinor ?? "0");
    if (!/^\d+$/.test(managementVisitValueMinor) ||
        !/^\d+$/.test(allowedDebtMinor)) {
      throw new BadRequestException("Некорректные финансовые параметры абонемента");
    }
    const freezeDaysAllowed = Math.floor(input.freezeDaysAllowed ?? 0);
    const makeupDaysValid = Math.floor(input.makeupDaysValid ?? 0);
    if (
      freezeDaysAllowed < 0 || freezeDaysAllowed > 3650 ||
      makeupDaysValid < 0 || makeupDaysValid > 3650
    ) {
      throw new BadRequestException("Некорректные правила заморозки/отработки");
    }
    const gracePeriodDays = Math.floor(input.gracePeriodDays ?? 0);
    if (gracePeriodDays < 0 || gracePeriodDays > 3650) {
      throw new BadRequestException("Некорректный grace period");
    }
    if ((input.entitlements?.length ?? 0) > 30) {
      throw new BadRequestException("Слишком много правил доступа в абонементе");
    }
    const normalizedEntitlements = (input.entitlements ?? []).map(
      (entitlement, index) => {
        const visitLimit =
          entitlement.visitLimit === null || entitlement.visitLimit === undefined
            ? null
            : Math.floor(entitlement.visitLimit);
        if (visitLimit !== null && (visitLimit < 1 || visitLimit > 10000)) {
          throw new BadRequestException("Некорректная квота абонемента");
        }
        const visitValue = String(entitlement.managementVisitValueMinor ?? "0");
        if (!/^\d+$/.test(visitValue)) {
          throw new BadRequestException("Некорректная стоимость посещения квоты");
        }
        const priority = Math.floor(entitlement.priority ?? (100 + index));
        if (priority < 1 || priority > 100000) {
          throw new BadRequestException("Некорректный приоритет квоты");
        }
        const weekdays=Array.from(
          new Set(entitlement.weekdays ?? [1,2,3,4,5,6,7])
        ).map(Number).sort((a,b)=>a-b);
        if(
          !weekdays.length ||
          weekdays.some(day=>!Number.isInteger(day)||day<1||day>7)
        ){
          throw new BadRequestException("Некорректные дни недели квоты");
        }
        const startMinute=Math.floor(entitlement.startMinute ?? 0);
        const endMinute=Math.floor(entitlement.endMinute ?? 1440);
        if(
          startMinute<0||startMinute>1439||
          endMinute<1||endMinute>1440||endMinute<=startMinute
        ){
          throw new BadRequestException("Некорректное время действия квоты");
        }
        return {
          serviceId: entitlement.serviceId ?? null,
          trainerResourceId: entitlement.trainerResourceId ?? null,
          lessonType: entitlement.lessonType ?? null,
          danceProgramId: entitlement.danceProgramId ?? null,
          danceGroupId: entitlement.danceGroupId ?? null,
          weekdays,
          startMinute,
          endMinute,
          visitLimit,
          managementVisitValueMinor: visitValue,
          priority
        };
      }
    );

    const entitlementKeys=new Set<string>();
    for(const entitlement of normalizedEntitlements){
      const key=[
        entitlement.serviceId??"*",
        entitlement.trainerResourceId??"*",
        entitlement.lessonType??"*",
        entitlement.danceProgramId??"*",
        entitlement.danceGroupId??"*",
        entitlement.weekdays.join(","),
        entitlement.startMinute,
        entitlement.endMinute,
        entitlement.priority
      ].join("|");
      if(entitlementKeys.has(key)){
        throw new BadRequestException(
          "В тарифе дублируется квота с тем же типом занятия, направлением, группой и приоритетом"
        );
      }
      entitlementKeys.add(key);
    }

    const activationPolicy = input.activationPolicy ?? "FULL_PAYMENT";
    if (!["FULL_PAYMENT","IMMEDIATE","PROPORTIONAL","GRACE_PERIOD"].includes(
      activationPolicy
    )) {
      throw new BadRequestException("Некорректная политика активации");
    }

    const currency = input.currency?.trim().toUpperCase() || "RUB";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Некорректная валюта");
    }
    const noShowPolicy = input.noShowPolicy ?? "RELEASE";
    if (!["RELEASE","CONSUME"].includes(noShowPolicy)) {
      throw new BadRequestException("Некорректная политика no-show");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.applicableServiceId) {
        await this.assertService(
          client,
          context.tenantId,
          input.applicableServiceId
        );
      }
      if (input.danceProgramId) {
        const program = await client.query(
          `SELECT 1 FROM dance_program
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.danceProgramId]
        );
        if (!program.rowCount) {
          throw new NotFoundException("Направление студии не найдено");
        }
      }
      if (input.danceGroupId) {
        const group = await client.query(
          `SELECT program_id FROM dance_group
           WHERE tenant_id=$1 AND id=$2 AND status<>'ARCHIVED'`,
          [context.tenantId,input.danceGroupId]
        );
        const groupRow=group.rows[0];
        if (!groupRow) throw new NotFoundException("Группа студии не найдена");
        if (
          input.danceProgramId &&
          groupRow.program_id !== input.danceProgramId
        ) {
          throw new ConflictException(
            "Группа относится к другому направлению"
          );
        }
      }

      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO service_package_plan(
             tenant_id,name,code,description,applicable_service_id,
             package_kind,dance_program_id,dance_group_id,
             visit_limit,duration_days,price_minor,management_visit_value_minor,
             freeze_days_allowed,makeup_days_valid,allow_makeup,family_eligible,
             activation_policy,allowed_debt_minor,grace_period_days,
             currency,no_show_policy,metadata
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22
           )
           RETURNING id`,
          [
            context.tenantId,
            name,
            input.code?.trim() || null,
            input.description?.trim() || null,
            input.applicableServiceId ?? null,
            packageKind,
            input.danceProgramId ?? null,
            input.danceGroupId ?? null,
            visitLimit,
            durationDays,
            priceMinor,
            managementVisitValueMinor,
            freezeDaysAllowed,
            makeupDaysValid,
            Boolean(input.allowMakeup),
            Boolean(input.familyEligible),
            activationPolicy,
            allowedDebtMinor,
            gracePeriodDays,
            currency,
            noShowPolicy,
            JSON.stringify(input.metadata ?? {})
          ]
        );
        const row = result.rows[0];
        if (!row) throw new Error("SERVICE_PACKAGE_PLAN_CREATE_FAILED");

        for (const entitlement of normalizedEntitlements) {
          if (entitlement.serviceId) {
            await this.assertService(
              client,context.tenantId,entitlement.serviceId
            );
          }
          if (entitlement.trainerResourceId) {
            const trainer=await client.query(
              `SELECT 1 FROM service_resource
               WHERE tenant_id=$1 AND id=$2
                 AND type='EMPLOYEE' AND status='ACTIVE'`,
              [context.tenantId,entitlement.trainerResourceId]
            );
            if(!trainer.rowCount){
              throw new NotFoundException("Тренер квоты не найден");
            }
          }
          if (entitlement.danceProgramId) {
            const program = await client.query(
              "SELECT 1 FROM dance_program WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
              [context.tenantId,entitlement.danceProgramId]
            );
            if (!program.rowCount) {
              throw new NotFoundException("Направление квоты не найдено");
            }
          }
          if (entitlement.danceGroupId) {
            const group = await client.query<{program_id:string}>(
              "SELECT program_id FROM dance_group WHERE tenant_id=$1 AND id=$2 AND status<>'ARCHIVED'",
              [context.tenantId,entitlement.danceGroupId]
            );
            const groupRow=group.rows[0];
            if (!groupRow) {
              throw new NotFoundException("Группа квоты не найдена");
            }
            if (
              entitlement.danceProgramId &&
              groupRow.program_id!==entitlement.danceProgramId
            ) {
              throw new ConflictException(
                "Группа квоты относится к другому направлению"
              );
            }
          }
          await client.query(
            `INSERT INTO service_package_plan_entitlement(
               tenant_id,plan_id,service_id,trainer_resource_id,
               lesson_type,dance_program_id,dance_group_id,
               weekdays,start_minute,end_minute,
               visit_limit,management_visit_value_minor,priority
             ) VALUES(
               $1,$2,$3,$4,$5,$6,$7,$8::smallint[],$9,$10,$11,$12,$13
             )`,
            [
              context.tenantId,row.id,entitlement.serviceId,
              entitlement.trainerResourceId,entitlement.lessonType,
              entitlement.danceProgramId,entitlement.danceGroupId,
              entitlement.weekdays,entitlement.startMinute,entitlement.endMinute,
              entitlement.visitLimit,entitlement.managementVisitValueMinor,
              entitlement.priority
            ]
          );
        }

        return row;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException("Абонемент с таким кодом уже существует");
        }
        throw error;
      }
    });
  }

  async packages(
    context: TenantContext,
    partyId?: string
  ): Promise<Array<Record<string, unknown>>> {
    const scopedMembershipIds = await this.serviceScope(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `UPDATE service_package
         SET status='EXPIRED',updated_at=now()
         WHERE tenant_id=$1
           AND status IN ('ACTIVE','PENDING_PAYMENT')
           AND expires_at<=now()`,
        [context.tenantId]
      );

      const result = await client.query(
        `SELECT
           sp.id,sp.party_id,sp.plan_id,sp.sales_order_id,
           sp.starts_at,sp.expires_at,sp.visit_limit_snapshot,
           sp.reserved_visits,sp.used_visits,
           CASE
             WHEN sp.visit_limit_snapshot IS NULL THEN NULL
             ELSE sp.visit_limit_snapshot-sp.reserved_visits-sp.used_visits
           END AS available_visits,
           sp.price_minor_snapshot::text,sp.currency,sp.status,
           sp.package_kind_snapshot,sp.dance_program_id_snapshot,
           sp.dance_group_id_snapshot,sp.payer_party_id,
           p.display_name AS party_name,plan.name AS plan_name,
           plan.no_show_policy,plan.applicable_service_id,
           coalesce(
             (
               SELECT array_agg(b.party_id ORDER BY b.party_id)
               FROM service_package_beneficiary b
               WHERE b.tenant_id=sp.tenant_id
                 AND b.package_id=sp.id
                 AND b.status='ACTIVE'
             ),
             ARRAY[]::uuid[]
           ) AS beneficiary_party_ids
         FROM service_package sp
         JOIN service_package_plan plan
           ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
         JOIN party p
           ON p.tenant_id=sp.tenant_id AND p.id=sp.party_id
         WHERE sp.tenant_id=$1
           AND (
             $2::uuid IS NULL
             OR sp.party_id=$2
             OR EXISTS (
               SELECT 1
               FROM service_package_beneficiary fb
               WHERE fb.tenant_id=sp.tenant_id
                 AND fb.package_id=sp.id
                 AND fb.party_id=$2
                 AND fb.status='ACTIVE'
             )
           )
           AND (
             $3::uuid[] IS NULL
             OR p.responsible_membership_id = ANY($3::uuid[])
             OR EXISTS (
               SELECT 1
               FROM service_package_beneficiary sb
               JOIN party bp
                 ON bp.tenant_id=sb.tenant_id AND bp.id=sb.party_id
               WHERE sb.tenant_id=sp.tenant_id
                 AND sb.package_id=sp.id
                 AND sb.status='ACTIVE'
                 AND bp.responsible_membership_id = ANY($3::uuid[])
             )
             OR EXISTS (
               SELECT 1
               FROM service_booking b
               JOIN service_booking_resource br
                 ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
               JOIN service_resource r
                 ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
               WHERE b.tenant_id=sp.tenant_id
                 AND b.party_id=sp.party_id
                 AND r.membership_id = ANY($3::uuid[])
             )
           )
         ORDER BY
           CASE sp.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
           sp.expires_at,sp.created_at DESC
         LIMIT 1000`,
        [context.tenantId, partyId ?? null, scopedMembershipIds]
      );
      return result.rows;
    });
  }

  async issuePackage(
    context: TenantContext,
    input: {
      planId: string;
      partyId: string;
      startsAt?: string;
      salesOrderId?: string;
      payerPartyId?: string;
    }
  ): Promise<{ id: string; expiresAt: string }> {
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException("Некорректная дата начала абонемента");
    }
    const scopedMembershipIds = await this.serviceScope(context, "service.write");

    return this.database.withTenantTransaction(context, async (client) => {
      const plan = await client.query<{
        id: string;
        visit_limit: number | null;
        duration_days: number;
        package_kind: string;
        dance_program_id: string | null;
        dance_group_id: string | null;
        freeze_days_allowed: number;
        activation_policy: "FULL_PAYMENT" | "IMMEDIATE" | "PROPORTIONAL" | "GRACE_PERIOD";
        allowed_debt_minor: string;
        grace_period_days: number;
        family_eligible: boolean;
        price_minor: string;
      currency: string;
      delivery_format: "INDIVIDUAL" | "GROUP" | "SELF_PRACTICE" | "RENTAL";
      group_capacity: number;
    }>(
        `SELECT
           id,visit_limit,duration_days,price_minor::text,currency,
           package_kind,dance_program_id,dance_group_id,freeze_days_allowed,
           activation_policy,allowed_debt_minor::text,grace_period_days,
           family_eligible
         FROM service_package_plan
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, input.planId]
      );
      const planRow = plan.rows[0];
      if (!planRow) throw new NotFoundException("Тариф абонемента не найден");

      const party = await client.query(
        `SELECT 1 FROM party
         WHERE tenant_id=$1
           AND id=$2
           AND status='ACTIVE'
           AND (
             $3::uuid[] IS NULL
             OR responsible_membership_id = ANY($3::uuid[])
           )`,
        [context.tenantId, input.partyId, scopedMembershipIds]
      );
      if (!party.rowCount) throw new NotFoundException("Клиент не найден");

      if (input.payerPartyId) {
        const payer = await client.query(
          `SELECT 1 FROM party
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.payerPartyId]
        );
        if (!payer.rowCount) throw new NotFoundException("Плательщик не найден");
      }

      let salesOrderSettled=false;
      if (input.salesOrderId) {
        const order = await client.query(
          `SELECT 1 FROM sales_order
           WHERE tenant_id=$1 AND id=$2
             AND party_id=$3
             AND order_status NOT IN ('CANCELLED')`,
          [context.tenantId, input.salesOrderId, input.partyId]
        );
        if (!order.rowCount) {
          throw new NotFoundException(
            "Заказ продажи клиента не найден или отменён"
          );
        }
        const receivable=await client.query<{status:string}>(
          `SELECT status
           FROM financial_obligation
           WHERE tenant_id=$1
             AND direction='RECEIVABLE'
             AND source_type='SALES_ORDER'
             AND source_id=$2
           LIMIT 1`,
          [context.tenantId,input.salesOrderId]
        );
        salesOrderSettled=receivable.rows[0]?.status==="SETTLED";
      }

      const danceStudent = await client.query<{ id: string }>(
        `SELECT id FROM dance_student
         WHERE tenant_id=$1 AND party_id=$2 AND status<>'ARCHIVED'`,
        [context.tenantId,input.partyId]
      );
      const danceStudentId=danceStudent.rows[0]?.id??null;

      if (
        danceStudentId &&
        input.payerPartyId &&
        input.payerPartyId !== input.partyId
      ) {
        const relation=await client.query(
          `SELECT 1 FROM party_relationship
           WHERE tenant_id=$1 AND from_party_id=$2 AND to_party_id=$3
             AND relation_type IN ('PAYER','PARENT','GUARDIAN')
             AND (ends_on IS NULL OR ends_on>=current_date)`,
          [context.tenantId,input.partyId,input.payerPartyId]
        );
        if(!relation.rowCount) {
          throw new ConflictException("Плательщик не связан с учеником");
        }
      }

      const requiresFullPayment =
        Boolean(danceStudentId) &&
        BigInt(planRow.price_minor)>0n &&
        planRow.activation_policy==="FULL_PAYMENT";
      const initialStatus =
        requiresFullPayment &&
        (
          !input.salesOrderId ||
          !salesOrderSettled
        )
          ? "PENDING_PAYMENT"
          : "ACTIVE";

      const expiresAt = new Date(
        startsAt.getTime() + planRow.duration_days * 86400000
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO service_package(
           tenant_id,plan_id,party_id,payer_party_id,sales_order_id,
           starts_at,expires_at,visit_limit_snapshot,
           price_minor_snapshot,currency,package_kind_snapshot,
           dance_program_id_snapshot,dance_group_id_snapshot,
           freeze_days_total_snapshot,activation_policy_snapshot,
           allowed_debt_minor_snapshot,grace_period_days_snapshot,
           status,created_by_membership_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
         )
         RETURNING id`,
        [
          context.tenantId,
          planRow.id,
          input.partyId,
          input.payerPartyId ?? input.partyId,
          input.salesOrderId ?? null,
          startsAt,
          expiresAt,
          planRow.visit_limit,
          planRow.price_minor,
          planRow.currency,
          planRow.package_kind,
          planRow.dance_program_id,
          planRow.dance_group_id,
          planRow.freeze_days_allowed,
          planRow.activation_policy,
          planRow.allowed_debt_minor,
          planRow.grace_period_days,
          initialStatus,
          context.membershipId
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("SERVICE_PACKAGE_ISSUE_FAILED");

      await client.query(
        `INSERT INTO service_package_beneficiary(
           tenant_id,package_id,party_id,status,created_by_membership_id
         ) VALUES($1,$2,$3,'ACTIVE',$4)
         ON CONFLICT(tenant_id,package_id,party_id)
         DO UPDATE SET status='ACTIVE',updated_at=now()`,
        [context.tenantId,row.id,input.partyId,context.membershipId]
      );

      await client.query(
        `INSERT INTO service_package_entitlement(
           tenant_id,package_id,source_plan_entitlement_id,
           service_id,trainer_resource_id,
           lesson_type,dance_program_id,dance_group_id,
           weekdays,start_minute,end_minute,
           visit_limit_snapshot,management_visit_value_minor_snapshot,priority
         )
         SELECT
           tenant_id,$3,id,service_id,trainer_resource_id,
           lesson_type,dance_program_id,dance_group_id,
           weekdays,start_minute,end_minute,
           visit_limit,management_visit_value_minor,priority
         FROM service_package_plan_entitlement
         WHERE tenant_id=$1 AND plan_id=$2
         ORDER BY priority,id`,
        [context.tenantId,planRow.id,row.id]
      );

      if (
        danceStudentId &&
        BigInt(planRow.price_minor) > 0n &&
        !input.salesOrderId
      ) {
        const payerPartyId=input.payerPartyId ?? input.partyId;
        const charge=await client.query<{id:string}>(
          `INSERT INTO dance_student_charge(
             tenant_id,student_id,payer_party_id,source_type,source_id,
             currency,amount_minor,due_at,created_by_membership_id
           ) VALUES(
             $1,$2,$3,'PACKAGE',$4,$5,$6,$7,$8
           )
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            context.tenantId,danceStudentId,payerPartyId,row.id,
            planRow.currency,planRow.price_minor,
            new Date(
              startsAt.getTime()+planRow.grace_period_days*86400000
            ),
            context.membershipId
          ]
        );
        let chargeId=charge.rows[0]?.id;
        if(!chargeId){
          const existingCharge=await client.query<{id:string}>(
            `SELECT id FROM dance_student_charge
             WHERE tenant_id=$1 AND student_id=$2
               AND source_type='PACKAGE' AND source_id=$3
               AND status<>'CANCELLED'`,
            [context.tenantId,danceStudentId,row.id]
          );
          chargeId=existingCharge.rows[0]?.id;
        }
        if(!chargeId) throw new Error("DANCE_PACKAGE_CHARGE_CREATE_FAILED");

        const obligation=await client.query<{id:string}>(
          `INSERT INTO financial_obligation(
             tenant_id,direction,party_id,source_type,source_id,
             currency,amount_minor,due_at
           ) VALUES(
             $1,'RECEIVABLE',$2,'DANCE_STUDENT_CHARGE',$3,$4,$5,$6
           )
           RETURNING id`,
          [
            context.tenantId,payerPartyId,chargeId,planRow.currency,
            planRow.price_minor,
            new Date(startsAt.getTime()+planRow.grace_period_days*86400000)
          ]
        );
        const obligationId=obligation.rows[0]?.id;
        if(!obligationId) throw new Error("DANCE_PACKAGE_OBLIGATION_CREATE_FAILED");

        const invoiceNumber=await this.nextNumber(
          client,context.tenantId,"finance_invoice","INV"
        );
        const invoice=await client.query<{id:string}>(
          `INSERT INTO finance_invoice(
             tenant_id,business_number,party_id,source_type,source_id,
             obligation_id,currency,amount_minor,due_at,
             created_by_membership_id
           ) VALUES(
             $1,$2,$3,'DANCE_STUDENT_CHARGE',$4,$5,$6,$7,$8,$9
           )
           RETURNING id`,
          [
            context.tenantId,invoiceNumber,payerPartyId,chargeId,
            obligationId,planRow.currency,planRow.price_minor,
            new Date(startsAt.getTime()+planRow.grace_period_days*86400000),
            context.membershipId
          ]
        );
        const invoiceId=invoice.rows[0]?.id;
        if(!invoiceId) throw new Error("DANCE_PACKAGE_INVOICE_CREATE_FAILED");
        await client.query(
          `UPDATE dance_student_charge
           SET obligation_id=$3,invoice_id=$4,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,chargeId,obligationId,invoiceId]
        );
      }

      await client.query(
        `INSERT INTO audit_event(
           tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data
         ) VALUES ($1,$2,$3,'service.package_issued','service_package',$4,$5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          row.id,
          JSON.stringify({
            planId: planRow.id,
            partyId: input.partyId,
            visitLimit: planRow.visit_limit,
            expiresAt: expiresAt.toISOString()
          })
        ]
      );

      return { id: row.id, expiresAt: expiresAt.toISOString() };
    });
  }

  async assets(
    context: TenantContext,
    partyId?: string
  ): Promise<Array<Record<string, unknown>>> {
    const scopedMembershipIds = await this.serviceScope(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           a.id,a.party_id,a.asset_type,a.display_name,a.external_key,
           a.registration_number,a.manufacturer,a.model,a.production_year,
           a.usage_value::text,a.usage_unit,a.status,a.metadata,
           a.created_at,a.updated_at,
           p.display_name AS party_name,
           (
             SELECT max(b.starts_at)
             FROM service_booking b
             WHERE b.tenant_id=a.tenant_id
               AND b.asset_id=a.id
               AND b.status='COMPLETED'
           ) AS last_service_at
         FROM service_asset a
         LEFT JOIN party p
           ON p.tenant_id=a.tenant_id AND p.id=a.party_id
         WHERE a.tenant_id=$1
           AND a.status='ACTIVE'
           AND ($2::uuid IS NULL OR a.party_id=$2)
           AND (
             $3::uuid[] IS NULL
             OR p.responsible_membership_id = ANY($3::uuid[])
             OR EXISTS (
               SELECT 1
               FROM service_booking b
               JOIN service_booking_resource br
                 ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
               JOIN service_resource r
                 ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
               WHERE b.tenant_id=a.tenant_id
                 AND b.asset_id=a.id
                 AND r.membership_id = ANY($3::uuid[])
             )
           )
         ORDER BY a.updated_at DESC,a.display_name
         LIMIT 500`,
        [context.tenantId, partyId ?? null, scopedMembershipIds]
      );
      return result.rows;
    });
  }

  async createAsset(
    context: TenantContext,
    input: {
      partyId?: string;
      assetType?: "VEHICLE" | "EQUIPMENT" | "DEVICE" | "OTHER";
      displayName: string;
      externalKey?: string;
      registrationNumber?: string;
      manufacturer?: string;
      model?: string;
      productionYear?: number;
      usageValue?: string | number;
      usageUnit?: "KM" | "HOURS" | "CYCLES" | "UNIT";
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ id: string }> {
    const displayName = input.displayName?.trim();
    if (!displayName || displayName.length > 180) {
      throw new BadRequestException("Некорректное название объекта");
    }

    const assetType = input.assetType ?? "OTHER";
    if (!["VEHICLE","EQUIPMENT","DEVICE","OTHER"].includes(assetType)) {
      throw new BadRequestException("Некорректный тип объекта");
    }

    const productionYear = input.productionYear;
    if (
      productionYear !== undefined &&
      (!Number.isInteger(productionYear) ||
        productionYear < 1886 ||
        productionYear > 2200)
    ) {
      throw new BadRequestException("Некорректный год выпуска");
    }

    const usageValue = String(input.usageValue ?? "0");
    if (!/^\d+$/.test(usageValue)) {
      throw new BadRequestException("Пробег/наработка должны быть неотрицательным целым числом");
    }

    const usageUnit = input.usageUnit ?? (assetType === "VEHICLE" ? "KM" : "UNIT");
    if (!["KM","HOURS","CYCLES","UNIT"].includes(usageUnit)) {
      throw new BadRequestException("Некорректная единица наработки");
    }

    const externalKey = this.normalizeAssetIdentifier(input.externalKey);
    const registrationNumber = this.normalizeAssetIdentifier(input.registrationNumber);
    const scopedMembershipIds = await this.serviceScope(context, "service.write");
    if (scopedMembershipIds !== null && !input.partyId) {
      throw new ForbiddenException(
        "Для ограниченной роли объект должен быть привязан к доступному клиенту"
      );
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.partyId) {
        const party = await client.query(
          `SELECT 1 FROM party
           WHERE tenant_id=$1
             AND id=$2
             AND status='ACTIVE'
             AND (
               $3::uuid[] IS NULL
               OR responsible_membership_id = ANY($3::uuid[])
             )`,
          [context.tenantId, input.partyId, scopedMembershipIds]
        );
        if (!party.rowCount) throw new NotFoundException("Клиент не найден");
      }

      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO service_asset(
             tenant_id,party_id,asset_type,display_name,external_key,
             registration_number,manufacturer,model,production_year,
             usage_value,usage_unit,metadata,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id`,
          [
            context.tenantId,
            input.partyId ?? null,
            assetType,
            displayName,
            externalKey,
            registrationNumber,
            input.manufacturer?.trim() || null,
            input.model?.trim() || null,
            productionYear ?? null,
            usageValue,
            usageUnit,
            JSON.stringify(input.metadata ?? {}),
            context.membershipId
          ]
        );

        const row = result.rows[0];
        if (!row) throw new Error("SERVICE_ASSET_CREATE_FAILED");

        await client.query(
          `INSERT INTO audit_event(
             tenant_id,actor_user_id,actor_membership_id,
             action,resource_type,resource_id,after_data
           ) VALUES ($1,$2,$3,'service.asset_created','service_asset',$4,$5)`,
          [
            context.tenantId,
            context.userId,
            context.membershipId,
            row.id,
            JSON.stringify({
              assetType,
              partyId: input.partyId ?? null,
              externalKey,
              registrationNumber
            })
          ]
        );

        return row;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException(
            "Объект с таким VIN/серийным номером уже существует"
          );
        }
        throw error;
      }
    });
  }

  async updateAssetUsage(
    context: TenantContext,
    assetId: string,
    input: { usageValue: string | number; usageUnit?: "KM" | "HOURS" | "CYCLES" | "UNIT" }
  ): Promise<{ usageValue: string; usageUnit: string }> {
    const usageValue = String(input.usageValue);
    if (!/^\d+$/.test(usageValue)) {
      throw new BadRequestException("Пробег/наработка должны быть неотрицательным целым числом");
    }
    const scopedMembershipIds = await this.serviceScope(context, "service.write");

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertAssetAccess(
        client,
        context.tenantId,
        assetId,
        scopedMembershipIds
      );
      const current = await client.query<{
        usage_value: string;
        usage_unit: string;
      }>(
        `SELECT usage_value::text,usage_unit
         FROM service_asset
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
         FOR UPDATE`,
        [context.tenantId, assetId]
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException("Объект обслуживания не найден");

      const usageUnit = input.usageUnit ?? row.usage_unit;
      if (!["KM","HOURS","CYCLES","UNIT"].includes(usageUnit)) {
        throw new BadRequestException("Некорректная единица наработки");
      }
      if (usageUnit !== row.usage_unit && BigInt(row.usage_value) > 0n) {
        throw new BadRequestException(
          "Нельзя менять единицу наработки после начала учёта"
        );
      }
      if (BigInt(usageValue) < BigInt(row.usage_value)) {
        throw new ConflictException(
          "Пробег/наработка не могут уменьшаться. Исправление истории выполняется отдельно."
        );
      }

      await client.query(
        `UPDATE service_asset
         SET usage_value=$3,usage_unit=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, assetId, usageValue, usageUnit]
      );

      await client.query(
        `INSERT INTO audit_event(
           tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,before_data,after_data
         ) VALUES ($1,$2,$3,'service.asset_usage_updated','service_asset',$4,$5,$6)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          assetId,
          JSON.stringify({
            usageValue: row.usage_value,
            usageUnit: row.usage_unit
          }),
          JSON.stringify({ usageValue, usageUnit })
        ]
      );

      return { usageValue, usageUnit };
    });
  }

  async assetHistory(
    context: TenantContext,
    assetId: string
  ): Promise<Record<string, unknown>> {
    const scopedMembershipIds = await this.serviceScope(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertAssetAccess(
        client,
        context.tenantId,
        assetId,
        scopedMembershipIds
      );
      const asset = await client.query(
        `SELECT
           a.id,a.party_id,a.asset_type,a.display_name,a.external_key,
           a.registration_number,a.manufacturer,a.model,a.production_year,
           a.usage_value::text,a.usage_unit,a.status,a.metadata,
           p.display_name AS party_name
         FROM service_asset a
         LEFT JOIN party p
           ON p.tenant_id=a.tenant_id AND p.id=a.party_id
         WHERE a.tenant_id=$1 AND a.id=$2`,
        [context.tenantId, assetId]
      );
      if (!asset.rows[0]) {
        throw new NotFoundException("Объект обслуживания не найден");
      }

      const history = await client.query(
        `SELECT
           b.id,b.business_number,b.status,b.starts_at,b.ends_at,
           b.price_minor_snapshot::text,b.currency,b.notes,
           s.name AS service_name
         FROM service_booking b
         JOIN service_catalog_item s
           ON s.tenant_id=b.tenant_id AND s.id=b.service_id
         WHERE b.tenant_id=$1
           AND b.asset_id=$2
           AND (
             $3::uuid[] IS NULL
             OR EXISTS (
               SELECT 1
               FROM service_booking_resource br
               JOIN service_resource r
                 ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
               WHERE br.tenant_id=b.tenant_id
                 AND br.booking_id=b.id
                 AND r.membership_id = ANY($3::uuid[])
             )
           )
         ORDER BY b.starts_at DESC
         LIMIT 500`,
        [context.tenantId, assetId, scopedMembershipIds]
      );

      return {
        asset: asset.rows[0],
        bookings: history.rows
      };
    });
  }

  async bookings(
    context: TenantContext,
    from?: string,
    to?: string
  ): Promise<Array<Record<string, unknown>>> {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 86400000);
    const toDate = to ? new Date(to) : new Date(Date.now() + 30 * 86400000);
    if (
      Number.isNaN(fromDate.getTime()) ||
      Number.isNaN(toDate.getTime()) ||
      toDate <= fromDate ||
      toDate.getTime() - fromDate.getTime() > 31 * 86400000
    ) {
      throw new BadRequestException("Период календаря должен быть от 1 минуты до 31 дня");
    }

    const scopedMembershipIds = await this.serviceScope(context, "service.read");

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           b.id, b.business_number, b.status, b.source,
           b.starts_at, b.ends_at, b.price_minor_snapshot::text,
           b.currency,b.version,b.notes,b.delivery_format_snapshot,
           p.display_name AS party_name,
           s.name AS service_name,
           charge.status AS billing_status,
           fo.status AS obligation_status,
           fi.status AS invoice_status,
           coalesce(fo.settled_minor,0)::text AS settled_minor,
           CASE WHEN refund.id IS NULL THEN NULL ELSE json_build_object(
             'status',refund.status,
             'amountMinor',refund.amount_minor::text,
             'settledMinor',refund.settled_minor::text
           ) END AS refund,
           CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object(
             'id',a.id,
             'assetType',a.asset_type,
             'displayName',a.display_name,
             'externalKey',a.external_key,
             'registrationNumber',a.registration_number,
             'usageValue',a.usage_value::text,
             'usageUnit',a.usage_unit
           ) END AS asset,
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
         LEFT JOIN service_asset a
           ON a.tenant_id=b.tenant_id AND a.id=b.asset_id
         LEFT JOIN service_booking_charge charge
           ON charge.tenant_id=b.tenant_id AND charge.booking_id=b.id
         LEFT JOIN financial_obligation fo
           ON fo.tenant_id=charge.tenant_id AND fo.id=charge.obligation_id
         LEFT JOIN finance_invoice fi
           ON fi.tenant_id=charge.tenant_id AND fi.id=charge.invoice_id
         LEFT JOIN financial_obligation refund
           ON refund.tenant_id=b.tenant_id
          AND refund.direction='PAYABLE'
          AND refund.source_type='SERVICE_BOOKING_REFUND'
          AND refund.source_id=b.id
         LEFT JOIN service_booking_resource br
           ON br.tenant_id = b.tenant_id AND br.booking_id = b.id
         LEFT JOIN service_resource r
           ON r.tenant_id = br.tenant_id AND r.id = br.resource_id
         LEFT JOIN service_resource_zone rz
           ON rz.tenant_id=br.tenant_id AND rz.id=br.zone_id
         WHERE b.tenant_id = $1
           AND b.starts_at < $3
           AND b.ends_at > $2
           AND (
             $4::uuid[] IS NULL
             OR EXISTS (
               SELECT 1
               FROM service_booking_resource scope_br
               JOIN service_resource scope_r
                 ON scope_r.tenant_id=scope_br.tenant_id
                AND scope_r.id=scope_br.resource_id
               WHERE scope_br.tenant_id=b.tenant_id
                 AND scope_br.booking_id=b.id
                 AND scope_r.membership_id = ANY($4::uuid[])
             )
           )
         GROUP BY
           b.id,p.display_name,s.name,a.id,
           charge.id,fo.id,fi.id,refund.id
         ORDER BY b.starts_at`,
        [context.tenantId, fromDate, toDate, scopedMembershipIds]
      );

      return result.rows;
    });
  }

  async bookingDetails(
    context: TenantContext,
    bookingId: string
  ): Promise<Record<string, unknown>> {
    const scopedMembershipIds = await this.serviceScope(context, "service.read");
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertBookingAccess(
        client,
        context.tenantId,
        bookingId,
        scopedMembershipIds
      );
      const result = await client.query(
        `SELECT
           b.id,b.business_number,b.status,b.source,b.starts_at,b.ends_at,
           b.price_minor_snapshot::text,b.currency,b.version,b.notes,
           b.party_id,b.asset_id,b.delivery_format_snapshot,
           p.display_name AS party_name,s.name AS service_name,
           CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object(
             'id',a.id,'assetType',a.asset_type,'displayName',a.display_name,
             'externalKey',a.external_key,
             'registrationNumber',a.registration_number,
             'manufacturer',a.manufacturer,'model',a.model,
             'productionYear',a.production_year,
             'usageValue',a.usage_value::text,'usageUnit',a.usage_unit
           ) END AS asset,
           CASE WHEN charge.id IS NULL THEN NULL ELSE json_build_object(
             'id',charge.id,
             'status',charge.status,
             'amountMinor',charge.amount_minor::text,
             'dueAt',charge.due_at,
             'obligationId',charge.obligation_id,
             'obligationStatus',fo.status,
             'settledMinor',coalesce(fo.settled_minor,0)::text,
             'invoiceId',charge.invoice_id,
             'invoiceNumber',fi.business_number,
             'invoiceStatus',fi.status
           ) END AS billing,
           CASE WHEN refund.id IS NULL THEN NULL ELSE json_build_object(
             'id',refund.id,
             'status',refund.status,
             'amountMinor',refund.amount_minor::text,
             'settledMinor',refund.settled_minor::text,
             'dueAt',refund.due_at
           ) END AS refund,
           COALESCE(
             json_agg(json_build_object(
               'resourceId',r.id,
               'resourceName',r.name,
               'type',r.type,
               'capacityUnits',br.capacity_units,
               'zoneId',br.zone_id,
               'zoneName',rz.name
             ) ORDER BY r.type,r.name)
             FILTER (WHERE r.id IS NOT NULL),
             '[]'::json
           ) AS resources
         FROM service_booking b
         JOIN service_catalog_item s
           ON s.tenant_id=b.tenant_id AND s.id=b.service_id
         LEFT JOIN party p
           ON p.tenant_id=b.tenant_id AND p.id=b.party_id
         LEFT JOIN service_asset a
           ON a.tenant_id=b.tenant_id AND a.id=b.asset_id
         LEFT JOIN service_booking_charge charge
           ON charge.tenant_id=b.tenant_id AND charge.booking_id=b.id
         LEFT JOIN financial_obligation fo
           ON fo.tenant_id=charge.tenant_id AND fo.id=charge.obligation_id
         LEFT JOIN finance_invoice fi
           ON fi.tenant_id=charge.tenant_id AND fi.id=charge.invoice_id
         LEFT JOIN financial_obligation refund
           ON refund.tenant_id=b.tenant_id
          AND refund.direction='PAYABLE'
          AND refund.source_type='SERVICE_BOOKING_REFUND'
          AND refund.source_id=b.id
         LEFT JOIN service_booking_resource br
           ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
         LEFT JOIN service_resource r
           ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
         LEFT JOIN service_resource_zone rz
           ON rz.tenant_id=br.tenant_id AND rz.id=br.zone_id
         WHERE b.tenant_id=$1 AND b.id=$2
         GROUP BY
           b.id,p.display_name,s.name,a.id,
           charge.id,fo.id,fi.id,refund.id`,
        [context.tenantId, bookingId]
      );
      if (!result.rows[0]) throw new NotFoundException("Запись не найдена");
      return result.rows[0] as Record<string, unknown>;
    });
  }

  async createBooking(
    context: TenantContext,
    input: {
      serviceId: string;
      resourceIds?: string[];
      resources?: Array<{
        resourceId: string;
        capacityUnits?: number;
        zoneId?: string;
      }>;
      startsAt: string;
      partyId?: string;
      assetId?: string;
      packageId?: string;
      branchId?: string;
      deliveryFormat?: "INDIVIDUAL" | "GROUP" | "SELF_PRACTICE" | "RENTAL";
      notes?: string;
      source?: "MANUAL" | "PUBLIC_SITE" | "PHONE" | "API" | "IMPORT";
      idempotencyKey?: string;
    }
  ): Promise<{ id: string; number: string; version: number }> {
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException("Некорректное время записи");
    }

    const rawAllocations =
      Array.isArray(input.resources) && input.resources.length
        ? input.resources.map((item) => ({
            resourceId: String(item.resourceId ?? "").trim(),
            capacityUnits: Math.floor(item.capacityUnits ?? 1),
            zoneId: item.zoneId?.trim() || null
          }))
        : (input.resourceIds ?? []).map((resourceId) => ({
            resourceId: String(resourceId).trim(),
            capacityUnits: 1,
            zoneId: null as string | null
          }));

    if (!rawAllocations.length || rawAllocations.length > 10) {
      throw new BadRequestException("Выберите от 1 до 10 ресурсов");
    }

    const seen = new Set<string>();
    for (const allocation of rawAllocations) {
      if (!allocation.resourceId || seen.has(allocation.resourceId)) {
        throw new BadRequestException("Ресурс в записи должен быть уникальным");
      }
      seen.add(allocation.resourceId);
      if (
        !Number.isSafeInteger(allocation.capacityUnits) ||
        allocation.capacityUnits < 1 ||
        allocation.capacityUnits > 100000
      ) {
        throw new BadRequestException("Некорректная доля ресурса");
      }
    }
    const resourceIds = [...seen].sort();
    const scopedMembershipIds = await this.serviceScope(context, "service.write");

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.idempotencyKey) {
        const existing = await client.query<{
          id: string;
          business_number: string;
          version: number;
        }>(
          `SELECT id,business_number,version
           FROM service_booking
           WHERE tenant_id=$1 AND idempotency_key=$2`,
          [context.tenantId, input.idempotencyKey.trim()]
        );
        if (existing.rows[0]) {
          await this.assertBookingAccess(
            client,
            context.tenantId,
            existing.rows[0].id,
            scopedMembershipIds
          );
          return {
            id: existing.rows[0].id,
            number: existing.rows[0].business_number,
            version: existing.rows[0].version
          };
        }
      }

      const service = await this.getService(
        client,
        context.tenantId,
        input.serviceId
      );
      const resources = await this.lockResources(
        client,
        context.tenantId,
        resourceIds
      );
      this.assertResourceScope(resources, scopedMembershipIds);
      await this.assertRequirements(
        client,
        context.tenantId,
        input.serviceId,
        resources
      );

      const employees = resources.filter((resource) => resource.type === "EMPLOYEE");
      if (employees.length > 1) {
        throw new BadRequestException(
          "Для одной записи можно выбрать только одного основного сотрудника"
        );
      }
      const employee = employees[0] ?? null;
      const deliveryFormat = input.deliveryFormat ?? service.delivery_format;
      if (
        !["INDIVIDUAL","GROUP","SELF_PRACTICE","RENTAL"].includes(deliveryFormat)
      ) {
        throw new BadRequestException("Некорректный формат услуги");
      }
      if (
        deliveryFormat !== "SELF_PRACTICE" &&
        deliveryFormat !== "RENTAL" &&
        !employee
      ) {
        throw new BadRequestException("Для услуги необходимо выбрать сотрудника");
      }

      const localTimezone =
        employee?.timezone ??
        resources.find((resource) =>
          ["ROOM","HALL","WORKPLACE"].includes(resource.type)
        )?.timezone ??
        "Europe/Moscow";

      const rule = await this.resolveDeliveryRule(
        client,
        context.tenantId,
        input.serviceId,
        employee?.id ?? null,
        input.branchId ?? null,
        deliveryFormat,
        startsAt,
        localTimezone
      );

      const duration = rule?.duration_minutes ?? service.duration_minutes;
      const priceMinor = rule?.price_minor ?? service.price_minor;
      const endsAt = new Date(startsAt.getTime() + duration * 60000);

      const allocations = rawAllocations.map((allocation) => {
        const resource = resources.find(
          (candidate) => candidate.id === allocation.resourceId
        )!;
        return {
          ...allocation,
          capacityUnits:
            resource.type === "EMPLOYEE"
              ? 1
              : allocation.capacityUnits > 1
                ? allocation.capacityUnits
                : ["ROOM","HALL","WORKPLACE"].includes(resource.type)
                  ? (rule?.capacity_units ?? allocation.capacityUnits)
                  : allocation.capacityUnits
        };
      });

      for (const allocation of allocations) {
        const resource = resources.find(
          (candidate) => candidate.id === allocation.resourceId
        )!;
        if (allocation.capacityUnits > resource.capacity) {
          throw new ConflictException(
            "Запрошенная доля превышает вместимость ресурса: " + resource.name
          );
        }
        if (allocation.zoneId) {
          const zone = await client.query<{capacity_units:number}>(
            `SELECT capacity_units
             FROM service_resource_zone
             WHERE tenant_id=$1 AND id=$2 AND resource_id=$3 AND status='ACTIVE'`,
            [context.tenantId, allocation.zoneId, allocation.resourceId]
          );
          if (!zone.rows[0]) {
            throw new NotFoundException("Зона ресурса не найдена");
          }
          if (allocation.capacityUnits > zone.rows[0].capacity_units) {
            throw new ConflictException("Запрошенная доля превышает вместимость зоны");
          }
        }

        const available = await this.resourceAvailable(
          client,
          context.tenantId,
          allocation.resourceId,
          startsAt,
          endsAt,
          service.buffer_before_minutes,
          service.buffer_after_minutes,
          allocation.capacityUnits,
          undefined,
          allocation.zoneId
        );
        if (!available) {
          throw new ConflictException(
            "Ресурс недоступен или его свободной вместимости недостаточно: " +
              resource.name
          );
        }
      }

      let effectivePartyId = input.partyId ?? null;
      if (input.assetId) {
        const asset = await client.query<{party_id:string|null}>(
          `SELECT party_id
           FROM service_asset
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
           FOR SHARE`,
          [context.tenantId, input.assetId]
        );
        const assetRow=asset.rows[0];
        if (!assetRow) throw new NotFoundException("Объект обслуживания не найден");
        if (
          effectivePartyId &&
          assetRow.party_id &&
          assetRow.party_id !== effectivePartyId
        ) {
          throw new ConflictException(
            "Объект обслуживания принадлежит другому клиенту"
          );
        }
        effectivePartyId=effectivePartyId ?? assetRow.party_id;
      }

      if (input.packageId) {
        const packageOwner=await client.query<{party_id:string}>(
          `SELECT party_id
           FROM service_package
           WHERE tenant_id=$1 AND id=$2
             AND status='ACTIVE'
             AND starts_at<=now()
             AND expires_at>now()`,
          [context.tenantId,input.packageId]
        );
        const packageRow=packageOwner.rows[0];
        if (!packageRow) throw new NotFoundException("Активный абонемент не найден");
        if (effectivePartyId && effectivePartyId !== packageRow.party_id) {
          const beneficiary=await client.query(
            `SELECT 1 FROM service_package_beneficiary
             WHERE tenant_id=$1 AND package_id=$2 AND party_id=$3
               AND status='ACTIVE'`,
            [context.tenantId,input.packageId,effectivePartyId]
          );
          if (!beneficiary.rowCount) {
            throw new ConflictException("Абонемент не действует для выбранного клиента");
          }
        }
        effectivePartyId=effectivePartyId ?? packageRow.party_id;
      }

      if (effectivePartyId) {
        const party=await client.query(
          `SELECT 1 FROM party
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,effectivePartyId]
        );
        if (!party.rowCount) throw new NotFoundException("Клиент не найден");
      }

      const number=await this.nextNumber(
        client,context.tenantId,"service_booking","BOOK"
      );
      const result=await client.query<{
        id:string;
        business_number:string;
        version:number;
      }>(
        `INSERT INTO service_booking(
           tenant_id,business_number,party_id,asset_id,service_id,branch_id,
           status,source,starts_at,ends_at,price_minor_snapshot,currency,
           duration_minutes_snapshot,buffer_before_minutes_snapshot,
           buffer_after_minutes_snapshot,notes,idempotency_key,
           created_by_membership_id,delivery_rule_id,technology_card_id,
           delivery_format_snapshot
         ) VALUES(
           $1,$2,$3,$4,$5,$6,'CONFIRMED',$7,$8,$9,$10,$11,$12,$13,$14,
           $15,$16,$17,$18,$19,$20
         )
         RETURNING id,business_number,version`,
        [
          context.tenantId,number,effectivePartyId,input.assetId ?? null,
          input.serviceId,input.branchId ?? null,input.source ?? "MANUAL",
          startsAt,endsAt,priceMinor,service.currency,duration,
          service.buffer_before_minutes,service.buffer_after_minutes,
          input.notes?.trim() || null,input.idempotencyKey?.trim() || null,
          context.membershipId,rule?.id ?? null,rule?.technology_card_id ?? null,
          deliveryFormat
        ]
      );
      const booking=result.rows[0];
      if (!booking) throw new Error("SERVICE_BOOKING_CREATE_FAILED");

      if (input.packageId) {
        await this.reservePackageForBooking(
          client,context.tenantId,input.packageId,booking.id,effectivePartyId,
          input.serviceId,startsAt,employee?.id ?? null,localTimezone
        );
      }

      for (const allocation of allocations) {
        const resource=resources.find(
          (candidate) => candidate.id === allocation.resourceId
        )!;
        await client.query(
          `INSERT INTO service_booking_resource(
             tenant_id,booking_id,resource_id,capacity_units,zone_id,
             cost_per_hour_minor_snapshot
           ) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            context.tenantId,booking.id,allocation.resourceId,
            allocation.capacityUnits,allocation.zoneId,
            resource.cost_per_hour_minor
          ]
        );
      }

      if (rule?.technology_card_id) {
        await this.seedTechnologyCardMaterials(
          client,context.tenantId,booking.id,rule.technology_card_id
        );
      }

      if (
        !input.packageId &&
        effectivePartyId &&
        BigInt(priceMinor) > 0n
      ) {
        await this.ensureBookingChargeTx(client,context,{
          bookingId:booking.id,
          payerPartyId:effectivePartyId,
          amountMinor:String(priceMinor),
          currency:service.currency,
          dueAt:startsAt
        });
      }

      await this.attribution.recordConversion(client,context,{
        partyId:effectivePartyId,
        sourceType:"SERVICE_BOOKING",
        sourceId:booking.id,
        conversionType:"BOOKING",
        revenueMinor:0n,
        currency:service.currency,
        metadata:{
          serviceId:input.serviceId,
          startsAt:startsAt.toISOString(),
          deliveryRuleId:rule?.id ?? null,
          deliveryFormat
        }
      });

      await this.events.enqueue(client,context,{
        eventName:"service.booking_created",
        entityType:"SERVICE_BOOKING",
        entityId:booking.id,
        payload:{
          bookingId:booking.id,
          number,
          serviceId:input.serviceId,
          startsAt:startsAt.toISOString(),
          endsAt:endsAt.toISOString(),
          partyId:effectivePartyId,
          assetId:input.assetId ?? null,
          packageId:input.packageId ?? null,
          deliveryRuleId:rule?.id ?? null,
          deliveryFormat,
          resources:allocations
        }
      });

      return {
        id:booking.id,
        number:booking.business_number,
        version:booking.version
      };
    });
  }

  async attachParty(
    context: TenantContext,
    bookingId: string,
    partyId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const booking = await client.query<{
        party_id: string | null;
        asset_id: string | null;
        service_id: string;
        starts_at: Date;
        created_at: Date;
        currency: string;
        price_minor_snapshot:string;
      }>(
        `SELECT
           party_id,asset_id,service_id,starts_at,created_at,currency,
           price_minor_snapshot::text
         FROM service_booking
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, bookingId]
      );

      const row = booking.rows[0];
      if (!row) throw new NotFoundException("Запись не найдена");

      const party = await client.query(
        `SELECT 1 FROM party
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, partyId]
      );
      if (!party.rowCount) throw new NotFoundException("Клиент не найден");

      if (row.party_id && row.party_id !== partyId) {
        throw new ConflictException(
          "К записи уже привязан другой клиент"
        );
      }

      if (row.asset_id) {
        const asset = await client.query<{ party_id: string | null }>(
          `SELECT party_id FROM service_asset
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, row.asset_id]
        );
        const assetPartyId = asset.rows[0]?.party_id ?? null;
        if (assetPartyId && assetPartyId !== partyId) {
          throw new ConflictException(
            "Объект обслуживания принадлежит другому клиенту"
          );
        }
      }

      if (!row.party_id) {
        await client.query(
          `UPDATE service_booking
           SET party_id=$3,version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND party_id IS NULL`,
          [context.tenantId, bookingId, partyId]
        );
      }

      const hasPackage=await client.query(
        `SELECT 1 FROM service_package_redemption
         WHERE tenant_id=$1 AND booking_id=$2
         LIMIT 1`,
        [context.tenantId,bookingId]
      );
      if(!hasPackage.rowCount&&BigInt(row.price_minor_snapshot)>0n){
        await this.ensureBookingChargeTx(client,context,{
          bookingId,
          payerPartyId:partyId,
          amountMinor:row.price_minor_snapshot,
          currency:row.currency,
          dueAt:row.starts_at
        });
      }

      await this.attribution.recordConversion(client, context, {
        partyId,
        sourceType: "SERVICE_BOOKING",
        sourceId: bookingId,
        conversionType: "BOOKING",
        revenueMinor: 0n,
        currency: row.currency,
        occurredAt: row.created_at,
        metadata: {
          serviceId: row.service_id,
          startsAt: row.starts_at.toISOString()
        }
      });

      await this.events.enqueue(client, context, {
        eventName: "service.booking_party_attached",
        entityType: "SERVICE_BOOKING",
        entityId: bookingId,
        payload: { bookingId, partyId }
      });
    });
  }

  async reschedule(
    context: TenantContext,
    bookingId: string,
    input: {
      startsAt: string;
      resourceIds?: string[];
      resources?: Array<{
        resourceId:string;
        capacityUnits?:number;
        zoneId?:string;
      }>;
      version: number;
    }
  ): Promise<{ version: number }> {
    const startsAt=new Date(input.startsAt);
    if(Number.isNaN(startsAt.getTime())){
      throw new BadRequestException("Некорректное время записи");
    }
    if(!Number.isSafeInteger(input.version)||input.version<1){
      throw new BadRequestException("Некорректная версия записи");
    }

    const scopedMembershipIds=await this.serviceScope(context,"service.write");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertBookingAccess(
        client,context.tenantId,bookingId,scopedMembershipIds
      );
      const bookingResult=await client.query<{
        id:string;
        service_id:string;
        status:BookingStatus;
        duration_minutes_snapshot:number;
        buffer_before_minutes_snapshot:number;
        buffer_after_minutes_snapshot:number;
        version:number;
      }>(
        `SELECT
           id,service_id,status,duration_minutes_snapshot,
           buffer_before_minutes_snapshot,buffer_after_minutes_snapshot,version
         FROM service_booking
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,bookingId]
      );
      const booking=bookingResult.rows[0];
      if(!booking) throw new NotFoundException("Запись не найдена");
      if(booking.version!==input.version){
        throw new ConflictException("Запись уже была изменена");
      }
      if(!["DRAFT","CONFIRMED"].includes(booking.status)){
        throw new BadRequestException(
          "Перенос доступен только до начала оказания услуги"
        );
      }

      let allocations:Array<{
        resourceId:string;
        capacityUnits:number;
        zoneId:string|null;
      }>;

      if(Array.isArray(input.resources)&&input.resources.length){
        allocations=input.resources.map(item=>({
          resourceId:String(item.resourceId??"").trim(),
          capacityUnits:Math.floor(item.capacityUnits??1),
          zoneId:item.zoneId?.trim()||null
        }));
      }else if(input.resourceIds?.length){
        allocations=Array.from(new Set(input.resourceIds)).map(resourceId=>({
          resourceId,
          capacityUnits:1,
          zoneId:null
        }));
      }else{
        allocations=(
          await client.query<{
            resource_id:string;
            capacity_units:number;
            zone_id:string|null;
          }>(
            `SELECT resource_id,capacity_units,zone_id
             FROM service_booking_resource
             WHERE tenant_id=$1 AND booking_id=$2
             ORDER BY resource_id`,
            [context.tenantId,bookingId]
          )
        ).rows.map(row=>({
          resourceId:row.resource_id,
          capacityUnits:row.capacity_units,
          zoneId:row.zone_id
        }));
      }

      if(!allocations.length||allocations.length>10){
        throw new BadRequestException("Выберите от 1 до 10 ресурсов");
      }
      const seen=new Set<string>();
      for(const allocation of allocations){
        if(!allocation.resourceId||seen.has(allocation.resourceId)){
          throw new BadRequestException("Ресурс в записи должен быть уникальным");
        }
        seen.add(allocation.resourceId);
        if(
          !Number.isSafeInteger(allocation.capacityUnits)||
          allocation.capacityUnits<1||allocation.capacityUnits>100000
        ){
          throw new BadRequestException("Некорректная доля ресурса");
        }
      }

      const resourceIds=[...seen].sort();
      const resources=await this.lockResources(
        client,context.tenantId,resourceIds
      );
      this.assertResourceScope(resources,scopedMembershipIds);
      await this.assertRequirements(
        client,context.tenantId,booking.service_id,resources
      );

      const endsAt=new Date(
        startsAt.getTime()+booking.duration_minutes_snapshot*60000
      );

      for(const allocation of allocations){
        const resource=resources.find(
          candidate=>candidate.id===allocation.resourceId
        )!;
        if(resource.type==="EMPLOYEE"&&allocation.capacityUnits!==1){
          throw new BadRequestException(
            "Сотрудник бронируется одной единицей вместимости"
          );
        }
        if(allocation.capacityUnits>resource.capacity){
          throw new ConflictException(
            "Запрошенная доля превышает вместимость ресурса: "+resource.name
          );
        }
        const available=await this.resourceAvailable(
          client,context.tenantId,resource.id,startsAt,endsAt,
          booking.buffer_before_minutes_snapshot,
          booking.buffer_after_minutes_snapshot,
          allocation.capacityUnits,bookingId,allocation.zoneId
        );
        if(!available){
          throw new ConflictException(
            "Ресурс недоступен или его вместимости недостаточно: "+resource.name
          );
        }
      }

      await client.query(
        `DELETE FROM service_booking_resource
         WHERE tenant_id=$1 AND booking_id=$2`,
        [context.tenantId,bookingId]
      );
      for(const allocation of allocations){
        const resource=resources.find(
          candidate=>candidate.id===allocation.resourceId
        )!;
        await client.query(
          `INSERT INTO service_booking_resource(
             tenant_id,booking_id,resource_id,capacity_units,zone_id,
             cost_per_hour_minor_snapshot
           ) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            context.tenantId,bookingId,allocation.resourceId,
            allocation.capacityUnits,allocation.zoneId,
            resource.cost_per_hour_minor
          ]
        );
      }

      const update=await client.query<{version:number}>(
        `UPDATE service_booking
         SET starts_at=$3,ends_at=$4,version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING version`,
        [context.tenantId,bookingId,startsAt,endsAt]
      );

      await client.query(
        `UPDATE financial_obligation o
         SET due_at=$3,updated_at=now()
         FROM service_booking_charge c
         WHERE c.tenant_id=$1
           AND c.booking_id=$2
           AND c.obligation_id=o.id
           AND o.tenant_id=c.tenant_id
           AND o.status IN ('OPEN','PARTIALLY_SETTLED')`,
        [context.tenantId,bookingId,startsAt]
      );
      await client.query(
        `UPDATE finance_invoice i
         SET due_at=$3,updated_at=now()
         FROM service_booking_charge c
         WHERE c.tenant_id=$1
           AND c.booking_id=$2
           AND c.invoice_id=i.id
           AND i.tenant_id=c.tenant_id
           AND i.status IN ('ISSUED','PARTIALLY_PAID')`,
        [context.tenantId,bookingId,startsAt]
      );
      await client.query(
        `UPDATE service_booking_charge
         SET due_at=$3,updated_at=now()
         WHERE tenant_id=$1 AND booking_id=$2
           AND status IN ('OPEN','PARTIALLY_PAID')`,
        [context.tenantId,bookingId,startsAt]
      );

      await this.events.enqueue(client,context,{
        eventName:"service.booking_rescheduled",
        entityType:"SERVICE_BOOKING",
        entityId:bookingId,
        payload:{
          bookingId,
          startsAt:startsAt.toISOString(),
          endsAt:endsAt.toISOString(),
          resources:allocations
        }
      });

      return {version:update.rows[0]!.version};
    });
  }

  async setStatus(
    context: TenantContext,
    bookingId: string,
    status: "ARRIVED" | "IN_SERVICE" | "COMPLETED" | "CANCELLED" | "NO_SHOW",
    version: number
  ): Promise<{ version: number; status: string }> {
    if (!["ARRIVED", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW"].includes(status) ||
        !Number.isSafeInteger(version) || version < 1) {
      throw new BadRequestException("Некорректный статус или версия записи");
    }
    const scopedMembershipIds = await this.serviceScope(context, "service.write");
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertBookingAccess(
        client,
        context.tenantId,
        bookingId,
        scopedMembershipIds
      );
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
           AND (
             (status IN ('DRAFT','CONFIRMED') AND $3 IN ('ARRIVED','CANCELLED','NO_SHOW'))
             OR (status = 'ARRIVED' AND $3 IN ('IN_SERVICE','CANCELLED','NO_SHOW'))
             OR (status = 'IN_SERVICE' AND $3 IN ('COMPLETED','CANCELLED'))
           )
         RETURNING version, status`,
        [context.tenantId, bookingId, status, version]
      );

      const row = result.rows[0];
      if (!row) {
        throw new ConflictException("Запись уже изменена или переход недоступен");
      }

      if (row.status === "COMPLETED") {
        await this.consumeRemainingMaterials(client,context,bookingId);
        await this.economics.calculateBookingTx(client,context,bookingId);
      }

      if (["COMPLETED","CANCELLED","NO_SHOW"].includes(row.status)) {
        await this.settlePackageRedemption(
          client,
          context.tenantId,
          bookingId,
          row.status as "COMPLETED" | "CANCELLED" | "NO_SHOW"
        );
      }

      if(row.status==="CANCELLED"){
        await this.cancelBookingChargeTx(client,context,bookingId);
      }

      if (row.status === "COMPLETED") {
        const completed = await client.query<{
          party_id: string | null;
          currency: string;
          price_minor_snapshot:string;
        }>(
          `SELECT party_id,currency,price_minor_snapshot::text
           FROM service_booking
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, bookingId]
        );

        await this.attribution.recordConversion(client, context, {
          partyId: completed.rows[0]?.party_id ?? null,
          sourceType: "SERVICE_BOOKING",
          sourceId: bookingId,
          conversionType: "COMPLETED_SERVICE",
          revenueMinor: BigInt(
            completed.rows[0]?.price_minor_snapshot ?? "0"
          ),
          currency: completed.rows[0]?.currency ?? "RUB",
          metadata: {
            status: "COMPLETED"
          }
        });
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

  private async ensureBookingChargeTx(
    client:PoolClient,
    context:TenantContext,
    input:{
      bookingId:string;
      payerPartyId:string;
      amountMinor:string;
      currency:string;
      dueAt:Date;
    }
  ):Promise<{id:string;invoiceId:string;obligationId:string}>{
    if(BigInt(input.amountMinor)<=0n){
      throw new BadRequestException("Сумма начисления должна быть больше нуля");
    }

    const existing=await client.query<{
      id:string;
      obligation_id:string|null;
      invoice_id:string|null;
      amount_minor:string;
      payer_party_id:string;
    }>(
      `SELECT
         id,obligation_id,invoice_id,amount_minor::text,payer_party_id
       FROM service_booking_charge
       WHERE tenant_id=$1 AND booking_id=$2
       FOR UPDATE`,
      [context.tenantId,input.bookingId]
    );
    if(existing.rows[0]){
      const row=existing.rows[0];
      if(
        row.payer_party_id!==input.payerPartyId ||
        row.amount_minor!==input.amountMinor
      ){
        throw new ConflictException(
          "Финансовое начисление записи уже создано с другими параметрами"
        );
      }
      if(!row.obligation_id||!row.invoice_id){
        throw new ConflictException(
          "Финансовый контур записи создан не полностью"
        );
      }
      return {
        id:row.id,
        obligationId:row.obligation_id,
        invoiceId:row.invoice_id
      };
    }

    const actorMembershipId=
      context.membershipId==="00000000-0000-0000-0000-000000000000"
        ?null
        :context.membershipId;

    const charge=await client.query<{id:string}>(
      `INSERT INTO service_booking_charge(
         tenant_id,booking_id,payer_party_id,currency,amount_minor,due_at,
         created_by_membership_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        context.tenantId,input.bookingId,input.payerPartyId,input.currency,
        input.amountMinor,input.dueAt,actorMembershipId
      ]
    );
    const chargeId=charge.rows[0]?.id;
    if(!chargeId) throw new Error("SERVICE_BOOKING_CHARGE_CREATE_FAILED");

    const obligation=await client.query<{id:string}>(
      `INSERT INTO financial_obligation(
         tenant_id,direction,party_id,source_type,source_id,
         currency,amount_minor,due_at
       ) VALUES(
         $1,'RECEIVABLE',$2,'SERVICE_BOOKING_CHARGE',$3,$4,$5,$6
       )
       RETURNING id`,
      [
        context.tenantId,input.payerPartyId,chargeId,input.currency,
        input.amountMinor,input.dueAt
      ]
    );
    const obligationId=obligation.rows[0]?.id;
    if(!obligationId) throw new Error("SERVICE_BOOKING_OBLIGATION_CREATE_FAILED");

    const invoiceNumber=await this.nextNumber(
      client,context.tenantId,"finance_invoice","INV"
    );
    const invoice=await client.query<{id:string}>(
      `INSERT INTO finance_invoice(
         tenant_id,business_number,party_id,source_type,source_id,
         obligation_id,currency,amount_minor,due_at,
         created_by_membership_id
       ) VALUES(
         $1,$2,$3,'SERVICE_BOOKING_CHARGE',$4,$5,$6,$7,$8,$9
       )
       RETURNING id`,
      [
        context.tenantId,invoiceNumber,input.payerPartyId,chargeId,
        obligationId,input.currency,input.amountMinor,input.dueAt,
        actorMembershipId
      ]
    );
    const invoiceId=invoice.rows[0]?.id;
    if(!invoiceId) throw new Error("SERVICE_BOOKING_INVOICE_CREATE_FAILED");

    await client.query(
      `UPDATE service_booking_charge
       SET obligation_id=$3,invoice_id=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId,chargeId,obligationId,invoiceId]
    );

    return {id:chargeId,obligationId,invoiceId};
  }

  private async cancelBookingChargeTx(
    client:PoolClient,
    context:TenantContext,
    bookingId:string
  ):Promise<void>{
    const charge=await client.query<{
      id:string;
      payer_party_id:string;
      obligation_id:string|null;
      currency:string;
      amount_minor:string;
      status:string;
      obligation_status:string|null;
      settled_minor:string|null;
    }>(
      `SELECT
         c.id,c.payer_party_id,c.obligation_id,c.currency,
         c.amount_minor::text,c.status,
         o.status AS obligation_status,o.settled_minor::text
       FROM service_booking_charge c
       JOIN financial_obligation o
         ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
       WHERE c.tenant_id=$1 AND c.booking_id=$2
       FOR UPDATE OF c,o`,
      [context.tenantId,bookingId]
    );
    const row=charge.rows[0];
    if(!row||!row.obligation_id||row.status==="CANCELLED") return;

    const settled=BigInt(row.settled_minor??"0");
    if(settled>0n){
      const refund=await client.query<{id:string}>(
        `INSERT INTO financial_obligation(
           tenant_id,direction,party_id,source_type,source_id,
           currency,amount_minor,due_at
         ) VALUES(
           $1,'PAYABLE',$2,'SERVICE_BOOKING_REFUND',$3,$4,$5,now()
         )
         ON CONFLICT(tenant_id,direction,source_type,source_id)
         DO NOTHING
         RETURNING id`,
        [
          context.tenantId,row.payer_party_id,bookingId,
          row.currency,settled.toString()
        ]
      );
      if(!refund.rows[0]){
        const existingRefund=await client.query<{
          amount_minor:string;
          party_id:string|null;
          currency:string;
        }>(
          `SELECT amount_minor::text,party_id,currency
           FROM financial_obligation
           WHERE tenant_id=$1
             AND direction='PAYABLE'
             AND source_type='SERVICE_BOOKING_REFUND'
             AND source_id=$2
           FOR UPDATE`,
          [context.tenantId,bookingId]
        );
        const existing=existingRefund.rows[0];
        if(
          !existing ||
          existing.amount_minor!==settled.toString() ||
          existing.party_id!==row.payer_party_id ||
          existing.currency!==row.currency
        ){
          throw new ConflictException(
            "Существующий возврат не совпадает с оплаченной суммой записи"
          );
        }
      }
    }

    if(
      row.obligation_status &&
      row.obligation_status!=="CANCELLED"
    ){
      await client.query(
        `UPDATE financial_obligation
         SET status='CANCELLED',updated_at=now()
         WHERE tenant_id=$1 AND id=$2
           AND status<>'CANCELLED'`,
        [context.tenantId,row.obligation_id]
      );
    }
  }

  private async serviceScope(
    context: TenantContext,
    permission: "service.read" | "service.write"
  ): Promise<string[] | null> {
    // Public site bookings use a dedicated system actor and are already
    // constrained by a published form binding. Interactive user traffic never
    // receives this actor id from authentication.
    if (
      context.membershipId === "00000000-0000-0000-0000-000000000000"
    ) {
      return null;
    }

    const scope = await this.authorization.resolveScope(context, permission);
    if (!scope) throw new ForbiddenException("Недостаточно прав");
    return this.authorization.membershipIdsForScope(context, scope);
  }

  private async assertBookingAccess(
    client: PoolClient,
    tenantId: string,
    bookingId: string,
    scopedMembershipIds: string[] | null
  ): Promise<void> {
    if (scopedMembershipIds === null) return;

    const access = await client.query(
      `SELECT 1
       FROM service_booking b
       WHERE b.tenant_id=$1
         AND b.id=$2
         AND EXISTS (
           SELECT 1
           FROM service_booking_resource br
           JOIN service_resource r
             ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
           WHERE br.tenant_id=b.tenant_id
             AND br.booking_id=b.id
             AND r.membership_id = ANY($3::uuid[])
         )`,
      [tenantId, bookingId, scopedMembershipIds]
    );

    if (!access.rowCount) {
      throw new NotFoundException("Запись не найдена");
    }
  }

  private assertResourceScope(
    resources: Array<{ membership_id: string | null }>,
    scopedMembershipIds: string[] | null
  ): void {
    if (scopedMembershipIds === null) return;

    const staff = resources.filter((resource) => resource.membership_id !== null);
    if (
      staff.length === 0 ||
      staff.some(
        (resource) => !scopedMembershipIds.includes(resource.membership_id!)
      )
    ) {
      throw new ForbiddenException(
        "Выбран сотрудник вне доступной области"
      );
    }
  }

  private async requireServiceAll(
    context: TenantContext,
    permission: "service.read" | "service.write"
  ): Promise<void> {
    if (
      context.membershipId === "00000000-0000-0000-0000-000000000000"
    ) {
      return;
    }
    const scope = await this.authorization.resolveScope(context, permission);
    if (scope !== "all") {
      throw new ForbiddenException(
        "Операция доступна только администратору сервисного контура"
      );
    }
  }

  private async assertAssetAccess(
    client: PoolClient,
    tenantId: string,
    assetId: string,
    scopedMembershipIds: string[] | null
  ): Promise<void> {
    if (scopedMembershipIds === null) return;

    const access = await client.query(
      `SELECT 1
       FROM service_asset a
       LEFT JOIN party p
         ON p.tenant_id=a.tenant_id AND p.id=a.party_id
       WHERE a.tenant_id=$1
         AND a.id=$2
         AND (
           p.responsible_membership_id = ANY($3::uuid[])
           OR EXISTS (
             SELECT 1
             FROM service_booking b
             JOIN service_booking_resource br
               ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
             JOIN service_resource r
               ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
             WHERE b.tenant_id=a.tenant_id
               AND b.asset_id=a.id
               AND r.membership_id = ANY($3::uuid[])
           )
         )`,
      [tenantId, assetId, scopedMembershipIds]
    );

    if (!access.rowCount) {
      throw new NotFoundException("Объект обслуживания не найден");
    }
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
    ignoreBookingId?: string,
    zoneId?: string | null
  ): Promise<boolean> {
    const reservedStart=new Date(
      startsAt.getTime()-bufferBeforeMinutes*60000
    );
    const reservedEnd=new Date(
      endsAt.getTime()+bufferAfterMinutes*60000
    );

    const schedule=await client.query(
      `SELECT 1
       FROM service_resource r
       JOIN service_resource_schedule s
         ON s.tenant_id=r.tenant_id AND s.resource_id=r.id
       WHERE r.tenant_id=$1 AND r.id=$2
         AND s.weekday=EXTRACT(
           ISODOW FROM ($3::timestamptz AT TIME ZONE r.timezone)
         )
         AND (
           EXTRACT(HOUR FROM ($3::timestamptz AT TIME ZONE r.timezone))::int*60+
           EXTRACT(MINUTE FROM ($3::timestamptz AT TIME ZONE r.timezone))::int
         )>=s.start_minute
         AND (
           EXTRACT(HOUR FROM ($4::timestamptz AT TIME ZONE r.timezone))::int*60+
           EXTRACT(MINUTE FROM ($4::timestamptz AT TIME ZONE r.timezone))::int
         )<=s.end_minute
         AND (
           s.valid_from IS NULL OR
           s.valid_from<=($3::timestamptz AT TIME ZONE r.timezone)::date
         )
         AND (
           s.valid_to IS NULL OR
           s.valid_to>=($3::timestamptz AT TIME ZONE r.timezone)::date
         )
       LIMIT 1`,
      [tenantId,resourceId,reservedStart,reservedEnd]
    );
    if(!schedule.rowCount) return false;

    const capacity=await client.query<{
      capacity:number;
      occupied:string;
      blocked:string;
    }>(
      `SELECT
         r.capacity,
         coalesce((
           SELECT sum(br.capacity_units)
           FROM service_booking_resource br
           JOIN service_booking b
             ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
           WHERE br.tenant_id=r.tenant_id
             AND br.resource_id=r.id
             AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
             AND b.id<>coalesce(
               $5::uuid,'00000000-0000-0000-0000-000000000000'::uuid
             )
             AND (
               b.starts_at-
               make_interval(mins=>b.buffer_before_minutes_snapshot)
             )<$4
             AND (
               b.ends_at+
               make_interval(mins=>b.buffer_after_minutes_snapshot)
             )>$3
         ),0)::text AS occupied,
         coalesce((
           SELECT sum(
             CASE
               WHEN rb.capacity_units IS NOT NULL THEN rb.capacity_units
               WHEN rb.zone_id IS NULL THEN r.capacity
               ELSE z.capacity_units
             END
           )
           FROM service_resource_block rb
           LEFT JOIN service_resource_zone z
             ON z.tenant_id=rb.tenant_id AND z.id=rb.zone_id
           WHERE rb.tenant_id=r.tenant_id
             AND rb.resource_id=r.id
             AND rb.starts_at<$4
             AND rb.ends_at>$3
         ),0)::text AS blocked
       FROM service_resource r
       WHERE r.tenant_id=$1 AND r.id=$2 AND r.status='ACTIVE'`,
      [tenantId,resourceId,reservedStart,reservedEnd,ignoreBookingId??null]
    );
    const row=capacity.rows[0];
    if(!row) return false;
    if(
      Number(row.occupied)+Number(row.blocked)+capacityUnits>row.capacity
    ) return false;

    if(zoneId){
      const zone=await client.query<{
        capacity_units:number;
        occupied:string;
        blocked:string;
      }>(
        `SELECT
           z.capacity_units,
           coalesce((
             SELECT sum(br.capacity_units)
             FROM service_booking_resource br
             JOIN service_booking b
               ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
             WHERE br.tenant_id=z.tenant_id
               AND br.resource_id=z.resource_id
               AND br.zone_id=z.id
               AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
               AND b.id<>coalesce(
                 $5::uuid,'00000000-0000-0000-0000-000000000000'::uuid
               )
               AND (
                 b.starts_at-
                 make_interval(mins=>b.buffer_before_minutes_snapshot)
               )<$4
               AND (
                 b.ends_at+
                 make_interval(mins=>b.buffer_after_minutes_snapshot)
               )>$3
           ),0)::text AS occupied,
           coalesce((
             SELECT sum(
               coalesce(rb.capacity_units,z.capacity_units)
             )
             FROM service_resource_block rb
             WHERE rb.tenant_id=z.tenant_id
               AND rb.resource_id=z.resource_id
               AND rb.zone_id=z.id
               AND rb.starts_at<$4
               AND rb.ends_at>$3
           ),0)::text AS blocked
         FROM service_resource_zone z
         WHERE z.tenant_id=$1
           AND z.id=$6
           AND z.resource_id=$2
           AND z.status='ACTIVE'`,
        [
          tenantId,resourceId,reservedStart,reservedEnd,
          ignoreBookingId??null,zoneId
        ]
      );
      const z=zone.rows[0];
      if(!z) return false;
      if(
        Number(z.occupied)+Number(z.blocked)+capacityUnits>z.capacity_units
      ) return false;
    }

    return true;
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
    membership_id: string | null;
    timezone: string;
  }>> {
    const result = await client.query<{
      id: string;
      name: string;
      type: string;
      capacity: number;
      cost_per_hour_minor: string;
      membership_id: string | null;
      timezone: string;
    }>(
      `SELECT id,name,type,capacity,cost_per_hour_minor::text,membership_id,timezone
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

  private async resolveDeliveryRule(
    client:PoolClient,
    tenantId:string,
    serviceId:string,
    employeeResourceId:string|null,
    branchId:string|null,
    deliveryFormat:"INDIVIDUAL"|"GROUP"|"SELF_PRACTICE"|"RENTAL",
    startsAt:Date,
    timezone:string
  ):Promise<{
    id:string;
    price_minor:string|null;
    price_max_minor:string|null;
    duration_minutes:number|null;
    capacity_units:number;
    technology_card_id:string|null;
  }|null>{
    const result=await client.query<{
      id:string;
      price_minor:string|null;
      price_max_minor:string|null;
      duration_minutes:number|null;
      capacity_units:number;
      technology_card_id:string|null;
      employee_resource_id:string|null;
    }>(
      `SELECT
         r.id,r.price_minor::text,r.price_max_minor::text,
         r.duration_minutes,r.capacity_units,r.technology_card_id,
         r.employee_resource_id
       FROM service_delivery_rule r
       WHERE r.tenant_id=$1
         AND r.service_id=$2
         AND r.status='ACTIVE'
         AND r.delivery_format=$3
         AND (
           r.employee_resource_id IS NULL OR
           r.employee_resource_id=$4::uuid
         )
         AND (r.branch_id IS NULL OR r.branch_id=$5::uuid)
         AND r.valid_from<=($6::timestamptz AT TIME ZONE $7)::date
         AND (
           r.valid_to IS NULL OR
           r.valid_to>=($6::timestamptz AT TIME ZONE $7)::date
         )
         AND extract(
           isodow FROM ($6::timestamptz AT TIME ZONE $7)
         )::smallint=ANY(r.weekdays)
         AND (
           extract(hour FROM ($6::timestamptz AT TIME ZONE $7))::int*60+
           extract(minute FROM ($6::timestamptz AT TIME ZONE $7))::int
         )>=r.start_minute
         AND (
           extract(hour FROM ($6::timestamptz AT TIME ZONE $7))::int*60+
           extract(minute FROM ($6::timestamptz AT TIME ZONE $7))::int
         )<r.end_minute
       ORDER BY
         (r.employee_resource_id IS NOT NULL) DESC,
         (r.branch_id IS NOT NULL) DESC,
         r.priority,
         r.valid_from DESC,
         r.id
       LIMIT 1`,
      [
        tenantId,serviceId,deliveryFormat,employeeResourceId,
        branchId,startsAt,timezone
      ]
    );
    const row=result.rows[0]??null;

    if(employeeResourceId && (!row || row.employee_resource_id===null)){
      const restricted=await client.query(
        `SELECT 1
         FROM service_delivery_rule r
         WHERE r.tenant_id=$1
           AND r.service_id=$2
           AND r.status='ACTIVE'
           AND r.delivery_format=$3
           AND r.employee_resource_id IS NOT NULL
           AND (r.branch_id IS NULL OR r.branch_id=$4::uuid)
           AND r.valid_from<=($5::timestamptz AT TIME ZONE $6)::date
           AND (
             r.valid_to IS NULL OR
             r.valid_to>=($5::timestamptz AT TIME ZONE $6)::date
           )
           AND extract(
             isodow FROM ($5::timestamptz AT TIME ZONE $6)
           )::smallint=ANY(r.weekdays)
         LIMIT 1`,
        [tenantId,serviceId,deliveryFormat,branchId,startsAt,timezone]
      );
      if(restricted.rowCount && !row){
        throw new ConflictException(
          "Выбранный сотрудник не оказывает эту услугу в указанное время"
        );
      }
    }
    return row;
  }

  private async seedTechnologyCardMaterials(
    client:PoolClient,
    tenantId:string,
    bookingId:string,
    technologyCardId:string
  ):Promise<void>{
    await client.query(
      `INSERT INTO service_booking_material(
         tenant_id,booking_id,warehouse_id,sku_id,
         planned_quantity_milli,unit_cost_minor_snapshot
       )
       SELECT
         l.tenant_id,$3,l.warehouse_id,l.sku_id,
         (
           l.quantity_milli*(10000::bigint+l.waste_bps::bigint)+9999
         )/10000,
         s.cost_price_minor
       FROM service_technology_card_line l
       JOIN sku s
         ON s.tenant_id=l.tenant_id AND s.id=l.sku_id
       WHERE l.tenant_id=$1
         AND l.card_id=$2
         AND s.status='ACTIVE'`,
      [tenantId,technologyCardId,bookingId]
    );
  }

  private async consumeRemainingMaterials(
    client:PoolClient,
    context:TenantContext,
    bookingId:string
  ):Promise<void>{
    const lines=await client.query<{
      id:string;
      warehouse_id:string;
      sku_id:string;
      planned_quantity_milli:string;
      consumed_quantity_milli:string;
    }>(
      `SELECT
         id,warehouse_id,sku_id,
         planned_quantity_milli::text,consumed_quantity_milli::text
       FROM service_booking_material
       WHERE tenant_id=$1 AND booking_id=$2
       ORDER BY id
       FOR UPDATE`,
      [context.tenantId,bookingId]
    );

    for(const line of lines.rows){
      const remaining=
        BigInt(line.planned_quantity_milli)-
        BigInt(line.consumed_quantity_milli);
      if(remaining<=0n) continue;

      const movement=await this.inventory.consumeForService(
        client,context,{
          bookingId,
          warehouseId:line.warehouse_id,
          materialLineId:line.id,
          skuId:line.sku_id,
          quantityMilli:remaining,
          idempotencyKey:"auto-complete"
        }
      );
      if(movement.applied){
        await client.query(
          `UPDATE service_booking_material
           SET consumed_quantity_milli=consumed_quantity_milli+$3::bigint,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,line.id,remaining.toString()]
        );
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
    delivery_format: "INDIVIDUAL" | "GROUP" | "SELF_PRACTICE" | "RENTAL";
    group_capacity: number;
  }> {
    const result = await client.query<{
      id: string;
      duration_minutes: number;
      buffer_before_minutes: number;
      buffer_after_minutes: number;
      price_minor: string;
      currency: string;
      delivery_format: "INDIVIDUAL" | "GROUP" | "SELF_PRACTICE" | "RENTAL";
      group_capacity: number;
    }>(
      `SELECT id, duration_minutes, buffer_before_minutes,
               buffer_after_minutes, price_minor::text, currency,
               delivery_format,group_capacity
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

  private async reservePackageForBooking(
    client: PoolClient,
    tenantId: string,
    packageId: string,
    bookingId: string,
    partyId: string | null,
    serviceId: string,
    startsAt: Date,
    employeeResourceId:string|null,
    timezone:string
  ): Promise<void> {
    if (!partyId) {
      throw new BadRequestException("Для абонемента необходимо выбрать клиента");
    }

    const result=await client.query<{
      party_id:string;
      starts_at:Date;
      expires_at:Date;
      visit_limit_snapshot:number|null;
      reserved_visits:number;
      used_visits:number;
      applicable_service_id:string|null;
    }>(
      `SELECT
         sp.party_id,sp.starts_at,sp.expires_at,
         sp.visit_limit_snapshot,sp.reserved_visits,sp.used_visits,
         plan.applicable_service_id
       FROM service_package sp
       JOIN service_package_plan plan
         ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
       WHERE sp.tenant_id=$1 AND sp.id=$2 AND sp.status='ACTIVE'
       FOR UPDATE OF sp`,
      [tenantId,packageId]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Активный абонемент не найден");

    if(row.party_id!==partyId){
      const beneficiary=await client.query(
        `SELECT 1 FROM service_package_beneficiary
         WHERE tenant_id=$1 AND package_id=$2 AND party_id=$3
           AND status='ACTIVE'`,
        [tenantId,packageId,partyId]
      );
      if(!beneficiary.rowCount){
        throw new ConflictException("Абонемент принадлежит другому клиенту");
      }
    }

    if(startsAt<row.starts_at||startsAt>=row.expires_at){
      throw new ConflictException(
        "Дата записи находится вне срока действия абонемента"
      );
    }
    if(
      row.applicable_service_id &&
      row.applicable_service_id!==serviceId
    ){
      throw new ConflictException(
        "Абонемент не действует на выбранную услугу"
      );
    }
    if(
      row.visit_limit_snapshot!==null &&
      row.reserved_visits+row.used_visits>=row.visit_limit_snapshot
    ){
      throw new ConflictException("В абонементе закончились посещения");
    }

    const entitlementCount=await client.query<{count:number}>(
      `SELECT count(*)::integer AS count
       FROM service_package_entitlement
       WHERE tenant_id=$1 AND package_id=$2`,
      [tenantId,packageId]
    );

    let entitlementId:string|null=null;
    if((entitlementCount.rows[0]?.count??0)>0){
      const entitlement=await client.query<{
        id:string;
        visit_limit_snapshot:number|null;
        reserved_visits:number;
        used_visits:number;
      }>(
        `SELECT id,visit_limit_snapshot,reserved_visits,used_visits
         FROM service_package_entitlement
         WHERE tenant_id=$1
           AND package_id=$2
           AND lesson_type IS NULL
           AND dance_program_id IS NULL
           AND dance_group_id IS NULL
           AND (service_id IS NULL OR service_id=$3)
           AND (
             trainer_resource_id IS NULL OR
             trainer_resource_id=$4::uuid
           )
           AND extract(
             isodow FROM ($5::timestamptz AT TIME ZONE $6)
           )::smallint=ANY(weekdays)
           AND (
             extract(hour FROM ($5::timestamptz AT TIME ZONE $6))::int*60+
             extract(minute FROM ($5::timestamptz AT TIME ZONE $6))::int
           )>=start_minute
           AND (
             extract(hour FROM ($5::timestamptz AT TIME ZONE $6))::int*60+
             extract(minute FROM ($5::timestamptz AT TIME ZONE $6))::int
           )<end_minute
         ORDER BY
           (
             CASE WHEN service_id IS NULL THEN 0 ELSE 2 END+
             CASE WHEN trainer_resource_id IS NULL THEN 0 ELSE 4 END
           ) DESC,
           priority,id
         LIMIT 1
         FOR UPDATE`,
        [
          tenantId,packageId,serviceId,employeeResourceId,
          startsAt,timezone
        ]
      );
      const bucket=entitlement.rows[0];
      if(!bucket){
        throw new ConflictException(
          "Абонемент не действует на эту услугу, сотрудника или время"
        );
      }
      if(
        bucket.visit_limit_snapshot!==null &&
        bucket.reserved_visits+bucket.used_visits>=bucket.visit_limit_snapshot
      ){
        throw new ConflictException("Квота абонемента для этой услуги исчерпана");
      }
      entitlementId=bucket.id;
      const bucketUpdate=await client.query(
        `UPDATE service_package_entitlement
         SET reserved_visits=reserved_visits+1
         WHERE tenant_id=$1 AND id=$2
           AND (
             visit_limit_snapshot IS NULL OR
             reserved_visits+used_visits<visit_limit_snapshot
           )
         RETURNING id`,
        [tenantId,entitlementId]
      );
      if(!bucketUpdate.rowCount){
        throw new ConflictException("Квота абонемента была исчерпана");
      }
    }

    const packageUpdate=await client.query(
      `UPDATE service_package
       SET reserved_visits=reserved_visits+1,updated_at=now()
       WHERE tenant_id=$1 AND id=$2
         AND (
           visit_limit_snapshot IS NULL OR
           reserved_visits+used_visits<visit_limit_snapshot
         )
       RETURNING id`,
      [tenantId,packageId]
    );
    if(!packageUpdate.rowCount){
      throw new ConflictException("В абонементе закончились посещения");
    }

    await client.query(
      `INSERT INTO service_package_redemption(
         tenant_id,package_id,booking_id,package_entitlement_id,state
       ) VALUES($1,$2,$3,$4,'RESERVED')`,
      [tenantId,packageId,bookingId,entitlementId]
    );
  }

  private async settlePackageRedemption(
    client: PoolClient,
    tenantId: string,
    bookingId: string,
    bookingStatus: "COMPLETED" | "CANCELLED" | "NO_SHOW"
  ): Promise<void> {
    const redemption=await client.query<{
      id:string;
      package_id:string;
      package_entitlement_id:string|null;
      state:string;
      no_show_policy:"RELEASE"|"CONSUME";
    }>(
      `SELECT
         r.id,r.package_id,r.package_entitlement_id,r.state,
         plan.no_show_policy
       FROM service_package_redemption r
       JOIN service_package sp
         ON sp.tenant_id=r.tenant_id AND sp.id=r.package_id
       JOIN service_package_plan plan
         ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
       WHERE r.tenant_id=$1 AND r.booking_id=$2
       FOR UPDATE OF r,sp`,
      [tenantId,bookingId]
    );
    const row=redemption.rows[0];
    if(!row||row.state!=="RESERVED") return;

    const consume=
      bookingStatus==="COMPLETED" ||
      (bookingStatus==="NO_SHOW"&&row.no_show_policy==="CONSUME");

    if(consume){
      const packageUpdate=await client.query(
        `UPDATE service_package
         SET reserved_visits=reserved_visits-1,
             used_visits=used_visits+1,
             status=CASE
               WHEN visit_limit_snapshot IS NOT NULL
                AND used_visits+1>=visit_limit_snapshot THEN 'EXHAUSTED'
               ELSE status
             END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
         RETURNING id`,
        [tenantId,row.package_id]
      );
      if(!packageUpdate.rowCount){
        throw new ConflictException(
          "Нарушена целостность абонемента: отсутствует резерв"
        );
      }

      if(row.package_entitlement_id){
        const bucketUpdate=await client.query(
          `UPDATE service_package_entitlement
           SET reserved_visits=reserved_visits-1,
               used_visits=used_visits+1
           WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
           RETURNING id`,
          [tenantId,row.package_entitlement_id]
        );
        if(!bucketUpdate.rowCount){
          throw new ConflictException(
            "Нарушена целостность квоты абонемента"
          );
        }
      }

      const redemptionUpdate=await client.query(
        `UPDATE service_package_redemption
         SET state='CONSUMED',settled_at=now()
         WHERE tenant_id=$1 AND id=$2 AND state='RESERVED'
         RETURNING id`,
        [tenantId,row.id]
      );
      if(!redemptionUpdate.rowCount){
        throw new ConflictException("Посещение абонемента уже обработано");
      }
    }else{
      const packageUpdate=await client.query(
        `UPDATE service_package
         SET reserved_visits=reserved_visits-1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
         RETURNING id`,
        [tenantId,row.package_id]
      );
      if(!packageUpdate.rowCount){
        throw new ConflictException(
          "Нарушена целостность абонемента: отсутствует резерв"
        );
      }

      if(row.package_entitlement_id){
        const bucketUpdate=await client.query(
          `UPDATE service_package_entitlement
           SET reserved_visits=reserved_visits-1
           WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
           RETURNING id`,
          [tenantId,row.package_entitlement_id]
        );
        if(!bucketUpdate.rowCount){
          throw new ConflictException(
            "Нарушена целостность квоты абонемента"
          );
        }
      }

      const redemptionUpdate=await client.query(
        `UPDATE service_package_redemption
         SET state='RELEASED',settled_at=now()
         WHERE tenant_id=$1 AND id=$2 AND state='RESERVED'
         RETURNING id`,
        [tenantId,row.id]
      );
      if(!redemptionUpdate.rowCount){
        throw new ConflictException("Посещение абонемента уже обработано");
      }
    }
  }

  private normalizeAssetIdentifier(value?: string): string | null {
    const normalized = value?.trim().toUpperCase().replace(/\s+/g, "") ?? "";
    if (!normalized) return null;
    if (normalized.length > 80) {
      throw new BadRequestException("Идентификатор объекта слишком длинный");
    }
    return normalized;
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
