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

type DancePermission = "dance.read" | "dance.write";

@Injectable()
export class DanceEconomicsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async charges(context:TenantContext,studentId?:string){
    const scopeIds=await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           c.id,c.student_id,sp.display_name AS student_name,
           c.payer_party_id,pp.display_name AS payer_name,
           c.source_type,c.source_id,c.currency,c.amount_minor::text,
           c.due_at,c.status,c.note,c.obligation_id,c.invoice_id,
           coalesce(o.settled_minor,0)::text AS settled_minor,
           (c.amount_minor-coalesce(o.settled_minor,0))::text AS remaining_minor,
           i.business_number AS invoice_number
         FROM dance_student_charge c
         JOIN dance_student s
           ON s.tenant_id=c.tenant_id AND s.id=c.student_id
         JOIN party sp
           ON sp.tenant_id=s.tenant_id AND sp.id=s.party_id
         JOIN party pp
           ON pp.tenant_id=c.tenant_id AND pp.id=c.payer_party_id
         LEFT JOIN financial_obligation o
           ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
         LEFT JOIN finance_invoice i
           ON i.tenant_id=c.tenant_id AND i.id=c.invoice_id
         WHERE c.tenant_id=$1
           AND ($2::uuid IS NULL OR c.student_id=$2)
           AND (
             $3::uuid[] IS NULL
             OR sp.responsible_membership_id = ANY($3::uuid[])
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
           )
         ORDER BY c.due_at NULLS LAST,c.created_at DESC
         LIMIT 2000`,
        [context.tenantId,studentId??null,scopeIds]
      );
      return result.rows;
    });
  }

  async createCharge(
    context:TenantContext,
    studentId:string,
    input:{
      payerPartyId?:string;
      sourceType?:"PACKAGE"|"LESSON"|"INSTALLMENT"|"OTHER";
      sourceId?:string;
      amountMinor:string;
      dueAt?:string;
      note?:string;
    }
  ){
    const scopeIds=await this.scopeIds(context,"dance.write");
    if(!/^\d+$/.test(input.amountMinor)||BigInt(input.amountMinor)<=0n)
      throw new BadRequestException("Некорректная сумма начисления");
    const dueAt=input.dueAt?new Date(input.dueAt):null;
    if(dueAt&&Number.isNaN(dueAt.getTime()))
      throw new BadRequestException("Некорректный срок оплаты");

    return this.database.withTenantTransaction(context,async client=>{
      const student=await this.assertStudentAccess(
        client,context.tenantId,studentId,scopeIds
      );
      const payerId=input.payerPartyId ??
        await this.defaultPayer(client,context.tenantId,student.party_id);

      if(payerId!==student.party_id){
        const relation=await client.query(
          `SELECT 1 FROM party_relationship
           WHERE tenant_id=$1 AND from_party_id=$2 AND to_party_id=$3
             AND relation_type IN ('PAYER','PARENT','GUARDIAN')
             AND (ends_on IS NULL OR ends_on>=current_date)`,
          [context.tenantId,student.party_id,payerId]
        );
        if(!relation.rowCount)
          throw new ConflictException("Плательщик не связан с учеником");
      }

      return this.createChargeTx(client,context,{
        studentId,
        payerPartyId:payerId,
        sourceType:input.sourceType??"OTHER",
        sourceId:input.sourceId??null,
        amountMinor:input.amountMinor,
        dueAt,
        note:input.note
      });
    });
  }

  async compensationPlans(context:TenantContext){
    await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.id,p.trainer_resource_id,r.name AS trainer_name,p.lesson_type,
           p.calculation_type,p.fixed_minor::text,p.hourly_minor::text,
           p.percent_bps,p.per_attendee_minor::text,p.threshold_count,
           p.threshold_extra_minor::text,p.revenue_basis,p.priority,
           p.currency,p.valid_from,p.valid_to,p.status,p.metadata
         FROM trainer_compensation_plan p
         JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.trainer_resource_id
         WHERE p.tenant_id=$1 AND p.status='ACTIVE'
         ORDER BY r.name,p.priority,p.valid_from DESC`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createCompensationPlan(
    context:TenantContext,
    input:{
      trainerResourceId:string;
      lessonType?:string;
      calculationType:"FIXED"|"HOURLY"|"PERCENT"|"ATTENDEE"|"TIERED";
      fixedMinor?:string;
      hourlyMinor?:string;
      percentBps?:number;
      perAttendeeMinor?:string;
      thresholdCount?:number;
      thresholdExtraMinor?:string;
      revenueBasis?:"LIST"|"BILLED"|"PAID"|"EARNED";
      priority?:number;
      validFrom?:string;
      validTo?:string;
      metadata?:Record<string,unknown>;
    }
  ){
    await this.requireAll(context,"dance.write");
    const money=[
      input.fixedMinor??"0",
      input.hourlyMinor??"0",
      input.perAttendeeMinor??"0",
      input.thresholdExtraMinor??"0"
    ];
    if(money.some(v=>!/^\d+$/.test(v)))
      throw new BadRequestException("Некорректная денежная ставка");
    const percent=Math.floor(input.percentBps??0);
    if(percent<0||percent>10000) throw new BadRequestException("Некорректный процент");
    const priority=Math.floor(input.priority??100);
    const threshold=Math.floor(input.thresholdCount??0);
    if(priority<1||priority>100000||threshold<0||threshold>10000)
      throw new BadRequestException("Некорректные параметры правила");
    const from=input.validFrom??new Date().toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||
       (input.validTo&&!/^\d{4}-\d{2}-\d{2}$/.test(input.validTo)))
      throw new BadRequestException("Некорректный период правила");

    return this.database.withTenantTransaction(context,async client=>{
      const trainer=await client.query(
        "SELECT 1 FROM service_resource WHERE tenant_id=$1 AND id=$2 AND type='EMPLOYEE' AND status='ACTIVE'",
        [context.tenantId,input.trainerResourceId]
      );
      if(!trainer.rowCount) throw new NotFoundException("Тренер не найден");
      const row=await client.query(
        `INSERT INTO trainer_compensation_plan(
           tenant_id,trainer_resource_id,lesson_type,calculation_type,
           fixed_minor,hourly_minor,percent_bps,per_attendee_minor,
           threshold_count,threshold_extra_minor,revenue_basis,priority,
           valid_from,valid_to,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id,status`,
        [
          context.tenantId,input.trainerResourceId,input.lessonType??null,
          input.calculationType,input.fixedMinor??"0",input.hourlyMinor??"0",
          percent,input.perAttendeeMinor??"0",threshold,
          input.thresholdExtraMinor??"0",input.revenueBasis??"EARNED",
          priority,from,input.validTo??null,JSON.stringify(input.metadata??{})
        ]
      );
      return row.rows[0];
    });
  }

  async roomContracts(context:TenantContext){
    await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           c.id,c.room_resource_id,r.name AS room_name,
           c.counterparty_party_id,p.display_name AS counterparty_name,
           c.pricing_type,c.hourly_rate_minor::text,c.monthly_minor::text,
           c.slot_minor::text,c.minimum_billable_minutes,
           c.cancellation_charge_bps,c.payment_term_days,
           c.currency,c.valid_from,c.valid_to,
           c.status,c.metadata
         FROM room_rental_contract c
         JOIN service_resource r
           ON r.tenant_id=c.tenant_id AND r.id=c.room_resource_id
         LEFT JOIN party p
           ON p.tenant_id=c.tenant_id AND p.id=c.counterparty_party_id
         WHERE c.tenant_id=$1 AND c.status='ACTIVE'
         ORDER BY r.name,c.valid_from DESC`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createRoomContract(
    context:TenantContext,
    input:{
      roomResourceId:string;
      counterpartyPartyId?:string;
      pricingType:"HOURLY"|"FIXED_MONTHLY"|"FIXED_SLOT";
      hourlyRateMinor?:string;
      monthlyMinor?:string;
      slotMinor?:string;
      minimumBillableMinutes?:number;
      cancellationChargeBps?:number;
      paymentTermDays?:number;
      validFrom?:string;
      validTo?:string;
      metadata?:Record<string,unknown>;
    }
  ){
    await this.requireAll(context,"dance.write");
    const amounts=[
      input.hourlyRateMinor??"0",
      input.monthlyMinor??"0",
      input.slotMinor??"0"
    ];
    if(amounts.some(v=>!/^\d+$/.test(v)))
      throw new BadRequestException("Некорректная стоимость аренды");
    const minimum=Math.floor(input.minimumBillableMinutes??0);
    const cancelBps=Math.floor(input.cancellationChargeBps??0);
    const paymentTermDays=Math.floor(input.paymentTermDays??5);
    if(
      minimum<0||minimum>1440||
      cancelBps<0||cancelBps>10000||
      paymentTermDays<0||paymentTermDays>365
    ) {
      throw new BadRequestException("Некорректные условия аренды");
    }
    const from=input.validFrom??new Date().toISOString().slice(0,10);

    return this.database.withTenantTransaction(context,async client=>{
      const room=await client.query(
        `SELECT 1 FROM service_resource
         WHERE tenant_id=$1 AND id=$2 AND type IN ('ROOM','HALL','WORKPLACE')
           AND status='ACTIVE'`,
        [context.tenantId,input.roomResourceId]
      );
      if(!room.rowCount) throw new NotFoundException("Зал не найден");
      if(input.counterpartyPartyId){
        const party=await client.query(
          "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
          [context.tenantId,input.counterpartyPartyId]
        );
        if(!party.rowCount) throw new NotFoundException("Арендодатель не найден");
      }
      const row=await client.query(
        `INSERT INTO room_rental_contract(
           tenant_id,room_resource_id,counterparty_party_id,pricing_type,
           hourly_rate_minor,monthly_minor,slot_minor,minimum_billable_minutes,
           cancellation_charge_bps,payment_term_days,valid_from,valid_to,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id,status`,
        [
          context.tenantId,input.roomResourceId,input.counterpartyPartyId??null,
          input.pricingType,input.hourlyRateMinor??"0",input.monthlyMinor??"0",
          input.slotMinor??"0",minimum,cancelBps,paymentTermDays,
          from,input.validTo??null,JSON.stringify(input.metadata??{})
        ]
      );
      return row.rows[0];
    });
  }

  async completeLesson(context:TenantContext,lessonId:string){
    const scopeIds=await this.scopeIds(context,"dance.write");
    return this.database.withTenantTransaction(context,async client=>{
      const lesson=await this.lessonForUpdate(
        client,context.tenantId,lessonId,scopeIds
      );
      if(lesson.status==="COMPLETED"){
        const snapshot=await client.query(
          "SELECT * FROM dance_lesson_profitability WHERE tenant_id=$1 AND lesson_id=$2",
          [context.tenantId,lessonId]
        );
        return snapshot.rows[0]??{lessonId,status:"COMPLETED"};
      }
      if(["CANCELLED_BY_STUDIO","CANCELLED_BY_TRAINER"].includes(lesson.status))
        throw new ConflictException("Отменённый урок нельзя завершить");

      const unresolved=await client.query(
        `SELECT count(*)::integer AS count
         FROM dance_lesson_participant
         WHERE tenant_id=$1 AND lesson_id=$2 AND status='BOOKED'`,
        [context.tenantId,lessonId]
      );
      if((unresolved.rows[0]?.count??0)>0)
        throw new ConflictException("Сначала отметьте посещаемость всех записанных учеников");

      const participants=await client.query<{
        id:string;status:string;package_id:string|null;
        makeup_credit_id:string|null;charge_minor:string;
      }>(
        `SELECT id,status,package_id,makeup_credit_id,charge_minor::text
         FROM dance_lesson_participant
         WHERE tenant_id=$1 AND lesson_id=$2
         ORDER BY id
         FOR UPDATE`,
        [context.tenantId,lessonId]
      );

      let earnedRevenue=0n;
      let attendedCount=0;
      let bookedCount=0;
      for(const participant of participants.rows){
        if(!["WAITLIST","CANCELLED_IN_TIME"].includes(participant.status)) {
          bookedCount++;
        }
        if(["ATTENDED","LATE"].includes(participant.status)) attendedCount++;
        if(participant.makeup_credit_id){
          const credit=await client.query<{
            status:string;
            management_value_minor:string;
            reserved_participant_id:string|null;
          }>(
            `SELECT
               status,management_value_minor::text,reserved_participant_id
             FROM dance_makeup_credit
             WHERE tenant_id=$1 AND id=$2
             FOR UPDATE`,
            [context.tenantId,participant.makeup_credit_id]
          );
          const makeupCredit=credit.rows[0];
          if(
            !makeupCredit ||
            makeupCredit.status!=="RESERVED" ||
            makeupCredit.reserved_participant_id!==participant.id
          ){
            throw new ConflictException(
              "Нарушена целостность отработки"
            );
          }

          const consumeMakeup=[
            "ATTENDED","LATE","NO_SHOW","CANCELLED_LATE"
          ].includes(participant.status);

          if(consumeMakeup){
            const used=await client.query(
              `UPDATE dance_makeup_credit
               SET status='USED',reserved_participant_id=NULL,
                   used_participant_id=$3,updated_at=now()
               WHERE tenant_id=$1 AND id=$2
                 AND status='RESERVED'
                 AND reserved_participant_id=$3
               RETURNING id`,
              [context.tenantId,participant.makeup_credit_id,participant.id]
            );
            if(!used.rowCount){
              throw new ConflictException("Отработка уже была обработана");
            }
            earnedRevenue+=BigInt(makeupCredit.management_value_minor);
          }else{
            const released=await client.query(
              `UPDATE dance_makeup_credit
               SET status='AVAILABLE',reserved_participant_id=NULL,
                   updated_at=now()
               WHERE tenant_id=$1 AND id=$2
                 AND status='RESERVED'
                 AND reserved_participant_id=$3
               RETURNING id`,
              [context.tenantId,participant.makeup_credit_id,participant.id]
            );
            if(!released.rowCount){
              throw new ConflictException("Отработка уже была обработана");
            }
          }
          continue;
        }

        if(!participant.package_id){
          if(["ATTENDED","LATE","NO_SHOW","CANCELLED_LATE"].includes(participant.status)){
            earnedRevenue+=BigInt(participant.charge_minor);
          }
          continue;
        }

        const redemption=await client.query<{
          id:string;state:string;package_id:string;
          package_entitlement_id:string|null;
          no_show_policy:"RELEASE"|"CONSUME";
          allow_makeup:boolean;makeup_days_valid:number;
          visit_limit_snapshot:number|null;price_minor_snapshot:string;
          management_visit_value_minor:string;
        }>(
          `SELECT
             r.id,r.state,r.package_id,r.package_entitlement_id,
             plan.no_show_policy,plan.allow_makeup,plan.makeup_days_valid,
             sp.visit_limit_snapshot,sp.price_minor_snapshot::text,
             coalesce(
               pe.management_visit_value_minor_snapshot,
               plan.management_visit_value_minor
             )::text AS management_visit_value_minor
           FROM dance_package_redemption r
           JOIN service_package sp
             ON sp.tenant_id=r.tenant_id AND sp.id=r.package_id
           JOIN service_package_plan plan
             ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
           LEFT JOIN service_package_entitlement pe
             ON pe.tenant_id=r.tenant_id
            AND pe.id=r.package_entitlement_id
           WHERE r.tenant_id=$1 AND r.participant_id=$2
           FOR UPDATE OF r,sp`,
          [context.tenantId,participant.id]
        );
        const red=redemption.rows[0];
        if(!red||red.state!=="RESERVED") continue;

        const makeup=
          participant.status==="EXCUSED_ABSENCE"&&red.allow_makeup;
        const consume=
          ["ATTENDED","LATE"].includes(participant.status) ||
          (["NO_SHOW","CANCELLED_LATE"].includes(participant.status) &&
           red.no_show_policy==="CONSUME") ||
          makeup;

        if(consume){
          const update=await client.query(
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
            [context.tenantId,red.package_id]
          );
          if(!update.rowCount)
            throw new ConflictException("Нарушена целостность абонемента");
          if(red.package_entitlement_id){
            const bucket=await client.query(
              `UPDATE service_package_entitlement
               SET reserved_visits=reserved_visits-1,
                   used_visits=used_visits+1
               WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
               RETURNING id`,
              [context.tenantId,red.package_entitlement_id]
            );
            if(!bucket.rowCount)
              throw new ConflictException("Нарушена целостность квоты абонемента");
          }
          await client.query(
            "UPDATE dance_package_redemption SET state='CONSUMED',settled_at=now() WHERE tenant_id=$1 AND id=$2 AND state='RESERVED'",
            [context.tenantId,red.id]
          );

          let visitValue=BigInt(red.management_visit_value_minor);
          if(visitValue===0n&&red.visit_limit_snapshot){
            visitValue=
              BigInt(red.price_minor_snapshot)/BigInt(red.visit_limit_snapshot);
          }

          if(makeup){
            const days=Math.max(1,red.makeup_days_valid||14);
            await client.query(
              `INSERT INTO dance_makeup_credit(
                 tenant_id,student_id,source_lesson_id,source_participant_id,
                 expires_at,dance_program_id,management_value_minor,status
               )
               SELECT
                 $1,student_id,$2,id,$3,$4,$5,'AVAILABLE'
               FROM dance_lesson_participant
               WHERE tenant_id=$1 AND id=$6
               ON CONFLICT(tenant_id,source_participant_id)
               DO UPDATE SET
                 expires_at=EXCLUDED.expires_at,
                 dance_program_id=EXCLUDED.dance_program_id,
                 management_value_minor=EXCLUDED.management_value_minor,
                 updated_at=now()`,
              [
                context.tenantId,lessonId,
                new Date(new Date(lesson.ends_at).getTime()+days*86400000),
                lesson.program_id??null,
                visitValue.toString(),
                participant.id
              ]
            );
          }else{
            earnedRevenue+=visitValue;
          }
        }else{
          const update=await client.query(
            `UPDATE service_package
             SET reserved_visits=reserved_visits-1,updated_at=now()
             WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
             RETURNING id`,
            [context.tenantId,red.package_id]
          );
          if(!update.rowCount)
            throw new ConflictException("Нарушена целостность абонемента");
          if(red.package_entitlement_id){
            const bucket=await client.query(
              `UPDATE service_package_entitlement
               SET reserved_visits=reserved_visits-1
               WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
               RETURNING id`,
              [context.tenantId,red.package_entitlement_id]
            );
            if(!bucket.rowCount)
              throw new ConflictException("Нарушена целостность квоты абонемента");
          }
          await client.query(
            "UPDATE dance_package_redemption SET state='RELEASED',settled_at=now() WHERE tenant_id=$1 AND id=$2 AND state='RESERVED'",
            [context.tenantId,red.id]
          );
        }
      }

      const revenue=await this.lessonRevenueBases(
        client,context.tenantId,lesson,earnedRevenue,attendedCount
      );
      const trainer=await this.calculateTrainerCost(
        client,context.tenantId,lesson,attendedCount,revenue
      );
      const room=await this.calculateRoomCost(
        client,context.tenantId,lesson,false
      );
      const margin=earnedRevenue-trainer.amount-room.amount;

      const snapshot=await client.query(
        `INSERT INTO dance_lesson_profitability(
           tenant_id,lesson_id,booked_count,attended_count,
           earned_revenue_minor,trainer_cost_minor,room_cost_minor,
           other_cost_minor,contribution_margin_minor,currency,
           calculation_snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10)
         ON CONFLICT(tenant_id,lesson_id) DO NOTHING
         RETURNING *`,
        [
          context.tenantId,lessonId,bookedCount,attendedCount,
          earnedRevenue.toString(),trainer.amount.toString(),
          room.amount.toString(),margin.toString(),lesson.currency,
          JSON.stringify({
            trainer:trainer.snapshot,
            room:room.snapshot,
            revenue
          })
        ]
      );

      if(lesson.trainer_resource_id&&trainer.planId){
        await client.query(
          `INSERT INTO trainer_compensation_accrual(
             tenant_id,lesson_id,trainer_resource_id,plan_id,rule_snapshot,
             attended_count,eligible_revenue_minor,amount_minor,currency
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(tenant_id,lesson_id,trainer_resource_id) DO NOTHING`,
          [
            context.tenantId,lessonId,lesson.trainer_resource_id,trainer.planId,
            JSON.stringify(trainer.snapshot),attendedCount,
            trainer.eligibleRevenue.toString(),trainer.amount.toString(),
            lesson.currency
          ]
        );
      }

      await client.query(
        `UPDATE dance_lesson
         SET status='COMPLETED',attendance_locked_at=now(),
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,lessonId]
      );
      await client.query(
        `UPDATE service_booking
         SET status='COMPLETED',completed_at=now(),version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status<>'CANCELLED'`,
        [context.tenantId,lesson.host_booking_id]
      );

      await this.audit(client,context,"dance.lesson_completed","dance_lesson",lessonId,{
        attendedCount,
        earnedRevenueMinor:earnedRevenue.toString(),
        trainerCostMinor:trainer.amount.toString(),
        roomCostMinor:room.amount.toString(),
        marginMinor:margin.toString()
      });
      return snapshot.rows[0]??{
        lesson_id:lessonId,
        attended_count:attendedCount,
        earned_revenue_minor:earnedRevenue.toString(),
        trainer_cost_minor:trainer.amount.toString(),
        room_cost_minor:room.amount.toString(),
        contribution_margin_minor:margin.toString()
      };
    });
  }

  async cancelLesson(
    context:TenantContext,
    lessonId:string,
    input:{byTrainer?:boolean;reason:string}
  ){
    const scopeIds=await this.scopeIds(context,"dance.write");
    if(!input.reason?.trim()||input.reason.trim().length<5)
      throw new BadRequestException("Укажите причину отмены");

    return this.database.withTenantTransaction(context,async client=>{
      const lesson=await this.lessonForUpdate(
        client,context.tenantId,lessonId,scopeIds
      );
      if(lesson.status==="COMPLETED")
        throw new ConflictException("Завершённый урок нельзя отменить");
      if(["CANCELLED_BY_STUDIO","CANCELLED_BY_TRAINER"].includes(lesson.status))
        return {status:lesson.status,changed:false};

      const completedAttendance=await client.query(
        `SELECT 1
         FROM dance_lesson_participant
         WHERE tenant_id=$1 AND lesson_id=$2
           AND status IN ('ATTENDED','LATE')
         LIMIT 1`,
        [context.tenantId,lessonId]
      );
      if(completedAttendance.rowCount) {
        throw new ConflictException(
          "Нельзя отменить урок после фиксации посещения; используйте корректирующую операцию"
        );
      }

      const redemptions=await client.query<{
        id:string;package_id:string;package_entitlement_id:string|null;
      }>(
        `SELECT r.id,r.package_id,r.package_entitlement_id
         FROM dance_package_redemption r
         JOIN dance_lesson_participant lp
           ON lp.tenant_id=r.tenant_id AND lp.id=r.participant_id
         WHERE r.tenant_id=$1 AND lp.lesson_id=$2 AND r.state='RESERVED'
         ORDER BY r.id
         FOR UPDATE OF r`,
        [context.tenantId,lessonId]
      );
      for(const row of redemptions.rows){
        const pack=await client.query(
          `UPDATE service_package
           SET reserved_visits=reserved_visits-1,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
           RETURNING id`,
          [context.tenantId,row.package_id]
        );
        if(!pack.rowCount) throw new ConflictException("Нарушена целостность абонемента");
        if(row.package_entitlement_id){
          const bucket=await client.query(
            `UPDATE service_package_entitlement
             SET reserved_visits=reserved_visits-1
             WHERE tenant_id=$1 AND id=$2 AND reserved_visits>0
             RETURNING id`,
            [context.tenantId,row.package_entitlement_id]
          );
          if(!bucket.rowCount)
            throw new ConflictException("Нарушена целостность квоты абонемента");
        }
        await client.query(
          "UPDATE dance_package_redemption SET state='RELEASED',settled_at=now() WHERE tenant_id=$1 AND id=$2",
          [context.tenantId,row.id]
        );
      }

      await client.query(
        `UPDATE dance_makeup_credit mc
         SET status='AVAILABLE',reserved_participant_id=NULL,updated_at=now()
         FROM dance_lesson_participant lp
         WHERE mc.tenant_id=$1
           AND lp.tenant_id=mc.tenant_id
           AND lp.lesson_id=$2
           AND lp.makeup_credit_id=mc.id
           AND mc.status='RESERVED'
           AND mc.reserved_participant_id=lp.id`,
        [context.tenantId,lessonId]
      );

      await client.query(
        `UPDATE dance_lesson_participant
         SET status=CASE WHEN status='WAITLIST' THEN status ELSE 'CANCELLED_IN_TIME' END,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND lesson_id=$2
           AND status NOT IN ('ATTENDED','LATE')`,
        [context.tenantId,lessonId]
      );

      const room=await this.calculateRoomCost(
        client,context.tenantId,lesson,true
      );
      await client.query(
        `INSERT INTO dance_lesson_profitability(
           tenant_id,lesson_id,booked_count,attended_count,
           earned_revenue_minor,trainer_cost_minor,room_cost_minor,
           other_cost_minor,contribution_margin_minor,currency,
           calculation_snapshot
         ) VALUES(
           $1,$2,0,0,0,0,$3,0,$4,$5,$6
         )
         ON CONFLICT(tenant_id,lesson_id) DO NOTHING`,
        [
          context.tenantId,lessonId,room.amount.toString(),
          (-room.amount).toString(),lesson.currency,
          JSON.stringify({
            cancellation:true,
            reason:input.reason.trim(),
            room:room.snapshot
          })
        ]
      );

      const status=input.byTrainer?"CANCELLED_BY_TRAINER":"CANCELLED_BY_STUDIO";
      await client.query(
        "UPDATE dance_lesson SET status=$3,attendance_locked_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,lessonId,status]
      );
      await client.query(
        "UPDATE service_booking SET status='CANCELLED',cancelled_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,lesson.host_booking_id]
      );
      await this.audit(client,context,"dance.lesson_cancelled","dance_lesson",lessonId,{
        status,reason:input.reason.trim(),roomCancellationCostMinor:room.amount.toString()
      });
      return {status,changed:true,roomCostMinor:room.amount.toString()};
    });
  }

  async compensationAccruals(
    context:TenantContext,
    input:{from?:string;to?:string}
  ){
    const scopeIds=await this.scopeIds(context,"dance.read");
    const from=input.from?new Date(input.from):new Date(new Date().getFullYear(),new Date().getMonth(),1);
    const to=input.to?new Date(input.to):new Date(Date.now()+86400000);
    if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<=from)
      throw new BadRequestException("Некорректный период начислений");

    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           a.id,a.lesson_id,a.trainer_resource_id,r.name AS trainer_name,
           a.plan_id,a.rule_snapshot,a.attended_count,
           a.eligible_revenue_minor::text,a.amount_minor::text,
           a.currency,a.status,a.payroll_batch_id,a.created_at,
           l.lesson_type,l.starts_at,l.ends_at,g.name AS group_name
         FROM trainer_compensation_accrual a
         JOIN dance_lesson l
           ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
         JOIN service_resource r
           ON r.tenant_id=a.tenant_id AND r.id=a.trainer_resource_id
         LEFT JOIN dance_group g
           ON g.tenant_id=l.tenant_id AND g.id=l.group_id
         WHERE a.tenant_id=$1
           AND l.starts_at>=$2 AND l.starts_at<$3
           AND (
             $4::uuid[] IS NULL
             OR r.membership_id = ANY($4::uuid[])
           )
         ORDER BY l.starts_at DESC,r.name`,
        [context.tenantId,from,to,scopeIds]
      );
      return result.rows;
    });
  }

  async approveCompensation(
    context:TenantContext,
    input:{from:string;to:string}
  ){
    await this.requireAll(context,"dance.write");
    const {from,to}=this.dateRange(input.from,input.to);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE trainer_compensation_accrual a
         SET status='APPROVED',approved_at=now(),approved_by_membership_id=$4
         FROM dance_lesson l
         WHERE a.tenant_id=$1
           AND l.tenant_id=a.tenant_id AND l.id=a.lesson_id
           AND l.starts_at>=$2 AND l.starts_at<$3
           AND a.status='CALCULATED'
         RETURNING a.id`,
        [context.tenantId,from,to,context.membershipId]
      );
      return {approved:result.rowCount};
    });
  }

  async exportCompensationToPayroll(
    context:TenantContext,
    input:{batchId:string;from:string;to:string}
  ){
    await this.requireAll(context,"dance.write");
    const {from,to}=this.dateRange(input.from,input.to);
    return this.database.withTenantTransaction(context,async client=>{
      const batch=await client.query(
        "SELECT 1 FROM payroll_accrual_batch WHERE tenant_id=$1 AND id=$2 AND status='DRAFT' FOR UPDATE",
        [context.tenantId,input.batchId]
      );
      if(!batch.rowCount) throw new ConflictException("Payroll batch не найден или уже утверждён");

      const missing=await client.query(
        `SELECT a.id
         FROM trainer_compensation_accrual a
         JOIN dance_lesson l
           ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
         JOIN service_resource r
           ON r.tenant_id=a.tenant_id AND r.id=a.trainer_resource_id
         WHERE a.tenant_id=$1 AND a.status='APPROVED'
           AND l.starts_at>=$2 AND l.starts_at<$3
           AND r.membership_id IS NULL
         LIMIT 1`,
        [context.tenantId,from,to]
      );
      if(missing.rowCount)
        throw new ConflictException("У одного из тренеров не привязан сотрудник tenant membership");

      const accruals=await client.query<{
        id:string;membership_id:string;amount_minor:string;
      }>(
        `SELECT a.id,r.membership_id,a.amount_minor::text
         FROM trainer_compensation_accrual a
         JOIN dance_lesson l
           ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
         JOIN service_resource r
           ON r.tenant_id=a.tenant_id AND r.id=a.trainer_resource_id
         WHERE a.tenant_id=$1 AND a.status='APPROVED'
           AND l.starts_at>=$2 AND l.starts_at<$3
         ORDER BY a.id
         FOR UPDATE OF a`,
        [context.tenantId,from,to]
      );

      const totals=new Map<string,bigint>();
      for(const accrual of accruals.rows){
        totals.set(
          accrual.membership_id,
          (totals.get(accrual.membership_id)??0n)+BigInt(accrual.amount_minor)
        );
      }

      for(const [membershipId,grossMinor] of totals){
        await client.query(
          `INSERT INTO payroll_accrual_line(
             tenant_id,batch_id,employee_ref,gross_minor,deduction_minor
           ) VALUES($1,$2,$3,$4,0)
           ON CONFLICT(tenant_id,batch_id,employee_ref)
           DO UPDATE SET gross_minor=
             payroll_accrual_line.gross_minor+EXCLUDED.gross_minor`,
          [context.tenantId,input.batchId,membershipId,grossMinor.toString()]
        );
      }

      const ids=accruals.rows.map((row)=>row.id);
      let exported=0;
      if(ids.length){
        const updated=await client.query(
          `UPDATE trainer_compensation_accrual
           SET status='EXPORTED',payroll_batch_id=$3
           WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='APPROVED'
           RETURNING id`,
          [context.tenantId,ids,input.batchId]
        );
        exported=updated.rowCount;
      }
      return {trainers:totals.size,accruals:exported};
    });
  }

  private async createChargeTx(
    client:PoolClient,
    context:TenantContext,
    input:{
      studentId:string;
      payerPartyId:string;
      sourceType:"PACKAGE"|"LESSON"|"INSTALLMENT"|"OTHER";
      sourceId:string|null;
      amountMinor:string;
      dueAt:Date|null;
      note?:string;
    }
  ){
    if(input.sourceId){
      const existing=await client.query(
        `SELECT id,obligation_id,invoice_id,status
         FROM dance_student_charge
         WHERE tenant_id=$1 AND student_id=$2
           AND source_type=$3 AND source_id=$4
           AND status<>'CANCELLED'`,
        [context.tenantId,input.studentId,input.sourceType,input.sourceId]
      );
      if(existing.rows[0]) return existing.rows[0];
    }

    const charge=await client.query<{id:string}>(
      `INSERT INTO dance_student_charge(
         tenant_id,student_id,payer_party_id,source_type,source_id,
         amount_minor,due_at,note,created_by_membership_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        context.tenantId,input.studentId,input.payerPartyId,input.sourceType,
        input.sourceId,input.amountMinor,input.dueAt,
        input.note?.trim()||null,context.membershipId
      ]
    );
    const chargeId=charge.rows[0]?.id;
    if(!chargeId) throw new Error("DANCE_CHARGE_CREATE_FAILED");

    const obligation=await client.query<{id:string}>(
      `INSERT INTO financial_obligation(
         tenant_id,direction,party_id,source_type,source_id,
         currency,amount_minor,due_at
       ) VALUES($1,'RECEIVABLE',$2,'DANCE_STUDENT_CHARGE',$3,'RUB',$4,$5)
       RETURNING id`,
      [
        context.tenantId,input.payerPartyId,chargeId,input.amountMinor,input.dueAt
      ]
    );
    const obligationId=obligation.rows[0]?.id;
    if(!obligationId) throw new Error("DANCE_OBLIGATION_CREATE_FAILED");

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
    if(!invoiceId) throw new Error("DANCE_INVOICE_CREATE_FAILED");

    await client.query(
      `UPDATE dance_student_charge
       SET obligation_id=$3,invoice_id=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId,chargeId,obligationId,invoiceId]
    );

    await this.audit(client,context,"dance.charge_created","dance_student_charge",chargeId,{
      payerPartyId:input.payerPartyId,
      amountMinor:input.amountMinor,
      invoiceId
    });

    return {
      id:chargeId,
      obligation_id:obligationId,
      invoice_id:invoiceId,
      invoice_number:number,
      status:"OPEN"
    };
  }

  private async calculateTrainerCost(
    client:PoolClient,
    tenantId:string,
    lesson:any,
    attendedCount:number,
    revenue:{
      earned:bigint;
      billed:bigint;
      paid:bigint;
      list:bigint;
    }
  ){
    if(!lesson.trainer_resource_id)
      return {amount:0n,eligibleRevenue:0n,planId:null,snapshot:{type:"NONE"}};

    const planResult=await client.query<any>(
      `SELECT *
       FROM trainer_compensation_plan
       WHERE tenant_id=$1 AND trainer_resource_id=$2 AND status='ACTIVE'
         AND valid_from <= $3::date
         AND (valid_to IS NULL OR valid_to >= $3::date)
         AND (lesson_type IS NULL OR lesson_type=$4)
       ORDER BY (lesson_type IS NOT NULL) DESC,priority,valid_from DESC
       LIMIT 1`,
      [
        tenantId,lesson.trainer_resource_id,
        new Date(lesson.starts_at).toISOString().slice(0,10),
        lesson.lesson_type
      ]
    );
    const plan=planResult.rows[0];
    if(!plan)
      return {amount:0n,eligibleRevenue:0n,planId:null,snapshot:{type:"MISSING_PLAN"}};

    const duration=Math.max(
      1,Math.round(
        (new Date(lesson.ends_at).getTime()-new Date(lesson.starts_at).getTime())/60000
      )
    );
    const eligible=
      plan.revenue_basis==="PAID"?revenue.paid:
      plan.revenue_basis==="LIST"?revenue.list:
      plan.revenue_basis==="BILLED"?revenue.billed:
      revenue.earned;

    let amount=0n;
    switch(plan.calculation_type){
      case "FIXED":
        amount=BigInt(plan.fixed_minor); break;
      case "HOURLY":
        amount=(BigInt(plan.hourly_minor)*BigInt(duration)+59n)/60n; break;
      case "PERCENT":
        amount=(eligible*BigInt(plan.percent_bps)+9999n)/10000n; break;
      case "ATTENDEE":
        amount=BigInt(plan.fixed_minor)+
          BigInt(plan.per_attendee_minor)*BigInt(attendedCount); break;
      case "TIERED":
        amount=BigInt(plan.fixed_minor)+
          BigInt(plan.threshold_extra_minor)*
          BigInt(Math.max(0,attendedCount-plan.threshold_count)); break;
    }
    return {
      amount,
      eligibleRevenue:eligible,
      planId:plan.id as string,
      snapshot:{
        planId:plan.id,
        calculationType:plan.calculation_type,
        revenueBasis:plan.revenue_basis,
        attendedCount,
        durationMinutes:duration,
        eligibleRevenueMinor:eligible.toString(),
        fixedMinor:String(plan.fixed_minor),
        hourlyMinor:String(plan.hourly_minor),
        percentBps:plan.percent_bps,
        perAttendeeMinor:String(plan.per_attendee_minor),
        thresholdCount:plan.threshold_count,
        thresholdExtraMinor:String(plan.threshold_extra_minor)
      }
    };
  }

  private async calculateRoomCost(
    client:PoolClient,
    tenantId:string,
    lesson:any,
    cancelled:boolean
  ){
    if(!lesson.room_resource_id)
      return {amount:0n,snapshot:{type:"NO_ROOM"}};

    const resource=await client.query<{
      cost_per_hour_minor:string;timezone:string;
    }>(
      `SELECT cost_per_hour_minor::text,timezone
       FROM service_resource
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lesson.room_resource_id]
    );
    const rr=resource.rows[0];
    if(!rr) return {amount:0n,snapshot:{type:"ROOM_MISSING"}};

    const contractResult=await client.query<any>(
      `SELECT *
       FROM room_rental_contract
       WHERE tenant_id=$1 AND room_resource_id=$2 AND status='ACTIVE'
         AND valid_from <= ($3::timestamptz AT TIME ZONE $4)::date
         AND (
           valid_to IS NULL
           OR valid_to >= ($3::timestamptz AT TIME ZONE $4)::date
         )
       ORDER BY valid_from DESC
       LIMIT 1`,
      [tenantId,lesson.room_resource_id,lesson.starts_at,rr.timezone]
    );
    const contract=contractResult.rows[0];
    const duration=Math.max(
      1,Math.round(
        (new Date(lesson.ends_at).getTime()-new Date(lesson.starts_at).getTime())/60000
      )
    );

    let normal=0n;
    let snapshot:any={type:"RESOURCE_HOURLY",durationMinutes:duration};
    if(!contract){
      normal=(BigInt(rr.cost_per_hour_minor)*BigInt(duration)+59n)/60n;
      snapshot.costPerHourMinor=rr.cost_per_hour_minor;
    }else if(contract.pricing_type==="HOURLY"){
      const minutes=Math.max(duration,contract.minimum_billable_minutes);
      normal=(BigInt(contract.hourly_rate_minor)*BigInt(minutes)+59n)/60n;
      snapshot={
        type:"HOURLY",
        contractId:contract.id,
        durationMinutes:duration,
        billableMinutes:minutes,
        hourlyRateMinor:String(contract.hourly_rate_minor)
      };
    }else if(contract.pricing_type==="FIXED_SLOT"){
      const slot=await client.query<{slot_minor:string}>(
        `SELECT slot_minor::text
         FROM room_rental_slot
         WHERE tenant_id=$1 AND contract_id=$2
           AND weekday=extract(isodow from ($3::timestamptz AT TIME ZONE $4))::int
           AND start_minute <= (
             extract(hour from ($3::timestamptz AT TIME ZONE $4))::int*60+
             extract(minute from ($3::timestamptz AT TIME ZONE $4))::int
           )
         ORDER BY start_minute DESC
         LIMIT 1`,
        [tenantId,contract.id,lesson.starts_at,rr.timezone]
      );
      normal=BigInt(slot.rows[0]?.slot_minor??contract.slot_minor);
      snapshot={
        type:"FIXED_SLOT",
        contractId:contract.id,
        slotMinor:normal.toString()
      };
    }else{
      const count=await client.query<{count:number}>(
        `SELECT count(*)::integer AS count
         FROM dance_lesson
         WHERE tenant_id=$1 AND room_resource_id=$2
           AND status NOT IN ('CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER')
           AND date_trunc('month',starts_at AT TIME ZONE $4)=
               date_trunc('month',$3::timestamptz AT TIME ZONE $4)`,
        [tenantId,lesson.room_resource_id,lesson.starts_at,rr.timezone]
      );
      const divisor=Math.max(1,count.rows[0]?.count??1);
      normal=BigInt(contract.monthly_minor)/BigInt(divisor);
      snapshot={
        type:"FIXED_MONTHLY",
        contractId:contract.id,
        monthlyMinor:String(contract.monthly_minor),
        allocatedLessons:divisor
      };
    }

    if(cancelled&&contract){
      const charged=(normal*BigInt(contract.cancellation_charge_bps)+9999n)/10000n;
      return {
        amount:charged,
        snapshot:{
          ...snapshot,
          cancellation:true,
          cancellationChargeBps:contract.cancellation_charge_bps,
          normalCostMinor:normal.toString()
        }
      };
    }
    return {amount:normal,snapshot};
  }

  private async lessonRevenueBases(
    client:PoolClient,
    tenantId:string,
    lesson:any,
    earned:bigint,
    attendedCount:number
  ){
    const host=await client.query<{price_minor_snapshot:string}>(
      "SELECT price_minor_snapshot::text FROM service_booking WHERE tenant_id=$1 AND id=$2",
      [tenantId,lesson.host_booking_id]
    );
    const list=BigInt(host.rows[0]?.price_minor_snapshot??"0")*BigInt(attendedCount);

    const billed=await client.query<{amount:string}>(
      `SELECT coalesce(sum(c.amount_minor),0)::text AS amount
       FROM dance_student_charge c
       WHERE c.tenant_id=$1 AND c.source_type='LESSON' AND c.source_id=$2
         AND c.status<>'CANCELLED'`,
      [tenantId,lesson.id]
    );

    const paidDirect=await client.query<{amount:string}>(
      `SELECT coalesce(sum(o.settled_minor),0)::text AS amount
       FROM dance_student_charge c
       JOIN financial_obligation o
         ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
       WHERE c.tenant_id=$1 AND c.source_type='LESSON' AND c.source_id=$2`,
      [tenantId,lesson.id]
    );

    const packagePaid=await client.query<{amount:string}>(
      `SELECT coalesce(sum(
           CASE
             WHEN so.amount_minor>0 THEN
               (
                 CASE
                   WHEN plan.management_visit_value_minor>0
                     THEN plan.management_visit_value_minor
                   WHEN sp.visit_limit_snapshot IS NOT NULL
                     THEN sp.price_minor_snapshot/sp.visit_limit_snapshot
                   ELSE 0
                 END
                 * least(so.settled_minor,so.amount_minor)
                 / so.amount_minor
               )
             ELSE 0
           END
         ),0)::text AS amount
       FROM dance_lesson_participant lp
       JOIN dance_package_redemption r
         ON r.tenant_id=lp.tenant_id AND r.participant_id=lp.id
       JOIN service_package sp
         ON sp.tenant_id=r.tenant_id AND sp.id=r.package_id
       JOIN service_package_plan plan
         ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
       LEFT JOIN financial_obligation so
         ON so.tenant_id=sp.tenant_id
        AND so.direction='RECEIVABLE'
        AND so.source_type='SALES_ORDER'
        AND so.source_id=sp.sales_order_id
       WHERE lp.tenant_id=$1 AND lp.lesson_id=$2 AND r.state='CONSUMED'`,
      [tenantId,lesson.id]
    );

    const directEarnedResult=await client.query<{amount:string}>(
      `SELECT coalesce(sum(lp.charge_minor),0)::text AS amount
       FROM dance_lesson_participant lp
       WHERE lp.tenant_id=$1 AND lp.lesson_id=$2
         AND lp.package_id IS NULL
         AND lp.status IN ('ATTENDED','LATE','NO_SHOW','CANCELLED_LATE')`,
      [tenantId,lesson.id]
    );
    const directEarned=BigInt(directEarnedResult.rows[0]?.amount??"0");
    const packageEarned=earned>directEarned ? earned-directEarned : 0n;

    return {
      earned,
      billed:BigInt(billed.rows[0]?.amount??"0")+packageEarned,
      paid:BigInt(paidDirect.rows[0]?.amount??"0")+
        BigInt(packagePaid.rows[0]?.amount??"0"),
      list
    };
  }

  private async lessonForUpdate(
    client:PoolClient,
    tenantId:string,
    lessonId:string,
    scopeIds:string[]|null
  ):Promise<any>{
    const result=await client.query(
      `SELECT
         l.*,tr.membership_id AS trainer_membership_id
       FROM dance_lesson l
       LEFT JOIN service_resource tr
         ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
       WHERE l.tenant_id=$1 AND l.id=$2
         AND (
           $3::uuid[] IS NULL
           OR tr.membership_id = ANY($3::uuid[])
         )
       FOR UPDATE OF l`,
      [tenantId,lessonId,scopeIds]
    );
    const row=result.rows[0];
    if(!row) throw new NotFoundException("Урок не найден");
    return row;
  }

  private async assertStudentAccess(
    client:PoolClient,
    tenantId:string,
    studentId:string,
    scopeIds:string[]|null
  ){
    const result=await client.query<{id:string;party_id:string}>(
      `SELECT s.id,s.party_id
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

  private async defaultPayer(
    client:PoolClient,
    tenantId:string,
    studentPartyId:string
  ){
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

  private normalizeMonth(month?:string){
    const value=(month??new Date().toISOString().slice(0,7)).trim();
    if(!/^\d{4}-\d{2}$/.test(value)){
      throw new BadRequestException("Месяц должен быть в формате YYYY-MM");
    }
    const [year,monthNumber]=value.split("-").map(Number);
    if(
      !Number.isInteger(year) ||
      !Number.isInteger(monthNumber) ||
      monthNumber<1 ||
      monthNumber>12
    ){
      throw new BadRequestException("Некорректный месяц");
    }
    const from=value+"-01";
    const nextMonth=new Date(Date.UTC(year,monthNumber,1));
    const to=new Date(nextMonth.getTime()-86400000)
      .toISOString()
      .slice(0,10);
    return {month:value,from,to};
  }

  private dateRange(fromText:string,toText:string){
    const from=new Date(fromText);
    const to=new Date(toText);
    if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<=from||
       to.getTime()-from.getTime()>370*86400000)
      throw new BadRequestException("Некорректный период");
    return {from,to};
  }

  private async scopeIds(
    context:TenantContext,
    permission:DancePermission
  ):Promise<string[]|null>{
    const scope=await this.authorization.resolveScope(context,permission);
    if(!scope) throw new ForbiddenException("Недостаточно прав");
    return this.authorization.membershipIdsForScope(context,scope);
  }

  private async requireAll(context:TenantContext,permission:DancePermission){
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
