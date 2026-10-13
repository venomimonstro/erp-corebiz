import {
  BadRequestException,ForbiddenException,Injectable,NotFoundException
} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../../platform/authorization/authorization.service";

const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** A parent sees only the party bound to their active login and its children.
 * Never accept a studentId, payerId or tenantId from customer GET requests.
 */
@Injectable()
export class DanceCustomerPortalService{
  constructor(
    private readonly database:DatabaseService,
    private readonly authorization:AuthorizationService
  ){}

  async link(context:TenantContext,input:{membershipId:string;partyId:string}){
    if(!input||!uuid.test(input.membershipId)||!uuid.test(input.partyId))
      throw new BadRequestException("Укажите пользователя и клиента");
    const [users,dance]=await Promise.all([
      this.authorization.resolveScope(context,"users.manage"),
      this.authorization.resolveScope(context,"dance.write")
    ]);
    if(users!=="all"||dance!=="all")
      throw new ForbiddenException("Привязка клиентов доступна руководителю");
    return this.database.withTenantTransaction(context,async client=>{
      const account=await client.query(
        `SELECT 1 FROM tenant_membership m
         JOIN membership_role mr ON mr.tenant_id=m.tenant_id
           AND mr.membership_id=m.id
         JOIN tenant_role r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
         WHERE m.tenant_id=$1 AND m.id=$2 AND m.status='ACTIVE'
           AND m.is_owner=false AND r.code='DANCE_CUSTOMER'
           AND NOT EXISTS(
             SELECT 1 FROM membership_role x
             WHERE x.tenant_id=m.tenant_id AND x.membership_id=m.id
               AND x.role_id<>mr.role_id
           )`,
        [context.tenantId,input.membershipId]
      );
      if(!account.rowCount)
        throw new ForbiddenException("У аккаунта нет изолированной роли клиента");
      const party=await client.query(
        "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,input.partyId]
      );
      if(!party.rowCount)throw new NotFoundException("Клиент не найден");
      const saved=await client.query<{id:string}>(
        `INSERT INTO dance_customer_account(
           tenant_id,membership_id,party_id,linked_by_membership_id
         ) VALUES($1,$2,$3,$4)
         ON CONFLICT(tenant_id,membership_id)
         DO UPDATE SET party_id=EXCLUDED.party_id,status='ACTIVE',
           linked_by_membership_id=EXCLUDED.linked_by_membership_id,
           updated_at=now()
         RETURNING id`,
        [context.tenantId,input.membershipId,input.partyId,context.membershipId]
      );
      await client.query(
        `INSERT INTO audit_event(tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data)
         VALUES($1,$2,$3,'dance.portal_linked','tenant_membership',$4,
                jsonb_build_object('partyId',$5::text))`,
        [context.tenantId,context.userId,context.membershipId,
          input.membershipId,input.partyId]
      );
      return {id:saved.rows[0]!.id,linked:true};
    });
  }

  private async requirePortalAdmin(context:TenantContext){
    const [users,dance]=await Promise.all([
      this.authorization.resolveScope(context,"users.manage"),
      this.authorization.resolveScope(context,"dance.write")
    ]);
    if(users!=="all"||dance!=="all")
      throw new ForbiddenException("Управление аккаунтами доступно руководителю");
  }

  async accounts(context:TenantContext){
    await this.requirePortalAdmin(context);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT a.membership_id,u.email,a.party_id,p.display_name,a.status
         FROM dance_customer_account a
         JOIN tenant_membership tm ON tm.tenant_id=a.tenant_id
           AND tm.id=a.membership_id
         JOIN app_user u ON u.id=tm.user_id
         JOIN party p ON p.tenant_id=a.tenant_id AND p.id=a.party_id
         WHERE a.tenant_id=$1 ORDER BY a.created_at DESC LIMIT 500`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async revoke(context:TenantContext,membershipId:string){
    if(!uuid.test(membershipId))
      throw new BadRequestException("Неверный идентификатор аккаунта");
    await this.requirePortalAdmin(context);
    return this.database.withTenantTransaction(context,async client=>{
      const updated=await client.query(
        `UPDATE dance_customer_account SET status='REVOKED',
           updated_at=now()
         WHERE tenant_id=$1 AND membership_id=$2 AND status='ACTIVE'
         RETURNING id`,[context.tenantId,membershipId]
      );
      if(!updated.rowCount)throw new NotFoundException("Аккаунт не привязан");
      await client.query(
        `INSERT INTO audit_event(tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id)
         VALUES($1,$2,$3,'dance.portal_revoked','tenant_membership',$4)`,
        [context.tenantId,context.userId,context.membershipId,membershipId]
      );
      return {revoked:true};
    });
  }

  async self(context:TenantContext){
    const scope=await this.authorization.resolveScope(context,"dance.portal.read");
    if(scope!=="own")throw new ForbiddenException("Нет доступа к кабинету");
    return this.database.withTenantTransaction(context,async client=>{
      // Fail closed even if an old staff session retained a portal grant.
      const identity=await client.query<{party_id:string;display_name:string}>(
        `SELECT a.party_id,p.display_name
         FROM dance_customer_account a
         JOIN party p ON p.tenant_id=a.tenant_id AND p.id=a.party_id
         JOIN tenant_membership m ON m.tenant_id=a.tenant_id
           AND m.id=a.membership_id
         JOIN membership_role mr ON mr.tenant_id=m.tenant_id
           AND mr.membership_id=m.id
         JOIN tenant_role r ON r.tenant_id=mr.tenant_id
           AND r.id=mr.role_id
         WHERE a.tenant_id=$1 AND a.membership_id=$2
           AND a.status='ACTIVE' AND p.status='ACTIVE'
           AND m.status='ACTIVE' AND m.user_id=$3
           AND r.code='DANCE_CUSTOMER'
           AND NOT EXISTS(
             SELECT 1 FROM membership_role another
             WHERE another.tenant_id=m.tenant_id AND
               another.membership_id=m.id AND another.role_id<>mr.role_id
           )`,
        [context.tenantId,context.membershipId,context.userId]
      );
      const person=identity.rows[0];
      if(!person)throw new ForbiddenException(
        "Кабинет клиента не привязан или доступ отозван"
      );
      const students=await client.query<{
        id:string;party_id:string;display_name:string;
        status:string;training_level:string|null
      }>(
        `SELECT s.id,s.party_id,p.display_name,s.status,s.training_level
         FROM dance_student s
         JOIN party p ON p.tenant_id=s.tenant_id AND p.id=s.party_id
         WHERE s.tenant_id=$1 AND s.status<>'ARCHIVED'
           AND (s.party_id=$2 OR EXISTS(
             SELECT 1 FROM party_relationship rel
             WHERE rel.tenant_id=s.tenant_id
               AND rel.from_party_id=s.party_id AND rel.to_party_id=$2
               AND rel.relation_type IN ('PARENT','GUARDIAN','PAYER')
               AND rel.starts_on<=current_date
               AND (rel.ends_on IS NULL OR rel.ends_on>=current_date)
           ))
         ORDER BY p.display_name LIMIT 100`,
        [context.tenantId,person.party_id]
      );
      const studentIds=students.rows.map(s=>s.id);
      const studentParties=students.rows.map(s=>s.party_id);
      // A customer can see only his/her own children and their associated
      // packages, not packages purchased for unrelated CRM contacts.
      const [groups,visits,packages,charges]=await Promise.all([
        client.query(
          `SELECT gm.student_id,g.id AS group_id,g.name AS group_name,
             dp.name AS program_name,tr.name AS trainer_name,
             gm.status AS enrollment_status
           FROM dance_group_member gm
           JOIN dance_group g ON g.tenant_id=gm.tenant_id AND g.id=gm.group_id
           JOIN dance_program dp ON dp.tenant_id=g.tenant_id AND dp.id=g.program_id
           LEFT JOIN service_resource tr ON tr.tenant_id=g.tenant_id
             AND tr.id=g.trainer_resource_id
           WHERE gm.tenant_id=$1 AND gm.student_id=ANY($2::uuid[])
             AND gm.status IN ('TRIAL','ACTIVE','PAUSED','WAITLIST')
           ORDER BY dp.name,g.name LIMIT 250`,
          [context.tenantId,studentIds]
        ),
        client.query(
          `SELECT lp.student_id,l.id AS lesson_id,l.starts_at,l.ends_at,
             l.status AS lesson_status,lp.status AS attendance_status,
             g.name AS group_name,dp.name AS program_name,
             tr.name AS trainer_name,room.name AS room_name
           FROM dance_lesson_participant lp
           JOIN dance_lesson l ON l.tenant_id=lp.tenant_id AND l.id=lp.lesson_id
           LEFT JOIN dance_group g ON g.tenant_id=l.tenant_id AND g.id=l.group_id
           LEFT JOIN dance_program dp ON dp.tenant_id=g.tenant_id AND dp.id=g.program_id
           LEFT JOIN service_resource tr ON tr.tenant_id=l.tenant_id
             AND tr.id=l.trainer_resource_id
           LEFT JOIN service_resource room ON room.tenant_id=l.tenant_id
             AND room.id=l.room_resource_id
           WHERE lp.tenant_id=$1 AND lp.student_id=ANY($2::uuid[])
           ORDER BY
             CASE WHEN l.starts_at>=now() THEN 0 ELSE 1 END,
             CASE WHEN l.starts_at>=now() THEN l.starts_at END ASC NULLS LAST,
             CASE WHEN l.starts_at<now() THEN l.starts_at END DESC NULLS LAST
           LIMIT 250`,
          [context.tenantId,studentIds]
        ),
        client.query(
          `SELECT DISTINCT sp.id,
             CASE WHEN sp.party_id=ANY($2::uuid[]) OR sp.party_id=$3
                  THEN sp.party_id ELSE NULL END AS party_id,
             plan.name AS plan_name,
             sp.status,sp.starts_at,sp.expires_at,
             sp.visit_limit_snapshot,sp.reserved_visits,sp.used_visits,
             CASE WHEN sp.status='ACTIVE' THEN
               GREATEST(0,sp.visit_limit_snapshot-sp.reserved_visits-sp.used_visits)
             ELSE 0 END AS available_visits
           ,ARRAY(
             SELECT b.party_id
             FROM service_package_beneficiary b
             WHERE b.tenant_id=sp.tenant_id AND b.package_id=sp.id
               AND b.status='ACTIVE' AND b.party_id=ANY($2::uuid[])
           ) AS beneficiary_party_ids
           FROM service_package sp
           JOIN service_package_plan plan
             ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
           WHERE sp.tenant_id=$1 AND (
             sp.party_id=ANY($2::uuid[])
             OR EXISTS(
               SELECT 1 FROM service_package_beneficiary b
               WHERE b.tenant_id=sp.tenant_id AND b.package_id=sp.id
                 AND b.status='ACTIVE' AND b.party_id=ANY($2::uuid[])
             )
             OR sp.party_id=$3
           )
           ORDER BY sp.expires_at DESC LIMIT 250`,
          [context.tenantId,studentParties,person.party_id]
        ),
        client.query(
          `SELECT c.student_id,c.id,c.amount_minor::text,
             CASE WHEN o.id IS NULL THEN NULL
               ELSE o.settled_minor::text END AS paid_minor,
             CASE WHEN o.id IS NULL THEN NULL
               ELSE (c.amount_minor-o.settled_minor)::text END
               AS remaining_minor,
             (o.id IS NOT NULL) AS finance_verified,
             c.currency,c.status,c.due_at
           FROM dance_student_charge c
           LEFT JOIN financial_obligation o
             ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
           WHERE c.tenant_id=$1 AND c.student_id=ANY($2::uuid[])
             AND (c.payer_party_id=$3 OR
               c.student_id IN (
                 SELECT id FROM dance_student WHERE tenant_id=$1
                   AND party_id=$3
               ))
             AND c.status<>'CANCELLED'
           ORDER BY c.created_at DESC LIMIT 250`,
          [context.tenantId,studentIds,person.party_id]
        )
      ]);
      return {
        person:{name:person.display_name,partyId:person.party_id},
        students:students.rows,
        groups:groups.rows,
        visits:visits.rows,
        packages:packages.rows,
        charges:charges.rows,
        limits:{maxRows:250},
        // The portal never exposes full business CRM, employee payroll
        // or other customers' invoices and payment instruments.
      };
    });
  }
}
