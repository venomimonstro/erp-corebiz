import {ForbiddenException,Injectable} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../../platform/authorization/authorization.service";

type Risk={
  code:string;label:string;count:number;severity:"critical"|"warning";
  href:string;explanation:string;
};

/** Read-only operational checks; financial details are never returned to trainers. */
@Injectable()
export class DanceOperationsService {
  constructor(
    private readonly database:DatabaseService,
    private readonly authorization:AuthorizationService
  ) {}

  async health(context:TenantContext){
    const scope=await this.authorization.resolveScope(context,"dance.read");
    if(!scope)throw new ForbiddenException("Нет доступа к студии");
    const scopeIds=await this.authorization.membershipIdsForScope(context,scope);
    const canViewFinance=Boolean(
      await this.authorization.resolveScope(context,"finance.read")
    );
    return this.database.withTenantTransaction(context,async client=>{
      const [lessons,groups,redemptions,makeup]=await Promise.all([
        client.query<{
          overbooked:number;closed_open_roster:number;no_profit:number;
        }>(
          `SELECT
            count(*) FILTER (WHERE stats.taken>l.capacity)::integer AS overbooked,
            count(*) FILTER (WHERE l.status='COMPLETED' AND stats.unmarked>0)
              ::integer AS closed_open_roster,
            count(*) FILTER (WHERE l.status='COMPLETED' AND prof.id IS NULL)
              ::integer AS no_profit
           FROM dance_lesson l
           LEFT JOIN service_resource tr ON tr.tenant_id=l.tenant_id
             AND tr.id=l.trainer_resource_id
           LEFT JOIN LATERAL(
             SELECT count(*) FILTER (WHERE lp.status NOT IN
                 ('WAITLIST','CANCELLED_IN_TIME'))::integer AS taken,
               count(*) FILTER (WHERE lp.status='BOOKED')::integer AS unmarked
             FROM dance_lesson_participant lp
             WHERE lp.tenant_id=l.tenant_id AND lp.lesson_id=l.id
           ) stats ON true
           LEFT JOIN dance_lesson_profitability prof
             ON prof.tenant_id=l.tenant_id AND prof.lesson_id=l.id
           WHERE l.tenant_id=$1 AND l.starts_at>=now()-interval '180 days'
             AND ($2::uuid[] IS NULL OR tr.membership_id=ANY($2::uuid[])
               OR (l.trainer_resource_id IS NULL AND
                 l.created_by_membership_id=ANY($2::uuid[])))`,
          [context.tenantId,scopeIds]),
        client.query<{overbooked:number}>(`SELECT count(*)::integer AS overbooked
          FROM dance_group g LEFT JOIN service_resource tr
            ON tr.tenant_id=g.tenant_id AND tr.id=g.trainer_resource_id
          WHERE g.tenant_id=$1 AND g.status IN ('ACTIVE','PAUSED')
            AND ($2::uuid[] IS NULL OR tr.membership_id=ANY($2::uuid[]))
            AND (SELECT count(*) FROM dance_group_member gm
              WHERE gm.tenant_id=g.tenant_id AND gm.group_id=g.id
                AND gm.reserved_place AND gm.status IN
                  ('TRIAL','ACTIVE','PAUSED')) > g.capacity`,
          [context.tenantId,scopeIds]),
        client.query<{stranded:number}>(`SELECT count(*)::integer AS stranded
          FROM dance_package_redemption r
          JOIN dance_lesson_participant lp ON lp.tenant_id=r.tenant_id
            AND lp.id=r.participant_id
          JOIN dance_lesson l ON l.tenant_id=lp.tenant_id
            AND l.id=lp.lesson_id
          LEFT JOIN service_resource tr ON tr.tenant_id=l.tenant_id
            AND tr.id=l.trainer_resource_id
          WHERE r.tenant_id=$1 AND r.state='RESERVED'
            AND l.starts_at>=now()-interval '180 days'
            AND ($2::uuid[] IS NULL OR tr.membership_id=ANY($2::uuid[])
              OR (l.trainer_resource_id IS NULL AND
                l.created_by_membership_id=ANY($2::uuid[])))
            AND (lp.status IN ('WAITLIST','CANCELLED_IN_TIME')
              OR l.status IN ('CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER','COMPLETED'))`,
          [context.tenantId,scopeIds]),
        client.query<{stranded:number}>(`SELECT count(*)::integer AS stranded
          FROM dance_makeup_credit mc
          JOIN dance_lesson_participant lp ON lp.tenant_id=mc.tenant_id
            AND lp.id=mc.reserved_participant_id
          JOIN dance_lesson l ON l.tenant_id=lp.tenant_id
            AND l.id=lp.lesson_id
          LEFT JOIN service_resource tr ON tr.tenant_id=l.tenant_id
            AND tr.id=l.trainer_resource_id
          WHERE mc.tenant_id=$1 AND mc.status='RESERVED'
            AND l.starts_at>=now()-interval '180 days'
            AND ($2::uuid[] IS NULL OR tr.membership_id=ANY($2::uuid[])
              OR (l.trainer_resource_id IS NULL AND
                l.created_by_membership_id=ANY($2::uuid[])))
            AND (lp.status IN ('WAITLIST','CANCELLED_IN_TIME')
              OR l.status IN ('CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER','COMPLETED'))`,
          [context.tenantId,scopeIds])
      ]);
      const errors:Risk[]=[];
      const add=(code:string,label:string,count:number,severity:Risk["severity"],
        href:string,explanation:string)=>{
        if(count>0)errors.push({code,label,count,severity,href,explanation});
      };
      add("OVERBOOKED_LESSONS","Уроки сверх вместимости",
        lessons.rows[0]?.overbooked??0,"critical","/app/dance/groups",
        "Проверьте переносы и импорт: занято больше мест, чем рассчитано на урок");
      add("OVERBOOKED_GROUPS","Группы сверх вместимости",
        groups.rows[0]?.overbooked??0,"critical","/app/dance/groups",
        "Проверьте активные места, паузы и лист ожидания");
      add("UNRESOLVED_CLOSED","Завершённые уроки с неотмеченными учениками",
        lessons.rows[0]?.closed_open_roster??0,"critical","/app/dance/groups",
        "Закрытый урок содержит записи без окончательного статуса посещения");
      add("STRANDED_PACKAGES","Резервы абонементов после отмены или закрытия",
        redemptions.rows[0]?.stranded??0,"critical","/app/dance/students",
        "Проверка требуется до возврата посещений или нового списания");
      add("STRANDED_MAKEUPS","Зависшие права на отработку",
        makeup.rows[0]?.stranded??0,"critical","/app/dance/students",
        "Право числится зарезервированным в отменённом или закрытом занятии");
      add("MISSING_PROFITABILITY","Закрытые уроки без снимка экономики",
        lessons.rows[0]?.no_profit??0,"warning","/app/dance/team",
        "Проверьте проведение занятия и фиксацию финансовых результатов");
      if(canViewFinance){
        const [billing,reviews]=await Promise.all([
          client.query<{unlinked:number}>(`SELECT count(*)::integer AS unlinked
            FROM dance_student_charge c
            JOIN dance_student s ON s.tenant_id=c.tenant_id AND s.id=c.student_id
            JOIN party p ON p.tenant_id=s.tenant_id AND p.id=s.party_id
            WHERE c.tenant_id=$1 AND c.status<>'CANCELLED'
              AND (c.obligation_id IS NULL OR c.invoice_id IS NULL)
              AND ($2::uuid[] IS NULL OR p.responsible_membership_id=ANY($2::uuid[]))`,
            [context.tenantId,scopeIds]),
          client.query<{disputes:number}>(`SELECT count(*)::integer AS disputes
            FROM payroll_statement_review pr
            JOIN trainer_payroll_statement st ON st.tenant_id=pr.tenant_id
              AND st.id=pr.statement_id AND pr.statement_kind='DANCE_TRAINER'
            JOIN service_resource tr ON tr.tenant_id=st.tenant_id
              AND tr.id=st.trainer_resource_id
            WHERE pr.tenant_id=$1 AND pr.review_status='DISPUTED'
              AND ($2::uuid[] IS NULL OR tr.membership_id=ANY($2::uuid[]))`,
            [context.tenantId,scopeIds])
        ]);
        add("UNLINKED_CHARGES","Начисления без расчётных документов",
          billing.rows[0]?.unlinked??0,"critical","/app/dance/students",
          "Нельзя считать оплату корректной до сверки счёта и обязательства");
        add("PAYROLL_DISPUTES","Неразрешённые споры по зарплате",
          reviews.rows[0]?.disputes??0,"warning","/app/dance/team",
          "Закройте разногласия до утверждения и выплаты");
      }
      errors.sort((a,b)=>Number(b.severity==="critical")-
        Number(a.severity==="critical")||b.count-a.count);
      return {
        status:errors.some(x=>x.severity==="critical")?"ACTION_REQUIRED":
          errors.length?"REVIEW":"HEALTHY",
        checkedAt:new Date().toISOString(),canViewFinance,
        totalIssues:errors.reduce((sum,x)=>sum+x.count,0),
        risks:errors
      };
    });
  }
}
