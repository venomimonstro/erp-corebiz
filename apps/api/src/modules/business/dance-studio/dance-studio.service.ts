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

type DanceScopePermission = "dance.read" | "dance.write";
type LessonType =
  | "GROUP"
  | "INDIVIDUAL"
  | "TRIAL"
  | "MASTER_CLASS"
  | "OPEN_CLASS"
  | "REHEARSAL"
  | "RENTAL_EVENT";

@Injectable()
export class DanceStudioService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async dashboard(context: TenantContext) {
    const scopeIds = await this.scopeIds(context, "dance.read");
    return this.database.withTenantTransaction(context, async (client) => {
      const today = await client.query(
        `SELECT
           l.id,g.name AS group_name,p.name AS program_name,
           l.lesson_type,l.starts_at,l.ends_at,l.capacity,l.status,
           tr.name AS trainer_name,rr.name AS room_name,
           count(lp.id) FILTER (
             WHERE lp.status NOT IN ('WAITLIST','CANCELLED_IN_TIME')
           )::integer AS booked_count,
           count(lp.id) FILTER (
             WHERE lp.status IN ('ATTENDED','LATE')
           )::integer AS attended_count
         FROM dance_lesson l
         LEFT JOIN dance_group g
           ON g.tenant_id=l.tenant_id AND g.id=l.group_id
         LEFT JOIN dance_program p
           ON p.tenant_id=g.tenant_id AND p.id=g.program_id
         LEFT JOIN service_resource tr
           ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
         LEFT JOIN service_resource rr
           ON rr.tenant_id=l.tenant_id AND rr.id=l.room_resource_id
         LEFT JOIN dance_lesson_participant lp
           ON lp.tenant_id=l.tenant_id AND lp.lesson_id=l.id
         WHERE l.tenant_id=$1
           AND l.starts_at >= date_trunc('day',now())
           AND l.starts_at < date_trunc('day',now()) + interval '1 day'
           AND (
             $2::uuid[] IS NULL
             OR tr.membership_id = ANY($2::uuid[])
           )
         GROUP BY l.id,g.name,p.name,tr.name,rr.name
         ORDER BY l.starts_at`,
        [context.tenantId, scopeIds]
      );

      const debt = await client.query(
        `SELECT
           count(*) FILTER (
             WHERE o.status IN ('OPEN','PARTIALLY_SETTLED')
           )::integer AS open_count,
           coalesce(sum(o.amount_minor-o.settled_minor) FILTER (
             WHERE o.status IN ('OPEN','PARTIALLY_SETTLED')
           ),0)::text AS open_minor,
           count(*) FILTER (
             WHERE o.status IN ('OPEN','PARTIALLY_SETTLED')
               AND o.due_at < now()
           )::integer AS overdue_count
         FROM dance_student_charge c
         JOIN financial_obligation o
           ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
         JOIN dance_student s
           ON s.tenant_id=c.tenant_id AND s.id=c.student_id
         JOIN party sp
           ON sp.tenant_id=s.tenant_id AND sp.id=s.party_id
         WHERE c.tenant_id=$1
           AND (
             $2::uuid[] IS NULL
             OR sp.responsible_membership_id = ANY($2::uuid[])
             OR EXISTS (
               SELECT 1
               FROM dance_lesson_participant lp
               JOIN dance_lesson l
                 ON l.tenant_id=lp.tenant_id AND l.id=lp.lesson_id
               JOIN service_resource tr
                 ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
               WHERE lp.tenant_id=s.tenant_id
                 AND lp.student_id=s.id
                 AND tr.membership_id = ANY($2::uuid[])
             )
           )`,
        [context.tenantId, scopeIds]
      );

      const groupHealth = await client.query(
        `SELECT
           g.id,g.name,g.capacity,g.break_even_members,
           count(gm.id) FILTER (
             WHERE gm.status IN ('TRIAL','ACTIVE','PAUSED')
               AND gm.reserved_place
           )::integer AS members,
           count(w.id) FILTER (WHERE w.status='WAITING')::integer AS waitlist
         FROM dance_group g
         LEFT JOIN service_resource tr
           ON tr.tenant_id=g.tenant_id AND tr.id=g.trainer_resource_id
         LEFT JOIN dance_group_member gm
           ON gm.tenant_id=g.tenant_id AND gm.group_id=g.id
         LEFT JOIN dance_group_waitlist w
           ON w.tenant_id=g.tenant_id AND w.group_id=g.id
         WHERE g.tenant_id=$1 AND g.status='ACTIVE'
           AND (
             $2::uuid[] IS NULL
             OR tr.membership_id = ANY($2::uuid[])
           )
         GROUP BY g.id
         ORDER BY g.name`,
        [context.tenantId, scopeIds]
      );

      const packageAlerts = await client.query(
        `SELECT
           count(*) FILTER (
             WHERE sp.status='ACTIVE'
               AND sp.expires_at < now()+interval '7 days'
           )::integer AS expiring,
           count(*) FILTER (
             WHERE sp.status='ACTIVE'
               AND sp.visit_limit_snapshot IS NOT NULL
               AND sp.visit_limit_snapshot-sp.reserved_visits-sp.used_visits <= 2
           )::integer AS low_visits
         FROM service_package sp
         JOIN dance_student s
           ON s.tenant_id=sp.tenant_id AND s.party_id=sp.party_id
         JOIN party p
           ON p.tenant_id=s.tenant_id AND p.id=s.party_id
         WHERE sp.tenant_id=$1
           AND (
             $2::uuid[] IS NULL
             OR p.responsible_membership_id = ANY($2::uuid[])
             OR EXISTS (
               SELECT 1
               FROM dance_lesson_participant lp
               JOIN dance_lesson l
                 ON l.tenant_id=lp.tenant_id AND l.id=lp.lesson_id
               JOIN service_resource tr
                 ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
               WHERE lp.tenant_id=s.tenant_id
                 AND lp.student_id=s.id
                 AND tr.membership_id = ANY($2::uuid[])
             )
           )`,
        [context.tenantId, scopeIds]
      );

      const economics = await client.query(
        `SELECT
           coalesce(sum(p.earned_revenue_minor),0)::text AS revenue_minor,
           coalesce(sum(p.trainer_cost_minor),0)::text AS trainer_cost_minor,
           coalesce(sum(p.room_cost_minor),0)::text AS room_cost_minor,
           coalesce(sum(p.contribution_margin_minor),0)::text AS margin_minor
         FROM dance_lesson_profitability p
         JOIN dance_lesson l
           ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id
         LEFT JOIN service_resource tr
           ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
         WHERE p.tenant_id=$1
           AND l.starts_at >= date_trunc('month',now())
           AND (
             $2::uuid[] IS NULL
             OR tr.membership_id = ANY($2::uuid[])
           )`,
        [context.tenantId, scopeIds]
      );

      return {
        todayLessons: today.rows,
        debt: debt.rows[0] ?? {
          open_count: 0,
          open_minor: "0",
          overdue_count: 0
        },
        groups: groupHealth.rows,
        packageAlerts: packageAlerts.rows[0] ?? {
          expiring: 0,
          low_visits: 0
        },
        monthEconomics: economics.rows[0] ?? {
          revenue_minor: "0",
          trainer_cost_minor: "0",
          room_cost_minor: "0",
          margin_minor: "0"
        }
      };
    });
  }

  async students(context: TenantContext) {
    const scopeIds = await this.scopeIds(context, "dance.read");
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           s.id,s.party_id,p.display_name,s.birth_date,s.training_level,
           s.status,s.preferred_branch_id,s.joined_at,s.first_lesson_at,
           payer.id AS payer_party_id,payer.display_name AS payer_name,
           coalesce(sum(c.amount_minor-coalesce(o.settled_minor,0)) FILTER (
             WHERE c.status IN ('OPEN','PARTIALLY_PAID')
           ),0)::text AS debt_minor,
           count(distinct gm.group_id) FILTER (
             WHERE gm.status IN ('TRIAL','ACTIVE','PAUSED')
           )::integer AS active_groups
         FROM dance_student s
         JOIN party p
           ON p.tenant_id=s.tenant_id AND p.id=s.party_id
         LEFT JOIN LATERAL (
           SELECT pp.id,pp.display_name
           FROM party_relationship rel
           JOIN party pp
             ON pp.tenant_id=rel.tenant_id AND pp.id=rel.to_party_id
           WHERE rel.tenant_id=s.tenant_id
             AND rel.from_party_id=s.party_id
             AND rel.relation_type='PAYER'
             AND (rel.ends_on IS NULL OR rel.ends_on>=current_date)
           ORDER BY rel.is_primary DESC,rel.created_at
           LIMIT 1
         ) payer ON true
         LEFT JOIN dance_student_charge c
           ON c.tenant_id=s.tenant_id AND c.student_id=s.id
         LEFT JOIN financial_obligation o
           ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
         LEFT JOIN dance_group_member gm
           ON gm.tenant_id=s.tenant_id AND gm.student_id=s.id
         WHERE s.tenant_id=$1 AND s.status<>'ARCHIVED'
           AND (
             $2::uuid[] IS NULL
             OR p.responsible_membership_id = ANY($2::uuid[])
             OR EXISTS (
               SELECT 1
               FROM dance_lesson_participant lp2
               JOIN dance_lesson l2
                 ON l2.tenant_id=lp2.tenant_id AND l2.id=lp2.lesson_id
               JOIN service_resource tr2
                 ON tr2.tenant_id=l2.tenant_id
                AND tr2.id=l2.trainer_resource_id
               WHERE lp2.tenant_id=s.tenant_id
                 AND lp2.student_id=s.id
                 AND tr2.membership_id = ANY($2::uuid[])
             )
           )
         GROUP BY s.id,p.id,payer.id,payer.display_name
         ORDER BY p.display_name`,
        [context.tenantId, scopeIds]
      );
      return result.rows;
    });
  }

  async createStudent(
    context: TenantContext,
    input: {
      partyId: string;
      birthDate?: string;
      trainingLevel?: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
      preferredBranchId?: string;
      payerPartyId?: string;
      payerRelation?: "PARENT" | "GUARDIAN" | "PAYER";
    }
  ) {
    const scopeIds = await this.scopeIds(context, "dance.write");
    if (!input.partyId) throw new BadRequestException("Выберите ученика");
    if (input.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)) {
      throw new BadRequestException("Некорректная дата рождения");
    }
    if (input.birthDate && input.birthDate > new Date().toISOString().slice(0,10)) {
      throw new BadRequestException("Дата рождения не может быть в будущем");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const party = await client.query(
        `SELECT 1 FROM party
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
           AND (
             $3::uuid[] IS NULL
             OR responsible_membership_id = ANY($3::uuid[])
           )`,
        [context.tenantId,input.partyId,scopeIds]
      );
      if (!party.rowCount) throw new NotFoundException("Ученик CRM не найден");

      if (input.preferredBranchId) {
        const branch = await client.query(
          "SELECT 1 FROM branch WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
          [context.tenantId,input.preferredBranchId]
        );
        if (!branch.rowCount) throw new NotFoundException("Филиал не найден");
      }

      const row = await client.query(
        `INSERT INTO dance_student(
           tenant_id,party_id,birth_date,training_level,preferred_branch_id
         ) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id,party_id)
         DO UPDATE SET
           birth_date=coalesce(EXCLUDED.birth_date,dance_student.birth_date),
           training_level=coalesce(EXCLUDED.training_level,dance_student.training_level),
           preferred_branch_id=coalesce(EXCLUDED.preferred_branch_id,dance_student.preferred_branch_id),
           updated_at=now()
         RETURNING id,party_id,status`,
        [
          context.tenantId,
          input.partyId,
          input.birthDate ?? null,
          input.trainingLevel ?? null,
          input.preferredBranchId ?? null
        ]
      );

      const student = row.rows[0];
      if (!student) throw new Error("DANCE_STUDENT_CREATE_FAILED");

      if (input.payerPartyId) {
        await this.upsertRelationshipTx(
          client,
          context,
          input.partyId,
          input.payerPartyId,
          input.payerRelation ?? "PAYER",
          true
        );
        if ((input.payerRelation ?? "PAYER") !== "PAYER") {
          await this.upsertRelationshipTx(
            client,
            context,
            input.partyId,
            input.payerPartyId,
            "PAYER",
            true
          );
        }
      }

      await this.audit(client,context,"dance.student_saved","dance_student",student.id);
      return student;
    });
  }

  async addRelationship(
    context: TenantContext,
    studentId: string,
    input: {
      partyId: string;
      relationType: "PARENT" | "GUARDIAN" | "PAYER" | "FAMILY_MEMBER" | "EMERGENCY_CONTACT";
      isPrimary?: boolean;
    }
  ) {
    const scopeIds = await this.scopeIds(context, "dance.write");
    return this.database.withTenantTransaction(context, async (client) => {
      const student = await this.assertStudentAccess(
        client,
        context.tenantId,
        studentId,
        scopeIds
      );
      await this.upsertRelationshipTx(
        client,
        context,
        student.party_id,
        input.partyId,
        input.relationType,
        Boolean(input.isPrimary)
      );
      return { ok: true };
    });
  }

  async programs(context: TenantContext) {
    await this.scopeIds(context, "dance.read");
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT p.id,p.name,p.code,p.service_id,p.branch_id,p.min_age,p.max_age,
                p.default_duration_minutes,p.status,p.metadata,
                s.name AS service_name
         FROM dance_program p
         LEFT JOIN service_catalog_item s
           ON s.tenant_id=p.tenant_id AND s.id=p.service_id
         WHERE p.tenant_id=$1 AND p.status='ACTIVE'
         ORDER BY p.name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createProgram(
    context: TenantContext,
    input: {
      name: string;
      code?: string;
      serviceId: string;
      branchId?: string;
      minAge?: number;
      maxAge?: number;
      defaultDurationMinutes?: number;
    }
  ) {
    await this.requireAll(context,"dance.write");
    const name=input.name?.trim();
    if(!name || name.length>160) throw new BadRequestException("Некорректное направление");
    const duration=Math.floor(input.defaultDurationMinutes ?? 60);
    if(duration<15 || duration>360) throw new BadRequestException("Некорректная длительность");
    if(input.minAge!==undefined && (!Number.isInteger(input.minAge)||input.minAge<0||input.minAge>120))
      throw new BadRequestException("Некорректный минимальный возраст");
    if(input.maxAge!==undefined && (!Number.isInteger(input.maxAge)||input.maxAge<0||input.maxAge>120))
      throw new BadRequestException("Некорректный максимальный возраст");
    if(input.minAge!==undefined && input.maxAge!==undefined && input.minAge>input.maxAge)
      throw new BadRequestException("Возрастной диапазон задан неверно");

    return this.database.withTenantTransaction(context,async client=>{
      const service=await client.query(
        "SELECT 1 FROM service_catalog_item WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,input.serviceId]
      );
      if(!service.rowCount) throw new NotFoundException("Услуга не найдена");
      const result=await client.query(
        `INSERT INTO dance_program(
           tenant_id,name,code,service_id,branch_id,min_age,max_age,
           default_duration_minutes
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,name,code`,
        [
          context.tenantId,name,input.code?.trim()||null,input.serviceId,
          input.branchId??null,input.minAge??null,input.maxAge??null,duration
        ]
      );
      return result.rows[0];
    });
  }

  async groups(context: TenantContext) {
    const scopeIds=await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           g.id,g.name,g.program_id,p.name AS program_name,p.service_id,
           g.branch_id,g.trainer_resource_id,tr.name AS trainer_name,
           g.room_resource_id,rr.name AS room_name,g.capacity,
           g.break_even_members,g.status,g.starts_on,g.ends_on,g.schedule,
           g.version,
           count(gm.id) FILTER (
             WHERE gm.status IN ('TRIAL','ACTIVE','PAUSED') AND gm.reserved_place
           )::integer AS members,
           count(w.id) FILTER (WHERE w.status='WAITING')::integer AS waitlist
         FROM dance_group g
         JOIN dance_program p
           ON p.tenant_id=g.tenant_id AND p.id=g.program_id
         LEFT JOIN service_resource tr
           ON tr.tenant_id=g.tenant_id AND tr.id=g.trainer_resource_id
         LEFT JOIN service_resource rr
           ON rr.tenant_id=g.tenant_id AND rr.id=g.room_resource_id
         LEFT JOIN dance_group_member gm
           ON gm.tenant_id=g.tenant_id AND gm.group_id=g.id
         LEFT JOIN dance_group_waitlist w
           ON w.tenant_id=g.tenant_id AND w.group_id=g.id
         WHERE g.tenant_id=$1 AND g.status<>'ARCHIVED'
           AND (
             $2::uuid[] IS NULL
             OR tr.membership_id = ANY($2::uuid[])
           )
         GROUP BY g.id,p.name,p.service_id,tr.name,rr.name
         ORDER BY p.name,g.name`,
        [context.tenantId,scopeIds]
      );
      return result.rows;
    });
  }

  async createGroup(
    context: TenantContext,
    input: {
      programId: string;
      name: string;
      branchId?: string;
      trainerResourceId: string;
      roomResourceId?: string;
      capacity: number;
      breakEvenMembers?: number;
      startsOn?: string;
      endsOn?: string;
      schedule?: Array<{
        weekday: number;
        startMinute: number;
        durationMinutes?: number;
      }>;
    }
  ) {
    await this.requireAll(context,"dance.write");
    const name=input.name?.trim();
    if(!name||name.length>180) throw new BadRequestException("Некорректное название группы");
    const capacity=Math.floor(input.capacity);
    const breakEven=Math.floor(input.breakEvenMembers ?? 1);
    if(capacity<1||capacity>500||breakEven<1||breakEven>capacity)
      throw new BadRequestException("Некорректная вместимость группы");
    const schedule=this.normalizeSchedule(input.schedule ?? []);
    if(input.startsOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn))
      throw new BadRequestException("Некорректная дата старта");
    if(input.endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn))
      throw new BadRequestException("Некорректная дата окончания");

    return this.database.withTenantTransaction(context,async client=>{
      const program=await client.query(
        `SELECT id,branch_id,service_id FROM dance_program
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,input.programId]
      );
      const pr=program.rows[0];
      if(!pr) throw new NotFoundException("Направление не найдено");
      if(!pr.service_id) throw new ConflictException("У направления не настроена услуга");

      await this.assertTrainerRoom(
        client,
        context.tenantId,
        input.trainerResourceId,
        input.roomResourceId ?? null
      );

      const result=await client.query(
        `INSERT INTO dance_group(
           tenant_id,program_id,branch_id,name,trainer_resource_id,
           room_resource_id,capacity,break_even_members,starts_on,ends_on,
           schedule
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id,name,version`,
        [
          context.tenantId,input.programId,input.branchId??pr.branch_id??null,
          name,input.trainerResourceId,input.roomResourceId??null,
          capacity,breakEven,input.startsOn??new Date().toISOString().slice(0,10),
          input.endsOn??null,JSON.stringify(schedule)
        ]
      );
      return result.rows[0];
    });
  }

  async groupMembers(
    context:TenantContext,
    groupId:string
  ){
    const scopeIds=await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertGroupAccess(
        client,context.tenantId,groupId,scopeIds,false
      );
      const result=await client.query(
        `SELECT
           gm.id,gm.student_id,p.display_name AS student_name,
           s.birth_date,s.training_level,s.status AS student_status,
           gm.status,gm.joined_at,gm.left_at,gm.reserved_place,
           gm.discount_bps,
           payer.id AS payer_party_id,payer.display_name AS payer_name
         FROM dance_group_member gm
         JOIN dance_student s
           ON s.tenant_id=gm.tenant_id AND s.id=gm.student_id
         JOIN party p
           ON p.tenant_id=s.tenant_id AND p.id=s.party_id
         LEFT JOIN LATERAL (
           SELECT pp.id,pp.display_name
           FROM party_relationship rel
           JOIN party pp
             ON pp.tenant_id=rel.tenant_id AND pp.id=rel.to_party_id
           WHERE rel.tenant_id=s.tenant_id
             AND rel.from_party_id=s.party_id
             AND rel.relation_type='PAYER'
             AND (rel.ends_on IS NULL OR rel.ends_on>=current_date)
           ORDER BY rel.is_primary DESC,rel.created_at
           LIMIT 1
         ) payer ON true
         WHERE gm.tenant_id=$1 AND gm.group_id=$2
         ORDER BY
           CASE gm.status
             WHEN 'ACTIVE' THEN 0
             WHEN 'TRIAL' THEN 1
             WHEN 'PAUSED' THEN 2
             WHEN 'WAITLIST' THEN 3
             ELSE 4
           END,
           p.display_name`,
        [context.tenantId,groupId]
      );

      const waitlist=await client.query(
        `SELECT
           w.id,w.student_id,p.display_name AS student_name,
           w.priority,w.status,w.offered_at,w.offer_expires_at,w.created_at
         FROM dance_group_waitlist w
         JOIN dance_student s
           ON s.tenant_id=w.tenant_id AND s.id=w.student_id
         JOIN party p
           ON p.tenant_id=s.tenant_id AND p.id=s.party_id
         WHERE w.tenant_id=$1 AND w.group_id=$2
           AND w.status IN ('WAITING','OFFERED')
         ORDER BY w.priority,w.created_at`,
        [context.tenantId,groupId]
      );

      return {members:result.rows,waitlist:waitlist.rows};
    });
  }

  async addGroupMember(
    context: TenantContext,
    groupId: string,
    input: {
      studentId: string;
      status?: "TRIAL" | "ACTIVE";
      discountBps?: number;
      allowWaitlist?: boolean;
      overrideEligibility?: boolean;
      overrideReason?: string;
    }
  ) {
    const scopeIds=await this.scopeIds(context,"dance.write");
    return this.database.withTenantTransaction(context,async client=>{
      const group=await this.assertGroupAccess(
        client,context.tenantId,groupId,scopeIds,true
      );
      const student=await this.assertStudentAccess(
        client,context.tenantId,input.studentId,scopeIds
      );
      await this.assertStudentEligibility(
        client,
        context.tenantId,
        group.program_id,
        student.id,
        Boolean(input.overrideEligibility),
        input.overrideReason
      );

      const occupied=await client.query<{count:number}>(
        `SELECT count(*)::integer AS count
         FROM dance_group_member
         WHERE tenant_id=$1 AND group_id=$2
           AND status IN ('TRIAL','ACTIVE','PAUSED')
           AND reserved_place`,
        [context.tenantId,groupId]
      );
      const count=occupied.rows[0]?.count??0;
      if(count>=group.capacity){
        if(!input.allowWaitlist)
          throw new ConflictException("В группе нет свободных мест");
        const wait=await client.query(
          `INSERT INTO dance_group_waitlist(
             tenant_id,group_id,student_id,status
           ) VALUES($1,$2,$3,'WAITING')
           ON CONFLICT(tenant_id,group_id,student_id)
           DO UPDATE SET status='WAITING',updated_at=now()
           RETURNING id,status`,
          [context.tenantId,groupId,input.studentId]
        );
        return {waitlisted:true,...wait.rows[0]};
      }

      const discount=Math.floor(input.discountBps??0);
      if(discount<0||discount>10000) throw new BadRequestException("Некорректная скидка");
      const member=await client.query(
        `INSERT INTO dance_group_member(
           tenant_id,group_id,student_id,status,reserved_place,discount_bps
         ) VALUES($1,$2,$3,$4,true,$5)
         ON CONFLICT(tenant_id,group_id,student_id)
         DO UPDATE SET
           status=EXCLUDED.status,reserved_place=true,
           discount_bps=EXCLUDED.discount_bps,left_at=NULL,updated_at=now()
         RETURNING id,status`,
        [
          context.tenantId,groupId,input.studentId,
          input.status??"ACTIVE",discount
        ]
      );
      await client.query(
        "UPDATE dance_student SET status='ACTIVE',joined_at=coalesce(joined_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,input.studentId]
      );
      return {waitlisted:false,...member.rows[0]};
    });
  }

  async lessons(
    context: TenantContext,
    input: { from?: string; to?: string }
  ) {
    const scopeIds=await this.scopeIds(context,"dance.read");
    const from=input.from?new Date(input.from):new Date(Date.now()-7*86400000);
    const to=input.to?new Date(input.to):new Date(Date.now()+31*86400000);
    if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<=from||
       to.getTime()-from.getTime()>180*86400000)
      throw new BadRequestException("Некорректный период уроков");

    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           l.id,l.group_id,g.name AS group_name,p.name AS program_name,
           l.lesson_type,l.starts_at,l.ends_at,l.capacity,l.status,
           l.trainer_resource_id,tr.name AS trainer_name,
           l.room_resource_id,rr.name AS room_name,l.version,
           count(lp.id) FILTER (
             WHERE lp.status NOT IN ('WAITLIST','CANCELLED_IN_TIME')
           )::integer AS booked_count,
           count(lp.id) FILTER (
             WHERE lp.status IN ('ATTENDED','LATE')
           )::integer AS attended_count,
           count(lp.id) FILTER (WHERE lp.status='WAITLIST')::integer AS waitlist,
           prof.earned_revenue_minor::text,prof.trainer_cost_minor::text,
           prof.room_cost_minor::text,prof.contribution_margin_minor::text
         FROM dance_lesson l
         LEFT JOIN dance_group g
           ON g.tenant_id=l.tenant_id AND g.id=l.group_id
         LEFT JOIN dance_program p
           ON p.tenant_id=g.tenant_id AND p.id=g.program_id
         LEFT JOIN service_resource tr
           ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
         LEFT JOIN service_resource rr
           ON rr.tenant_id=l.tenant_id AND rr.id=l.room_resource_id
         LEFT JOIN dance_lesson_participant lp
           ON lp.tenant_id=l.tenant_id AND lp.lesson_id=l.id
         LEFT JOIN dance_lesson_profitability prof
           ON prof.tenant_id=l.tenant_id AND prof.lesson_id=l.id
         WHERE l.tenant_id=$1 AND l.starts_at>=$2 AND l.starts_at<$3
           AND (
             $4::uuid[] IS NULL
             OR tr.membership_id = ANY($4::uuid[])
           )
         GROUP BY l.id,g.name,p.name,tr.name,rr.name,prof.id
         ORDER BY l.starts_at`,
        [context.tenantId,from,to,scopeIds]
      );
      return result.rows;
    });
  }

  async createLesson(
    context: TenantContext,
    input: {
      groupId?: string;
      lessonType?: LessonType;
      serviceId?: string;
      trainerResourceId?: string;
      roomResourceId?: string;
      startsAt: string;
      durationMinutes?: number;
      capacity?: number;
      idempotencyKey: string;
    }
  ) {
    const scopeIds=await this.scopeIds(context,"dance.write");
    return this.database.withTenantTransaction(context,async client=>
      this.createLessonTx(client,context,scopeIds,input)
    );
  }

  async generateGroupLessons(
    context: TenantContext,
    groupId: string,
    input: { from: string; to: string }
  ) {
    const scopeIds=await this.scopeIds(context,"dance.write");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.from)||
       !/^\d{4}-\d{2}-\d{2}$/.test(input.to)||
       input.from>input.to)
      throw new BadRequestException("Некорректный период генерации");

    const source=await this.database.withTenantTransaction(context,async client=>{
      const group=await this.assertGroupAccess(
        client,context.tenantId,groupId,scopeIds,false
      );
      const timezoneRow=await client.query<{timezone:string}>(
        `SELECT coalesce(rr.timezone,tr.timezone,'Europe/Moscow') AS timezone
         FROM dance_group g
         LEFT JOIN service_resource rr
           ON rr.tenant_id=g.tenant_id AND rr.id=g.room_resource_id
         LEFT JOIN service_resource tr
           ON tr.tenant_id=g.tenant_id AND tr.id=g.trainer_resource_id
         WHERE g.tenant_id=$1 AND g.id=$2`,
        [context.tenantId,groupId]
      );
      const slots=await client.query<{starts_at:Date;duration_minutes:number}>(
        `SELECT
           (
             d::date
             + make_interval(mins => (s->>'startMinute')::int)
           ) AT TIME ZONE $4 AS starts_at,
           coalesce((s->>'durationMinutes')::int,$5::int) AS duration_minutes
         FROM generate_series($1::date,$2::date,interval '1 day') d
         CROSS JOIN jsonb_array_elements($3::jsonb) s
         WHERE extract(isodow from d)::int=(s->>'weekday')::int
         ORDER BY starts_at`,
        [
          input.from,input.to,JSON.stringify(group.schedule??[]),
          timezoneRow.rows[0]?.timezone??"Europe/Moscow",
          group.default_duration_minutes
        ]
      );
      return {slots:slots.rows};
    });

    const created:Array<Record<string,unknown>>=[];
    const skipped:Array<{startsAt:string;reason:string}>=[];
    for(const slot of source.slots){
      const startsAt=slot.starts_at.toISOString();
      try{
        created.push(await this.createLesson(context,{
          groupId,
          startsAt,
          durationMinutes:slot.duration_minutes,
          idempotencyKey:"group:"+groupId+":"+startsAt
        }));
      }catch(error){
        if(error instanceof ConflictException){
          skipped.push({
            startsAt,
            reason:error.message
          });
          continue;
        }
        throw error;
      }
    }
    return {created,skipped};
  }

  async participants(context:TenantContext,lessonId:string){
    const scopeIds=await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertLessonAccess(client,context.tenantId,lessonId,scopeIds,false);
      const result=await client.query(
        `SELECT
           lp.id,lp.student_id,p.display_name AS student_name,lp.package_id,
           lp.status,lp.price_source,lp.charge_minor::text,lp.currency,
           lp.attendance_marked_at,lp.version,
           sp.expires_at,sp.visit_limit_snapshot,sp.reserved_visits,sp.used_visits,
           plan.name AS package_name
         FROM dance_lesson_participant lp
         JOIN dance_student s
           ON s.tenant_id=lp.tenant_id AND s.id=lp.student_id
         JOIN party p
           ON p.tenant_id=s.tenant_id AND p.id=s.party_id
         LEFT JOIN service_package sp
           ON sp.tenant_id=lp.tenant_id AND sp.id=lp.package_id
         LEFT JOIN service_package_plan plan
           ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
         WHERE lp.tenant_id=$1 AND lp.lesson_id=$2
         ORDER BY p.display_name`,
        [context.tenantId,lessonId]
      );
      return result.rows;
    });
  }

  async addParticipant(
    context:TenantContext,
    lessonId:string,
    input:{
      studentId:string;
      packageId?:string;
      chargeMinor?:string;
      allowWaitlist?:boolean;
    }
  ){
    const scopeIds=await this.scopeIds(context,"dance.write");
    const charge=String(input.chargeMinor??"0");
    if(!/^\d+$/.test(charge)) throw new BadRequestException("Некорректная стоимость");

    return this.database.withTenantTransaction(context,async client=>{
      const lesson=await this.assertLessonAccess(
        client,context.tenantId,lessonId,scopeIds,true
      );
      if(!["PLANNED","OPEN_FOR_BOOKING"].includes(lesson.status)||
         lesson.attendance_locked_at)
        throw new ConflictException("Урок закрыт для записи");

      const student=await this.assertStudentAccess(
        client,context.tenantId,input.studentId,scopeIds
      );
      if(lesson.group_id){
        await this.assertStudentEligibility(
          client,context.tenantId,lesson.program_id,input.studentId,false
        );
      }

      const existing=await client.query(
        `SELECT id,status FROM dance_lesson_participant
         WHERE tenant_id=$1 AND lesson_id=$2 AND student_id=$3`,
        [context.tenantId,lessonId,input.studentId]
      );
      if(existing.rows[0]) return existing.rows[0];

      const occupied=await client.query<{count:number}>(
        `SELECT count(*)::integer AS count
         FROM dance_lesson_participant
         WHERE tenant_id=$1 AND lesson_id=$2
           AND status NOT IN ('WAITLIST','CANCELLED_IN_TIME')`,
        [context.tenantId,lessonId]
      );
      if((occupied.rows[0]?.count??0)>=lesson.capacity){
        if(!input.allowWaitlist) throw new ConflictException("В уроке нет свободных мест");
        const wait=await client.query(
          `INSERT INTO dance_lesson_participant(
             tenant_id,lesson_id,student_id,status,price_source,charge_minor
           ) VALUES($1,$2,$3,'WAITLIST','DIRECT',0)
           RETURNING id,status,version`,
          [context.tenantId,lessonId,input.studentId]
        );
        return wait.rows[0];
      }

      let priceSource:"PACKAGE"|"DIRECT"="DIRECT";
      if(input.packageId) priceSource="PACKAGE";
      const row=await client.query(
        `INSERT INTO dance_lesson_participant(
           tenant_id,lesson_id,student_id,package_id,status,
           price_source,charge_minor,currency
         ) VALUES($1,$2,$3,$4,'BOOKED',$5,$6,$7)
         RETURNING id,status,version`,
        [
          context.tenantId,lessonId,input.studentId,input.packageId??null,
          priceSource,charge,lesson.currency
        ]
      );
      const participant=row.rows[0];
      if(!participant) throw new Error("DANCE_PARTICIPANT_CREATE_FAILED");

      if(input.packageId){
        await this.reserveDancePackage(
          client,context.tenantId,input.packageId,participant.id,
          student.party_id,lesson
        );
      } else if (BigInt(charge) > 0n) {
        const payerId=await this.defaultPayer(
          client,context.tenantId,student.party_id
        );
        await this.createLessonChargeTx(client,context,{
          studentId:input.studentId,
          payerPartyId:payerId,
          lessonId,
          amountMinor:charge,
          dueAt:new Date(lesson.starts_at)
        });
      }

      return participant;
    });
  }

  async markAttendance(
    context:TenantContext,
    lessonId:string,
    participantId:string,
    input:{
      status:"BOOKED"|"ATTENDED"|"LATE"|"NO_SHOW"|"EXCUSED_ABSENCE"|"CANCELLED_IN_TIME"|"CANCELLED_LATE";
      version:number;
    }
  ){
    const scopeIds=await this.scopeIds(context,"dance.write");
    return this.database.withTenantTransaction(context,async client=>{
      const lesson=await this.assertLessonAccess(
        client,context.tenantId,lessonId,scopeIds,true
      );
      if(lesson.attendance_locked_at||lesson.status==="COMPLETED")
        throw new ConflictException("Посещаемость уже закрыта");
      const result=await client.query(
        `UPDATE dance_lesson_participant
         SET status=$4,version=version+1,
             attendance_marked_by_membership_id=$5,
             attendance_marked_at=CASE WHEN $4='BOOKED' THEN NULL ELSE now() END,
             updated_at=now()
         WHERE tenant_id=$1 AND lesson_id=$2 AND id=$3 AND version=$6
         RETURNING id,status,version`,
        [
          context.tenantId,lessonId,participantId,input.status,
          context.membershipId,input.version
        ]
      );
      if(!result.rows[0]) throw new ConflictException("Участник уже изменён");
      return result.rows[0];
    });
  }

  async addPackageBeneficiary(
    context:TenantContext,
    packageId:string,
    input:{studentId:string}
  ){
    const scopeIds=await this.scopeIds(context,"dance.write");
    return this.database.withTenantTransaction(context,async client=>{
      const pack=await client.query<{
        payer_party_id:string|null;
        party_id:string;
        package_kind_snapshot:string;
        family_eligible:boolean;
      }>(
        `SELECT
           sp.payer_party_id,sp.party_id,sp.package_kind_snapshot,
           plan.family_eligible
         FROM service_package sp
         JOIN service_package_plan plan
           ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
         JOIN party owner
           ON owner.tenant_id=sp.tenant_id AND owner.id=sp.party_id
         WHERE sp.tenant_id=$1 AND sp.id=$2
           AND sp.status IN ('PENDING_PAYMENT','ACTIVE')
           AND (
             $3::uuid[] IS NULL
             OR owner.responsible_membership_id = ANY($3::uuid[])
           )
         FOR UPDATE OF sp`,
        [context.tenantId,packageId,scopeIds]
      );
      const row=pack.rows[0];
      if(!row) throw new NotFoundException("Абонемент не найден");
      if(row.package_kind_snapshot!=="FAMILY"&&!row.family_eligible)
        throw new ConflictException("Тариф не разрешает семейных бенефициаров");

      const student=await this.assertStudentAccess(
        client,context.tenantId,input.studentId,scopeIds
      );
      const payer=row.payer_party_id??row.party_id;
      if(student.party_id!==row.party_id){
        const relation=await client.query(
          `SELECT 1 FROM party_relationship
           WHERE tenant_id=$1 AND from_party_id=$2 AND to_party_id=$3
             AND relation_type IN ('PAYER','PARENT','GUARDIAN','FAMILY_MEMBER')
             AND (ends_on IS NULL OR ends_on>=current_date)`,
          [context.tenantId,student.party_id,payer]
        );
        if(!relation.rowCount)
          throw new ConflictException(
            "Ученик не связан с плательщиком семейного абонемента"
          );
      }

      const result=await client.query(
        `INSERT INTO service_package_beneficiary(
           tenant_id,package_id,party_id,status,created_by_membership_id
         ) VALUES($1,$2,$3,'ACTIVE',$4)
         ON CONFLICT(tenant_id,package_id,party_id)
         DO UPDATE SET status='ACTIVE',updated_at=now()
         RETURNING id,party_id,status`,
        [context.tenantId,packageId,student.party_id,context.membershipId]
      );
      return result.rows[0];
    });
  }

  async freezePackage(
    context:TenantContext,
    packageId:string,
    input:{startsOn:string;endsOn:string;reason?:string}
  ){
    const scopeIds=await this.scopeIds(context,"dance.write");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)||
       !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn)||
       input.startsOn>input.endsOn)
      throw new BadRequestException("Некорректный период заморозки");

    return this.database.withTenantTransaction(context,async client=>{
      const pack=await client.query<{
        party_id:string;
        freeze_days_total_snapshot:number;
        freeze_days_used:number;
        status:string;
      }>(
        `SELECT party_id,freeze_days_total_snapshot,freeze_days_used,status
         FROM service_package
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,packageId]
      );
      const row=pack.rows[0];
      if(!row||row.status!=="ACTIVE")
        throw new NotFoundException("Активный абонемент не найден");

      if(scopeIds){
        const party=await client.query(
          `SELECT 1 FROM party
           WHERE tenant_id=$1 AND id=$2
             AND responsible_membership_id=ANY($3::uuid[])`,
          [context.tenantId,row.party_id,scopeIds]
        );
        if(!party.rowCount) throw new NotFoundException("Абонемент не найден");
      }

      const overlap=await client.query(
        `SELECT 1 FROM service_package_freeze
         WHERE tenant_id=$1 AND package_id=$2 AND status='APPLIED'
           AND daterange(starts_on,ends_on,'[]') &&
               daterange($3::date,$4::date,'[]')`,
        [context.tenantId,packageId,input.startsOn,input.endsOn]
      );
      if(overlap.rowCount) throw new ConflictException("Периоды заморозки пересекаются");

      const daysResult=await client.query<{days:number}>(
        "SELECT ($2::date-$1::date+1)::integer AS days",
        [input.startsOn,input.endsOn]
      );
      const days=daysResult.rows[0]?.days??0;
      if(row.freeze_days_used+days>row.freeze_days_total_snapshot)
        throw new ConflictException("Лимит дней заморозки превышен");

      const freeze=await client.query(
        `INSERT INTO service_package_freeze(
           tenant_id,package_id,starts_on,ends_on,applied_days,reason,
           created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,applied_days`,
        [
          context.tenantId,packageId,input.startsOn,input.endsOn,days,
          input.reason?.trim()||null,context.membershipId
        ]
      );
      await client.query(
        `UPDATE service_package
         SET freeze_days_used=freeze_days_used+$3,
             expires_at=expires_at+make_interval(days=>$3),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,packageId,days]
      );
      return freeze.rows[0];
    });
  }

  private async createLessonTx(
    client:PoolClient,
    context:TenantContext,
    scopeIds:string[]|null,
    input:{
      groupId?:string;
      lessonType?:LessonType;
      serviceId?:string;
      trainerResourceId?:string;
      roomResourceId?:string;
      startsAt:string;
      durationMinutes?:number;
      capacity?:number;
      idempotencyKey:string;
    }
  ){
    const key=input.idempotencyKey?.trim();
    if(!key||key.length<8||key.length>160)
      throw new BadRequestException("Некорректный ключ идемпотентности");
    const startsAt=new Date(input.startsAt);
    if(Number.isNaN(startsAt.getTime())) throw new BadRequestException("Некорректное время урока");

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
      [context.tenantId,"dance:"+key]
    );
    const existing=await client.query(
      `SELECT l.id,l.version,l.status
       FROM dance_lesson l
       JOIN service_booking b
         ON b.tenant_id=l.tenant_id AND b.id=l.host_booking_id
       WHERE l.tenant_id=$1 AND b.idempotency_key=$2`,
      [context.tenantId,"dance:"+key]
    );
    if(existing.rows[0]) return existing.rows[0];

    let group:any=null;
    if(input.groupId){
      group=await this.assertGroupAccess(
        client,context.tenantId,input.groupId,scopeIds,false
      );
    }

    const serviceId=input.serviceId??group?.service_id;
    const trainerId=input.trainerResourceId??group?.trainer_resource_id;
    const roomId=input.roomResourceId??group?.room_resource_id??null;
    const capacity=Math.floor(input.capacity??group?.capacity??1);
    const lessonType=input.lessonType??(group?"GROUP":"INDIVIDUAL");
    if(!serviceId||!trainerId) throw new BadRequestException("Укажите услугу и тренера");
    if(capacity<1||capacity>500) throw new BadRequestException("Некорректная вместимость");

    const service=await client.query<{
      duration_minutes:number;
      buffer_before_minutes:number;
      buffer_after_minutes:number;
      price_minor:string;
      currency:string;
    }>(
      `SELECT duration_minutes,buffer_before_minutes,buffer_after_minutes,
              price_minor::text,currency
       FROM service_catalog_item
       WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
      [context.tenantId,serviceId]
    );
    const sr=service.rows[0];
    if(!sr) throw new NotFoundException("Услуга не найдена");
    const duration=Math.floor(input.durationMinutes??sr.duration_minutes);
    if(duration<5||duration>1440) throw new BadRequestException("Некорректная длительность");
    const endsAt=new Date(startsAt.getTime()+duration*60000);

    const resources=Array.from(new Set([trainerId,roomId].filter(Boolean) as string[])).sort();
    const resourceRows=await client.query<{
      id:string;type:string;name:string;membership_id:string|null;
    }>(
      `SELECT id,type,name,membership_id
       FROM service_resource
       WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE'
       ORDER BY id
       FOR UPDATE`,
      [context.tenantId,resources]
    );
    if(resourceRows.rowCount!==resources.length)
      throw new NotFoundException("Тренер или зал не найден");
    const trainer=resourceRows.rows.find(r=>r.id===trainerId);
    if(!trainer||trainer.type!=="EMPLOYEE")
      throw new BadRequestException("Тренер должен быть ресурсом EMPLOYEE");
    if(scopeIds && (!trainer.membership_id||!scopeIds.includes(trainer.membership_id)))
      throw new ForbiddenException("Тренер вне доступной области");
    if(roomId){
      const room=resourceRows.rows.find(r=>r.id===roomId);
      if(!room||!["ROOM","HALL","WORKPLACE"].includes(room.type))
        throw new BadRequestException("Зал должен быть ресурсом ROOM/HALL");
    }

    const blocked=await client.query(
      `SELECT r.name
       FROM service_resource r
       WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[])
         AND (
           EXISTS (
             SELECT 1
             FROM service_resource_block rb
             WHERE rb.tenant_id=r.tenant_id AND rb.resource_id=r.id
               AND rb.starts_at < $4 AND rb.ends_at > $3
           )
           OR EXISTS (
             SELECT 1
             FROM service_booking_resource br
             JOIN service_booking b
               ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
             WHERE br.tenant_id=r.tenant_id AND br.resource_id=r.id
               AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
               AND b.starts_at < $4 + make_interval(mins=>$6)
               AND b.ends_at > $3 - make_interval(mins=>$5)
           )
         )`,
      [
        context.tenantId,resources,startsAt,endsAt,
        sr.buffer_before_minutes,sr.buffer_after_minutes
      ]
    );
    if(blocked.rowCount)
      throw new ConflictException("Конфликт расписания: "+blocked.rows[0].name);

    const number=await this.nextNumber(client,context.tenantId,"service_booking","BOOK");
    const booking=await client.query<{id:string;version:number}>(
      `INSERT INTO service_booking(
         tenant_id,business_number,party_id,service_id,branch_id,
         status,source,starts_at,ends_at,price_minor_snapshot,currency,
         duration_minutes_snapshot,buffer_before_minutes_snapshot,
         buffer_after_minutes_snapshot,notes,idempotency_key,
         created_by_membership_id
       ) VALUES(
         $1,$2,NULL,$3,$4,'CONFIRMED','API',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
       )
       RETURNING id,version`,
      [
        context.tenantId,number,serviceId,group?.branch_id??null,
        startsAt,endsAt,sr.price_minor,sr.currency,duration,
        sr.buffer_before_minutes,sr.buffer_after_minutes,
        group?"Групповое занятие: "+group.name:"Занятие студии",
        "dance:"+key,context.membershipId
      ]
    );
    const br=booking.rows[0];
    if(!br) throw new Error("DANCE_HOST_BOOKING_CREATE_FAILED");
    for(const resourceId of resources){
      await client.query(
        `INSERT INTO service_booking_resource(
           tenant_id,booking_id,resource_id,capacity_units
         ) VALUES($1,$2,$3,1)`,
        [context.tenantId,br.id,resourceId]
      );
    }

    const lesson=await client.query(
      `INSERT INTO dance_lesson(
         tenant_id,group_id,host_booking_id,lesson_type,
         trainer_resource_id,room_resource_id,starts_at,ends_at,
         capacity,status,currency,created_by_membership_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN_FOR_BOOKING',$10,$11)
       RETURNING id,status,version`,
      [
        context.tenantId,input.groupId??null,br.id,lessonType,trainerId,
        roomId,startsAt,endsAt,capacity,sr.currency,context.membershipId
      ]
    );
    const row=lesson.rows[0];
    if(!row) throw new Error("DANCE_LESSON_CREATE_FAILED");
    await this.audit(client,context,"dance.lesson_created","dance_lesson",row.id,{
      groupId:input.groupId??null,
      startsAt:startsAt.toISOString(),
      trainerResourceId:trainerId,
      roomResourceId:roomId
    });
    return row;
  }

  private async defaultPayer(
    client:PoolClient,
    tenantId:string,
    studentPartyId:string
  ):Promise<string>{
    const result=await client.query<{id:string}>(
      `SELECT p.id
       FROM party_relationship r
       JOIN party p
         ON p.tenant_id=r.tenant_id AND p.id=r.to_party_id
       WHERE r.tenant_id=$1 AND r.from_party_id=$2
         AND r.relation_type='PAYER'
         AND (r.ends_on IS NULL OR r.ends_on>=current_date)
       ORDER BY r.is_primary DESC,r.created_at
       LIMIT 1`,
      [tenantId,studentPartyId]
    );
    return result.rows[0]?.id??studentPartyId;
  }

  private async createLessonChargeTx(
    client:PoolClient,
    context:TenantContext,
    input:{
      studentId:string;
      payerPartyId:string;
      lessonId:string;
      amountMinor:string;
      dueAt:Date;
    }
  ):Promise<void>{
    const existing=await client.query(
      `SELECT id FROM dance_student_charge
       WHERE tenant_id=$1 AND student_id=$2
         AND source_type='LESSON' AND source_id=$3
         AND status<>'CANCELLED'`,
      [context.tenantId,input.studentId,input.lessonId]
    );
    if(existing.rowCount) return;

    const charge=await client.query<{id:string}>(
      `INSERT INTO dance_student_charge(
         tenant_id,student_id,payer_party_id,source_type,source_id,
         currency,amount_minor,due_at,created_by_membership_id
       ) VALUES($1,$2,$3,'LESSON',$4,'RUB',$5,$6,$7)
       RETURNING id`,
      [
        context.tenantId,input.studentId,input.payerPartyId,input.lessonId,
        input.amountMinor,input.dueAt,context.membershipId
      ]
    );
    const chargeId=charge.rows[0]?.id;
    if(!chargeId) throw new Error("DANCE_LESSON_CHARGE_CREATE_FAILED");

    const obligation=await client.query<{id:string}>(
      `INSERT INTO financial_obligation(
         tenant_id,direction,party_id,source_type,source_id,
         currency,amount_minor,due_at
       ) VALUES(
         $1,'RECEIVABLE',$2,'DANCE_STUDENT_CHARGE',$3,'RUB',$4,$5
       )
       RETURNING id`,
      [
        context.tenantId,input.payerPartyId,chargeId,
        input.amountMinor,input.dueAt
      ]
    );
    const obligationId=obligation.rows[0]?.id;
    if(!obligationId) throw new Error("DANCE_LESSON_OBLIGATION_CREATE_FAILED");

    const number=await this.nextNumber(
      client,context.tenantId,"finance_invoice","INV"
    );
    const invoice=await client.query<{id:string}>(
      `INSERT INTO finance_invoice(
         tenant_id,business_number,party_id,source_type,source_id,
         obligation_id,currency,amount_minor,due_at,created_by_membership_id
       ) VALUES(
         $1,$2,$3,'DANCE_STUDENT_CHARGE',$4,$5,'RUB',$6,$7,$8
       )
       RETURNING id`,
      [
        context.tenantId,number,input.payerPartyId,chargeId,obligationId,
        input.amountMinor,input.dueAt,context.membershipId
      ]
    );
    const invoiceId=invoice.rows[0]?.id;
    if(!invoiceId) throw new Error("DANCE_LESSON_INVOICE_CREATE_FAILED");

    await client.query(
      `UPDATE dance_student_charge
       SET obligation_id=$3,invoice_id=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId,chargeId,obligationId,invoiceId]
    );
  }

  private async reserveDancePackage(
    client:PoolClient,
    tenantId:string,
    packageId:string,
    participantId:string,
    studentPartyId:string,
    lesson:any
  ){
    const result=await client.query<{
      party_id:string;
      starts_at:Date;
      expires_at:Date;
      visit_limit_snapshot:number|null;
      reserved_visits:number;
      used_visits:number;
      dance_program_id_snapshot:string|null;
      dance_group_id_snapshot:string|null;
      applicable_service_id:string|null;
      activation_policy_snapshot:"FULL_PAYMENT"|"IMMEDIATE"|"PROPORTIONAL"|"GRACE_PERIOD";
      allowed_debt_minor_snapshot:string;
      price_minor_snapshot:string;
    }>(
      `SELECT
         sp.party_id,sp.starts_at,sp.expires_at,sp.visit_limit_snapshot,
         sp.reserved_visits,sp.used_visits,sp.dance_program_id_snapshot,
         sp.dance_group_id_snapshot,plan.applicable_service_id,
         sp.activation_policy_snapshot,sp.allowed_debt_minor_snapshot::text,
         sp.price_minor_snapshot::text
       FROM service_package sp
       JOIN service_package_plan plan
         ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
       WHERE sp.tenant_id=$1 AND sp.id=$2 AND sp.status='ACTIVE'
       FOR UPDATE OF sp`,
      [tenantId,packageId]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Активный абонемент не найден");

    if(row.party_id!==studentPartyId){
      const beneficiary=await client.query(
        `SELECT 1 FROM service_package_beneficiary
         WHERE tenant_id=$1 AND package_id=$2 AND party_id=$3
           AND status='ACTIVE'`,
        [tenantId,packageId,studentPartyId]
      );
      if(!beneficiary.rowCount)
        throw new ConflictException("Ученик не является бенефициаром абонемента");
    }

    if(lesson.starts_at<row.starts_at||lesson.starts_at>=row.expires_at)
      throw new ConflictException("Урок вне срока действия абонемента");

    const frozen=await client.query(
      `SELECT 1 FROM service_package_freeze
       WHERE tenant_id=$1 AND package_id=$2 AND status='APPLIED'
         AND $3::date BETWEEN starts_on AND ends_on`,
      [tenantId,packageId,lesson.starts_at]
    );
    if(frozen.rowCount) throw new ConflictException("Абонемент заморожен на дату урока");

    if(row.dance_program_id_snapshot&&row.dance_program_id_snapshot!==lesson.program_id)
      throw new ConflictException("Абонемент не действует на это направление");
    if(row.dance_group_id_snapshot&&row.dance_group_id_snapshot!==lesson.group_id)
      throw new ConflictException("Абонемент не действует на эту группу");
    if(row.applicable_service_id&&row.applicable_service_id!==lesson.service_id)
      throw new ConflictException("Абонемент не действует на эту услугу");

    const charge=await client.query<{
      amount_minor:string;
      settled_minor:string;
      due_at:Date|null;
    }>(
      `SELECT c.amount_minor::text,
              coalesce(o.settled_minor,0)::text AS settled_minor,
              o.due_at
       FROM dance_student_charge c
       JOIN financial_obligation o
         ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
       WHERE c.tenant_id=$1
         AND c.source_type='PACKAGE'
         AND c.source_id=$2
         AND c.status<>'CANCELLED'
       LIMIT 1
       FOR UPDATE OF o`,
      [tenantId,packageId]
    );
    const chargeRow=charge.rows[0];
    if(chargeRow){
      const total=BigInt(chargeRow.amount_minor);
      const settled=BigInt(chargeRow.settled_minor);
      const remaining=total-settled;

      if(
        row.activation_policy_snapshot==="PROPORTIONAL" &&
        row.visit_limit_snapshot!==null &&
        total>0n
      ){
        const allowedVisits=Number(
          BigInt(row.visit_limit_snapshot)*settled/total
        );
        if(row.reserved_visits+row.used_visits>=allowedVisits){
          throw new ConflictException(
            "Оплаченной части абонемента недостаточно для следующего посещения"
          );
        }
      }

      if(
        row.activation_policy_snapshot==="GRACE_PERIOD" &&
        chargeRow.due_at &&
        new Date(chargeRow.due_at).getTime()<Date.now() &&
        remaining>BigInt(row.allowed_debt_minor_snapshot)
      ){
        throw new ConflictException(
          "Просроченная задолженность превышает разрешённый лимит"
        );
      }
    }

    if(row.visit_limit_snapshot!==null&&
       row.reserved_visits+row.used_visits>=row.visit_limit_snapshot)
      throw new ConflictException("В абонементе закончились посещения");

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
         WHERE tenant_id=$1 AND package_id=$2
           AND (lesson_type IS NULL OR lesson_type=$3)
           AND (dance_program_id IS NULL OR dance_program_id=$4)
           AND (dance_group_id IS NULL OR dance_group_id=$5)
         ORDER BY
           (
             CASE WHEN lesson_type IS NULL THEN 0 ELSE 1 END +
             CASE WHEN dance_program_id IS NULL THEN 0 ELSE 2 END +
             CASE WHEN dance_group_id IS NULL THEN 0 ELSE 4 END
           ) DESC,
           priority,id
         LIMIT 1
         FOR UPDATE`,
        [
          tenantId,packageId,lesson.lesson_type,
          lesson.program_id??null,lesson.group_id??null
        ]
      );
      const bucket=entitlement.rows[0];
      if(!bucket)
        throw new ConflictException("Абонемент не содержит подходящей квоты");
      if(
        bucket.visit_limit_snapshot!==null &&
        bucket.reserved_visits+bucket.used_visits>=bucket.visit_limit_snapshot
      ){
        throw new ConflictException("Квота этого типа занятий исчерпана");
      }
      entitlementId=bucket.id;
      await client.query(
        `UPDATE service_package_entitlement
         SET reserved_visits=reserved_visits+1
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId,entitlementId]
      );
    }

    await client.query(
      "UPDATE service_package SET reserved_visits=reserved_visits+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId,packageId]
    );
    await client.query(
      `INSERT INTO dance_package_redemption(
         tenant_id,package_id,participant_id,package_entitlement_id,state
       ) VALUES($1,$2,$3,$4,'RESERVED')`,
      [tenantId,packageId,participantId,entitlementId]
    );
  }

  private async assertLessonAccess(
    client:PoolClient,
    tenantId:string,
    lessonId:string,
    scopeIds:string[]|null,
    lock:boolean
  ):Promise<any>{
    const result=await client.query(
      `SELECT
         l.*,g.program_id,
         coalesce(p.service_id,b.service_id) AS service_id,
         p.default_duration_minutes,
         tr.membership_id AS trainer_membership_id
       FROM dance_lesson l
       LEFT JOIN dance_group g
         ON g.tenant_id=l.tenant_id AND g.id=l.group_id
       LEFT JOIN dance_program p
         ON p.tenant_id=g.tenant_id AND p.id=g.program_id
       LEFT JOIN service_booking b
         ON b.tenant_id=l.tenant_id AND b.id=l.host_booking_id
       LEFT JOIN service_resource tr
         ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
       WHERE l.tenant_id=$1 AND l.id=$2
         AND (
           $3::uuid[] IS NULL
           OR tr.membership_id = ANY($3::uuid[])
         )
       ${lock?"FOR UPDATE OF l":""}`,
      [tenantId,lessonId,scopeIds]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Урок не найден");
    return row;
  }

  private async assertGroupAccess(
    client:PoolClient,
    tenantId:string,
    groupId:string,
    scopeIds:string[]|null,
    lock:boolean
  ):Promise<any>{
    const result=await client.query(
      `SELECT
         g.*,p.service_id,p.default_duration_minutes,p.min_age,p.max_age,
         tr.membership_id AS trainer_membership_id
       FROM dance_group g
       JOIN dance_program p
         ON p.tenant_id=g.tenant_id AND p.id=g.program_id
       LEFT JOIN service_resource tr
         ON tr.tenant_id=g.tenant_id AND tr.id=g.trainer_resource_id
       WHERE g.tenant_id=$1 AND g.id=$2 AND g.status<>'ARCHIVED'
         AND (
           $3::uuid[] IS NULL
           OR tr.membership_id = ANY($3::uuid[])
         )
       ${lock?"FOR UPDATE OF g":""}`,
      [tenantId,groupId,scopeIds]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Группа не найдена");
    return row;
  }

  private async assertStudentAccess(
    client:PoolClient,
    tenantId:string,
    studentId:string,
    scopeIds:string[]|null
  ):Promise<{id:string;party_id:string;birth_date:string|null}>{
    const result=await client.query(
      `SELECT s.id,s.party_id,s.birth_date::text
       FROM dance_student s
       JOIN party p
         ON p.tenant_id=s.tenant_id AND p.id=s.party_id
       WHERE s.tenant_id=$1 AND s.id=$2 AND s.status<>'ARCHIVED'
         AND (
           $3::uuid[] IS NULL
           OR p.responsible_membership_id = ANY($3::uuid[])
           OR EXISTS (
             SELECT 1
             FROM dance_lesson_participant lp
             JOIN dance_lesson l
               ON l.tenant_id=lp.tenant_id AND l.id=lp.lesson_id
             JOIN service_resource tr
               ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
             WHERE lp.tenant_id=s.tenant_id
               AND lp.student_id=s.id
               AND tr.membership_id = ANY($3::uuid[])
           )
         )`,
      [tenantId,studentId,scopeIds]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Ученик не найден");
    return row;
  }

  private async assertStudentEligibility(
    client:PoolClient,
    tenantId:string,
    programId:string,
    studentId:string,
    override:boolean,
    reason?:string
  ){
    const result=await client.query<{
      birth_date:string|null;min_age:number|null;max_age:number|null;
    }>(
      `SELECT s.birth_date::text,p.min_age,p.max_age
       FROM dance_student s
       JOIN dance_program p
         ON p.tenant_id=s.tenant_id AND p.id=$3
       WHERE s.tenant_id=$1 AND s.id=$2`,
      [tenantId,studentId,programId]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Ученик или направление не найдено");
    if(!row.birth_date|| (row.min_age===null&&row.max_age===null)) return;
    const ageResult=await client.query<{age:number}>(
      "SELECT date_part('year',age(current_date,$1::date))::integer AS age",
      [row.birth_date]
    );
    const age=ageResult.rows[0]?.age??0;
    const invalid=(row.min_age!==null&&age<row.min_age)||(row.max_age!==null&&age>row.max_age);
    if(!invalid) return;
    if(!override) throw new ConflictException("Возраст ученика не соответствует группе");
    if(!reason?.trim()||reason.trim().length<8)
      throw new BadRequestException("Для исключения укажите причину");
  }

  private async assertTrainerRoom(
    client:PoolClient,
    tenantId:string,
    trainerId:string,
    roomId:string|null
  ){
    const trainer=await client.query<{type:string}>(
      "SELECT type FROM service_resource WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
      [tenantId,trainerId]
    );
    if(trainer.rows[0]?.type!=="EMPLOYEE")
      throw new BadRequestException("Тренер должен быть ресурсом EMPLOYEE");
    if(roomId){
      const room=await client.query<{type:string}>(
        "SELECT type FROM service_resource WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [tenantId,roomId]
      );
      if(!room.rows[0]||!["ROOM","HALL","WORKPLACE"].includes(room.rows[0].type))
        throw new BadRequestException("Некорректный зал");
    }
  }

  private normalizeSchedule(
    schedule:Array<{weekday:number;startMinute:number;durationMinutes?:number}>
  ){
    if(schedule.length>21) throw new BadRequestException("Слишком сложное недельное расписание");
    const seen=new Set<string>();
    return schedule.map(item=>{
      const weekday=Math.floor(item.weekday);
      const startMinute=Math.floor(item.startMinute);
      const durationMinutes=item.durationMinutes===undefined?undefined:Math.floor(item.durationMinutes);
      if(weekday<1||weekday>7||startMinute<0||startMinute>1439||
         (durationMinutes!==undefined&&(durationMinutes<15||durationMinutes>360)))
        throw new BadRequestException("Некорректное расписание группы");
      const key=weekday+":"+startMinute;
      if(seen.has(key)) throw new BadRequestException("Дублирующий слот расписания");
      seen.add(key);
      return {weekday,startMinute,durationMinutes};
    });
  }

  private async upsertRelationshipTx(
    client:PoolClient,
    context:TenantContext,
    fromPartyId:string,
    toPartyId:string,
    relationType:string,
    isPrimary:boolean
  ){
    const target=await client.query(
      "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
      [context.tenantId,toPartyId]
    );
    if(!target.rowCount) throw new NotFoundException("Связанное лицо не найдено");
    if(isPrimary){
      await client.query(
        `UPDATE party_relationship
         SET is_primary=false
         WHERE tenant_id=$1 AND from_party_id=$2
           AND relation_type=$3
           AND (ends_on IS NULL OR ends_on>=current_date)`,
        [context.tenantId,fromPartyId,relationType]
      );
    }
    await client.query(
      `INSERT INTO party_relationship(
         tenant_id,from_party_id,to_party_id,relation_type,is_primary
       ) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(tenant_id,from_party_id,to_party_id,relation_type,starts_on)
       DO UPDATE SET is_primary=EXCLUDED.is_primary,ends_on=NULL`,
      [context.tenantId,fromPartyId,toPartyId,relationType,isPrimary]
    );
  }

  private async scopeIds(
    context:TenantContext,
    permission:DanceScopePermission
  ):Promise<string[]|null>{
    const scope=await this.authorization.resolveScope(context,permission);
    if(!scope) throw new ForbiddenException("Недостаточно прав");
    return this.authorization.membershipIdsForScope(context,scope);
  }

  private async requireAll(context:TenantContext,permission:DanceScopePermission){
    const scope=await this.authorization.resolveScope(context,permission);
    if(scope!=="all") throw new ForbiddenException("Операция доступна только руководителю студии");
  }

  private async nextNumber(
    client:PoolClient,
    tenantId:string,
    key:string,
    prefix:string
  ){
    const result=await client.query<{value:string}>(
      `INSERT INTO tenant_counter(tenant_id,counter_key,value)
       VALUES($1,$2,1)
       ON CONFLICT(tenant_id,counter_key)
       DO UPDATE SET value=tenant_counter.value+1,updated_at=now()
       RETURNING value::text`,
      [tenantId,key]
    );
    const value=BigInt(result.rows[0]?.value??"0");
    return prefix+"-"+new Date().getUTCFullYear()+"-"+value.toString().padStart(6,"0");
  }

  private async audit(
    client:PoolClient,
    context:TenantContext,
    action:string,
    resourceType:string,
    resourceId:string,
    afterData?:Record<string,unknown>
  ){
    await client.query(
      `INSERT INTO audit_event(
         tenant_id,actor_user_id,actor_membership_id,
         action,resource_type,resource_id,after_data
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,context.userId,context.membershipId,
        action,resourceType,resourceId,
        afterData?JSON.stringify(afterData):null
      ]
    );
  }
}
