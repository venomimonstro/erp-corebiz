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

  async rename(
    context:TenantContext,resourceId:string,input:{name:string}
  ):Promise<{updated:true}>{
    const label=input?.name?.trim();
    if(!label||label.length<2||label.length>160)
      throw new BadRequestException("Название сотрудника или зала: от 2 до 160 символов");
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(resourceId))
      throw new BadRequestException("Некорректный ресурс");
    const access=await this.serviceScope(context,"service.write");
    if(access.scope!=="all"||
      (await this.authorization.resolveScope(context,"users.manage"))!=="all")
      throw new ForbiddenException("Изменять сотрудников может руководитель");
    return this.database.withTenantTransaction(context,async client=>{
      const updated=await client.query(
        `UPDATE service_resource SET name=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE' RETURNING id`,
        [context.tenantId,resourceId,label]
      );
      if(!updated.rowCount)throw new NotFoundException("Ресурс не найден");
      await this.audit(client,context,"service.resource_renamed",
        "service_resource",resourceId,{name:label});
      return {updated:true};
    });
  }

  /**
   * Archive an employee/hall without deleting attendance, payroll or bookings.
   * Reassignment is explicit; active future allocations cannot disappear.
   */
  async archive(context:TenantContext,resourceId:string):Promise<{archived:true}>{
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(resourceId))
      throw new BadRequestException("Некорректный ресурс");
    const access=await this.serviceScope(context,"service.write");
    if(access.scope!=="all"||
      (await this.authorization.resolveScope(context,"users.manage"))!=="all")
      throw new ForbiddenException("Архивирование сотрудников доступно руководителю");
    return this.database.withTenantTransaction(context,async client=>{
      const resource=await client.query<{id:string;type:string}>(
        `SELECT id,type FROM service_resource
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE' FOR UPDATE`,
        [context.tenantId,resourceId]
      );
      const item=resource.rows[0];
      if(!item)throw new NotFoundException("Тренер или зал не найден");
      const groups=await client.query(
        `SELECT 1 FROM dance_group WHERE tenant_id=$1
         AND status IN ('ACTIVE','PAUSED')
         AND (trainer_resource_id=$2 OR room_resource_id=$2)
         AND (ends_on IS NULL OR ends_on>=current_date) LIMIT 1`,
        [context.tenantId,resourceId]
      );
      if(groups.rowCount)throw new ConflictException(
        "Сначала переназначьте тренера или зал в действующих группах"
      );
      const lessons=await client.query(
        `SELECT 1 FROM dance_lesson WHERE tenant_id=$1
         AND (trainer_resource_id=$2 OR room_resource_id=$2)
         AND ends_at>now()
         AND status NOT IN ('COMPLETED','CANCELLED_BY_STUDIO',
                           'CANCELLED_BY_TRAINER') LIMIT 1`,
        [context.tenantId,resourceId]
      );
      if(lessons.rowCount)throw new ConflictException(
        "Сначала перенесите или отмените будущие занятия"
      );
      const bookings=await client.query(
        `SELECT 1 FROM service_booking_resource br
         JOIN service_booking b ON b.tenant_id=br.tenant_id
           AND b.id=br.booking_id
         WHERE br.tenant_id=$1 AND br.resource_id=$2
           AND b.ends_at>now()
           AND b.status NOT IN ('COMPLETED','CANCELLED','NO_SHOW')
         LIMIT 1`,[context.tenantId,resourceId]
      );
      if(bookings.rowCount)throw new ConflictException(
        "Ресурс занят в будущих клиентских записях"
      );
      const contracts=await client.query(
        `SELECT 1 FROM room_rental_contract
         WHERE tenant_id=$1 AND room_resource_id=$2
           AND status='ACTIVE'
           AND (valid_to IS NULL OR valid_to>=current_date)
         LIMIT 1`,[context.tenantId,resourceId]
      );
      if(contracts.rowCount)throw new ConflictException(
        "Сначала завершите действующий договор аренды зала"
      );
      await client.query(
        `UPDATE service_resource SET status='ARCHIVED',updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,resourceId]
      );
      await this.audit(client,context,"service.resource_archived",
        "service_resource",resourceId,{type:item.type});
      return {archived:true};
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

  /** Atomically materialize a 2/2 rota. Existing holiday/manual blocks remain intact. */
  async twoByTwo(context:TenantContext,resourceId:string,input:{
    startDate:string;days:number;startsWorking:boolean;
    startMinute:number;endMinute:number;replaceWeeklySchedule?:boolean;
  }):Promise<{days:number;blockedDays:number;timezone:string}>{
    const date=typeof input?.startDate==="string"?input.startDate:"";
    if(!input||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(resourceId)||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)||
      !Number.isInteger(input.days)||input.days<4||input.days>90||
      !Number.isInteger(input.startMinute)||!Number.isInteger(input.endMinute)||
      input.startMinute<0||input.endMinute>1440||
      input.endMinute-input.startMinute<60||
      typeof input.startsWorking!=="boolean"||
      !Number.isFinite(Date.parse(date+"T00:00:00Z"))||
      new Date(date+"T00:00:00Z").toISOString().slice(0,10)!==date)
      throw new BadRequestException("График 2/2: дата, 4–90 дней, часы и сотрудник обязательны");
    const access=await this.serviceScope(context,"service.write");
    if(access.scope!=="all"||
       (await this.authorization.resolveScope(context,"users.manage"))!=="all")
       throw new ForbiddenException("График смен утверждает руководитель");
    return this.database.withTenantTransaction(context,async client=>{
      const resource=await client.query<{type:string;timezone:string}>(
        "SELECT type,timezone FROM service_resource WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE' FOR UPDATE",
        [context.tenantId,resourceId]);
      if(resource.rows[0]?.type!=="EMPLOYEE")
        throw new BadRequestException("Выберите действующего сотрудника");
      const timezone=resource.rows[0]!.timezone;
      const schedule=await client.query<{weekday:number;start_minute:number;end_minute:number}>(
        "SELECT weekday,start_minute,end_minute FROM service_resource_schedule WHERE tenant_id=$1 AND resource_id=$2 FOR UPDATE",
        [context.tenantId,resourceId]);
      const same=schedule.rows.length===7&&schedule.rows.every(x=>
        x.start_minute===input.startMinute&&x.end_minute===input.endMinute);
      if(schedule.rowCount&&!same&&!input.replaceWeeklySchedule)
        throw new ConflictException("Сохранён другой график. Подтвердите замену.");
      if(!same){
        await client.query(
          "DELETE FROM service_resource_schedule WHERE tenant_id=$1 AND resource_id=$2",
          [context.tenantId,resourceId]);
        await client.query(
          "INSERT INTO service_resource_schedule(tenant_id,resource_id,weekday,start_minute,end_minute) SELECT $1,$2,w,$3,$4 FROM generate_series(1,7) w",
          [context.tenantId,resourceId,input.startMinute,input.endMinute]);
      }
      await client.query(
        "DELETE FROM service_resource_block WHERE tenant_id=$1 AND resource_id=$2 AND reason='COREBIZ_2X2_MANAGER_OFF' AND starts_at>=($4::date::timestamp AT TIME ZONE $3)",
        [context.tenantId,resourceId,timezone,date]);
      const off=await client.query(
        `WITH days AS (
           SELECT day::date AS d,(row_number() OVER (ORDER BY day)-1)::int AS i
           FROM generate_series($3::date,$3::date+($4::int-1),'1 day'::interval) day
         )
         INSERT INTO service_resource_block(
           tenant_id,resource_id,starts_at,ends_at,
           type,reason,created_by_membership_id
         )
         SELECT $1,$2,d::timestamp AT TIME ZONE $5,
           (d+1)::timestamp AT TIME ZONE $5,
           'UNAVAILABLE','COREBIZ_2X2_MANAGER_OFF',$7
         FROM days
         WHERE ((i+CASE WHEN $6::boolean THEN 0 ELSE 2 END)/2)%2=1
         RETURNING id`,
        [context.tenantId,resourceId,date,input.days,timezone,
          input.startsWorking,context.membershipId]);
      await this.audit(client,context,"service.schedule_two_by_two",
        "service_resource",resourceId,
        {date,days:input.days,blockedDays:off.rowCount,timezone});
      return {days:input.days,blockedDays:off.rowCount,timezone};
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
      capacityUnits?: number;
      zoneId?: string;
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

      const capacityUnits=
        input.capacityUnits===undefined ? null : Math.floor(input.capacityUnits);
      if(capacityUnits!==null&&(capacityUnits<1||capacityUnits>100000)){
        throw new BadRequestException("Некорректная блокируемая вместимость");
      }
      if(input.zoneId){
        const zone=await client.query<{capacity_units:number}>(
          `SELECT capacity_units
           FROM service_resource_zone
           WHERE tenant_id=$1 AND id=$2 AND resource_id=$3 AND status='ACTIVE'`,
          [context.tenantId,input.zoneId,resourceId]
        );
        if(!zone.rows[0]) throw new NotFoundException("Зона ресурса не найдена");
        if(capacityUnits!==null&&capacityUnits>zone.rows[0].capacity_units){
          throw new BadRequestException("Блокировка превышает вместимость зоны");
        }
      }else if(capacityUnits!==null){
        const resource=await client.query<{capacity:number}>(
          `SELECT capacity FROM service_resource
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,resourceId]
        );
        if(capacityUnits>(resource.rows[0]?.capacity??0)){
          throw new BadRequestException("Блокировка превышает вместимость ресурса");
        }
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO service_resource_block(
           tenant_id,resource_id,starts_at,ends_at,
           reason,type,capacity_units,zone_id,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          context.tenantId,resourceId,startsAt,endsAt,
          input.reason?.trim() || null,input.type ?? "UNAVAILABLE",
          capacityUnits,input.zoneId ?? null,context.membershipId
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
        `SELECT
           rb.id,rb.starts_at,rb.ends_at,rb.reason,rb.type,
           rb.capacity_units,rb.zone_id,z.name AS zone_name
         FROM service_resource_block rb
         LEFT JOIN service_resource_zone z
           ON z.tenant_id=rb.tenant_id AND z.id=rb.zone_id
         WHERE rb.tenant_id=$1
           AND rb.resource_id=$2
           AND rb.starts_at<$4
           AND rb.ends_at>$3
         ORDER BY rb.starts_at`,
        [context.tenantId, resourceId, fromDate, toDate]
      );

      return result.rows;
    });
  }

  async zones(
    context:TenantContext,
    resourceId:string
  ):Promise<Array<Record<string,unknown>>>{
    const access=await this.serviceScope(context,"service.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertResource(
        client,context.tenantId,resourceId,
        access.membershipIds,true
      );
      const result=await client.query(
        `SELECT id,resource_id,name,code,capacity_units,status,metadata
         FROM service_resource_zone
         WHERE tenant_id=$1 AND resource_id=$2 AND status='ACTIVE'
         ORDER BY name`,
        [context.tenantId,resourceId]
      );
      return result.rows;
    });
  }

  async createZone(
    context:TenantContext,
    resourceId:string,
    input:{
      name:string;
      code?:string;
      capacityUnits:number;
      metadata?:Record<string,unknown>;
    }
  ):Promise<{id:string}>{
    const access=await this.serviceScope(context,"service.write");
    const name=input.name?.trim();
    const capacity=Math.floor(input.capacityUnits);
    if(!name||name.length<1||name.length>120){
      throw new BadRequestException("Некорректное название зоны");
    }
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>100000){
      throw new BadRequestException("Некорректная вместимость зоны");
    }

    return this.database.withTenantTransaction(context,async client=>{
      await this.assertResource(
        client,context.tenantId,resourceId,
        access.membershipIds,access.scope==="all"
      );
      const resource=await client.query<{capacity:number;type:string}>(
        `SELECT capacity,type
         FROM service_resource
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
         FOR UPDATE`,
        [context.tenantId,resourceId]
      );
      const row=resource.rows[0];
      if(!row) throw new NotFoundException("Ресурс не найден");
      if(!["ROOM","HALL","WORKPLACE","EQUIPMENT","OTHER"].includes(row.type)){
        throw new BadRequestException("Этот тип ресурса нельзя делить на зоны");
      }
      if(capacity>row.capacity){
        throw new BadRequestException("Зона превышает вместимость ресурса");
      }

      try{
        const result=await client.query<{id:string}>(
          `INSERT INTO service_resource_zone(
             tenant_id,resource_id,name,code,capacity_units,metadata
           ) VALUES($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            context.tenantId,resourceId,name,input.code?.trim()||null,
            capacity,JSON.stringify(input.metadata??{})
          ]
        );
        return result.rows[0]!;
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(message.includes("SERVICE_RESOURCE_ZONE_CAPACITY_EXCEEDED")){
          throw new ConflictException(
            "Суммарная вместимость зон превышает вместимость ресурса"
          );
        }
        if(this.isUniqueViolation(error)){
          throw new ConflictException("Зона с таким кодом уже существует");
        }
        throw error;
      }
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
