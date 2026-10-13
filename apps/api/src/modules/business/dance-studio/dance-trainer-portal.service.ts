import {BadRequestException,ConflictException,ForbiddenException,Injectable,NotFoundException} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../../platform/authorization/authorization.service";
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
@Injectable()
export class DanceTrainerPortalService{
  constructor(private readonly database:DatabaseService,
    private readonly authorization:AuthorizationService){}

  async link(context:TenantContext,input:{membershipId:string;resourceId:string}){
    if(!uuid.test(input?.membershipId??"")||!uuid.test(input?.resourceId??""))
      throw new BadRequestException("Укажите логин и ресурс тренера");
    const [users,dance]=await Promise.all([
      this.authorization.resolveScope(context,"users.manage"),
      this.authorization.resolveScope(context,"dance.write")
    ]);
    if(users!=="all"||dance!=="all")
      throw new ForbiddenException("Назначение тренера доступно руководителю");
    return this.database.withTenantTransaction(context,async client=>{
      const account=await client.query(
        `SELECT 1 FROM tenant_membership m
         JOIN membership_role mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
         JOIN tenant_role r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
         WHERE m.tenant_id=$1 AND m.id=$2 AND m.status='ACTIVE'
           AND m.is_owner=false AND r.code='DANCE_TRAINER'
           AND NOT EXISTS(
             SELECT 1 FROM membership_role other WHERE other.tenant_id=m.tenant_id
               AND other.membership_id=m.id AND other.role_id<>mr.role_id
           )`,
        [context.tenantId,input.membershipId]
      );
      if(!account.rowCount)throw new ForbiddenException(
        "Логин должен иметь только роль «Тренер студии»"
      );
      const result=await client.query<{id:string}>(
        `UPDATE service_resource s SET membership_id=$3,updated_at=now()
         WHERE s.tenant_id=$1 AND s.id=$2 AND s.type='EMPLOYEE'
           AND s.status='ACTIVE' AND (s.membership_id IS NULL OR s.membership_id=$3)
           AND NOT EXISTS(
             SELECT 1 FROM service_resource other
             WHERE other.tenant_id=s.tenant_id AND other.id<>s.id
               AND other.status='ACTIVE' AND other.membership_id=$3
           )
         RETURNING s.id`,
        [context.tenantId,input.resourceId,input.membershipId]
      );
      if(!result.rows[0])throw new ConflictException(
        "Ресурс уже связан с другим логином или тренер привязан к другому ресурсу"
      );
      await client.query(
        `INSERT INTO audit_event(tenant_id,actor_user_id,actor_membership_id,
          action,resource_type,resource_id,after_data)
         VALUES($1,$2,$3,'dance.trainer_linked','service_resource',$4,
           jsonb_build_object('membershipId',$5::text))`,
        [context.tenantId,context.userId,context.membershipId,
          input.resourceId,input.membershipId]
      );
      return {linked:true,resourceId:input.resourceId};
    });
  }

  async self(context:TenantContext,from:string,to:string){
    const perm=await this.authorization.resolveScope(context,"dance.trainer.read");
    if(perm!=="own"&&perm!=="all")
      throw new ForbiddenException("Нет доступа к календарю тренера");
    if(!datePattern.test(from??"")||!datePattern.test(to??""))
      throw new BadRequestException("Укажите период YYYY-MM-DD");
    const fromTime=Date.parse(from+"T00:00:00Z");
    const toTime=Date.parse(to+"T00:00:00Z");
    const period=(toTime-fromTime)/86400000;
    if(!Number.isFinite(period)||period<1||period>92||
      new Date(fromTime).toISOString().slice(0,10)!==from||
      new Date(toTime).toISOString().slice(0,10)!==to)
      throw new BadRequestException("Интервал календаря: от 1 до 92 дней");
    return this.database.withTenantTransaction(context,async client=>{
      const res=await client.query<{id:string;name:string;timezone:string}>(
        `SELECT r.id,r.name,r.timezone FROM service_resource r
         JOIN tenant_membership m ON m.tenant_id=r.tenant_id
           AND m.id=r.membership_id AND m.status='ACTIVE'
         WHERE r.tenant_id=$1 AND r.membership_id=$2
           AND m.user_id=$3 AND r.type='EMPLOYEE' AND r.status='ACTIVE'
         LIMIT 1`,
        [context.tenantId,context.membershipId,context.userId]
      );
      const resource=res.rows[0];
      if(!resource)throw new ForbiddenException(
        "Логин тренера пока не привязан к рабочему ресурсу"
      );
      const lessons=await client.query(
        `SELECT l.id,l.lesson_type,l.status,l.starts_at,l.ends_at,
           g.name AS group_name,pr.name AS direction_name,
           room.name AS room_name,
           count(lp.id) FILTER (WHERE lp.status IN
             ('BOOKED','ATTENDED','LATE','NO_SHOW'))::int AS booked_count,
           count(lp.id) FILTER (WHERE lp.status IN
             ('ATTENDED','LATE'))::int AS attended_count
         FROM dance_lesson l
         LEFT JOIN dance_group g ON g.tenant_id=l.tenant_id AND g.id=l.group_id
         LEFT JOIN dance_program pr ON pr.tenant_id=g.tenant_id AND pr.id=g.program_id
         LEFT JOIN service_resource room ON room.tenant_id=l.tenant_id
           AND room.id=l.room_resource_id
         LEFT JOIN dance_lesson_participant lp ON lp.tenant_id=l.tenant_id
           AND lp.lesson_id=l.id
         WHERE l.tenant_id=$1 AND l.trainer_resource_id=$2
           AND l.starts_at>=($3::date::timestamp AT TIME ZONE $5)
           AND l.starts_at<($4::date::timestamp AT TIME ZONE $5)
         GROUP BY l.id,g.name,pr.name,room.name
         ORDER BY l.starts_at ASC LIMIT 400`,
        [context.tenantId,resource.id,from,to,resource.timezone]
      );
      // No attendees' identities, fees, internal pay rates, owner financial
      // ledgers or other coaches are part of the response.
      return {trainer:{id:resource.id,name:resource.name,timezone:resource.timezone},
        from,to,lessons:lessons.rows};
    });
  }
}
