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
import { InventoryService } from "../inventory/inventory.service";

type DancePermission = "dance.read" | "dance.write";

@Injectable()
export class DanceEconomicsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService,
    private readonly inventory: InventoryService
  ) {}

  async charges(context:TenantContext,studentId?:string){
    const scopeIds=await this.scopeIds(context,"dance.read");
    if(!await this.authorization.resolveScope(context,"finance.read"))
      throw new ForbiddenException("Для просмотра начислений нужны финансовые права");
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
    const scopeIds=await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.id,p.trainer_resource_id,r.name AS trainer_name,
           p.service_id,svc.name AS service_name,
           p.lesson_type,p.dance_program_id,dp.name AS program_name,
           p.dance_group_id,dg.name AS group_name,
           p.branch_id,b.name AS branch_name,
           p.calculation_type,p.fixed_minor::text,p.hourly_minor::text,
           p.percent_bps,p.per_attendee_minor::text,p.threshold_count,
           p.threshold_extra_minor::text,p.revenue_basis,p.priority,
           p.minimum_guarantee_minor::text,p.guarantee_period,
           p.currency,p.valid_from,p.valid_to,p.status,p.metadata,
           coalesce((
             SELECT json_agg(json_build_object(
               'id',c.id,
               'componentType',c.component_type,
               'amountMinor',c.amount_minor::text,
               'percentBps',c.percent_bps,
               'thresholdCount',c.threshold_count,
               'revenueBasis',c.revenue_basis,
               'priority',c.priority,
               'metadata',c.metadata
             ) ORDER BY c.priority,c.id)
             FROM trainer_compensation_component c
             WHERE c.tenant_id=p.tenant_id AND c.plan_id=p.id
           ),'[]'::json) AS components
         FROM trainer_compensation_plan p
         JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.trainer_resource_id
         LEFT JOIN service_catalog_item svc
           ON svc.tenant_id=p.tenant_id AND svc.id=p.service_id
         LEFT JOIN dance_program dp
           ON dp.tenant_id=p.tenant_id AND dp.id=p.dance_program_id
         LEFT JOIN dance_group dg
           ON dg.tenant_id=p.tenant_id AND dg.id=p.dance_group_id
         LEFT JOIN branch b
           ON b.tenant_id=p.tenant_id AND b.id=p.branch_id
         WHERE p.tenant_id=$1 AND p.status='ACTIVE'
           AND (
             $2::uuid[] IS NULL
             OR r.membership_id = ANY($2::uuid[])
           )
         ORDER BY r.name,p.priority,p.valid_from DESC`,
        [context.tenantId,scopeIds]
      );
      return result.rows;
    });
  }

  async payrollProfiles(context:TenantContext){
    const scopeIds=await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.id,p.trainer_resource_id,r.name AS trainer_name,
           p.monthly_base_minor::text,p.daily_base_minor::text,
           p.minimum_guarantee_minor::text,p.currency,
           p.valid_from,p.valid_to,p.status,p.note,p.metadata,
           r.membership_id
         FROM trainer_payroll_profile p
         JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.trainer_resource_id
         WHERE p.tenant_id=$1 AND p.status='ACTIVE'
           AND (
             $2::uuid[] IS NULL
             OR r.membership_id = ANY($2::uuid[])
           )
         ORDER BY r.name,p.valid_from DESC`,
        [context.tenantId,scopeIds]
      );
      return result.rows;
    });
  }

  async upsertPayrollProfile(
    context:TenantContext,
    input:{
      trainerResourceId:string;
      monthlyBaseMinor?:string;
      dailyBaseMinor?:string;
      minimumGuaranteeMinor?:string;
      validFrom?:string;
      validTo?:string;
      note?:string;
      metadata?:Record<string,unknown>;
    }
  ){
    await this.requireAll(context,"dance.write");
    const money=[
      input.monthlyBaseMinor??"0",
      input.dailyBaseMinor??"0",
      input.minimumGuaranteeMinor??"0"
    ];
    if(money.some(value=>!/^\d+$/.test(value))){
      throw new BadRequestException("Некорректные постоянные условия зарплаты");
    }
    const validFrom=input.validFrom??new Date().toISOString().slice(0,10);
    if(
      !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)||
      (input.validTo&&!/^\d{4}-\d{2}-\d{2}$/.test(input.validTo))
    ){
      throw new BadRequestException("Некорректный период условий тренера");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const trainer=await client.query(
        `SELECT 1 FROM service_resource
         WHERE tenant_id=$1 AND id=$2
           AND type='EMPLOYEE' AND status='ACTIVE'`,
        [context.tenantId,input.trainerResourceId]
      );
      if(!trainer.rowCount) throw new NotFoundException("Тренер не найден");

      const current=await client.query<{id:string}>(
        input.validFrom
          ? `SELECT id
             FROM trainer_payroll_profile
             WHERE tenant_id=$1
               AND trainer_resource_id=$2
               AND status='ACTIVE'
               AND valid_from=$3::date
               AND valid_to IS NOT DISTINCT FROM $4::date
             ORDER BY valid_from DESC,id
             LIMIT 1
             FOR UPDATE`
          : `SELECT id
             FROM trainer_payroll_profile
             WHERE tenant_id=$1
               AND trainer_resource_id=$2
               AND status='ACTIVE'
               AND valid_from<=current_date
               AND (valid_to IS NULL OR valid_to>=current_date)
             ORDER BY valid_from DESC,id
             LIMIT 1
             FOR UPDATE`,
        input.validFrom
          ? [
              context.tenantId,input.trainerResourceId,
              validFrom,input.validTo??null
            ]
          : [context.tenantId,input.trainerResourceId]
      );

      try{
        if(current.rows[0]){
          const result=await client.query(
            `UPDATE trainer_payroll_profile
             SET monthly_base_minor=$4,
                 daily_base_minor=$5,
                 minimum_guarantee_minor=$6,
                 note=$7,metadata=$8,updated_at=now()
             WHERE tenant_id=$1 AND id=$2
               AND trainer_resource_id=$3
             RETURNING *`,
            [
              context.tenantId,current.rows[0].id,input.trainerResourceId,
              input.monthlyBaseMinor??"0",input.dailyBaseMinor??"0",
              input.minimumGuaranteeMinor??"0",
              input.note?.trim()||null,JSON.stringify(input.metadata??{})
            ]
          );
          return result.rows[0];
        }

        const result=await client.query(
          `INSERT INTO trainer_payroll_profile(
             tenant_id,trainer_resource_id,monthly_base_minor,daily_base_minor,
             minimum_guarantee_minor,valid_from,valid_to,note,metadata
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [
            context.tenantId,input.trainerResourceId,
            input.monthlyBaseMinor??"0",input.dailyBaseMinor??"0",
            input.minimumGuaranteeMinor??"0",validFrom,input.validTo??null,
            input.note?.trim()||null,JSON.stringify(input.metadata??{})
          ]
        );
        return result.rows[0];
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(message.includes("TRAINER_PAYROLL_PROFILE_OVERLAP")){
          throw new ConflictException(
            "У тренера уже есть постоянные условия зарплаты на этот период"
          );
        }
        throw error;
      }
    });
  }

  async archiveCompensationPlan(
    context:TenantContext,
    planId:string
  ){
    await this.requireAll(context,"dance.write");
    return this.database.withTenantTransaction(context,async client=>{
      const plan=await client.query<{status:string}>(
        `SELECT status
         FROM trainer_compensation_plan
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,planId]
      );
      const row=plan.rows[0];
      if(!row) throw new NotFoundException("Правило зарплаты не найдено");
      if(row.status==="ARCHIVED"){
        return {id:planId,status:"ARCHIVED",changed:false};
      }

      await client.query(
        `UPDATE trainer_compensation_plan
         SET status='ARCHIVED',updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,planId]
      );
      await this.audit(
        client,context,"dance.compensation_plan_archived",
        "trainer_compensation_plan",planId
      );
      return {id:planId,status:"ARCHIVED",changed:true};
    });
  }

  async createCompensationPlan(
    context:TenantContext,
    input:{
      trainerResourceId:string;
      serviceId?:string;
      lessonType?:string;
      danceProgramId?:string;
      danceGroupId?:string;
      branchId?:string;
      calculationType:
        "FIXED"|"HOURLY"|"PERCENT"|"ATTENDEE"|"TIERED"|"COMPOSITE";
      fixedMinor?:string;
      hourlyMinor?:string;
      percentBps?:number;
      perAttendeeMinor?:string;
      thresholdCount?:number;
      thresholdExtraMinor?:string;
      revenueBasis?:"LIST"|"BILLED"|"PAID"|"EARNED";
      minimumGuaranteeMinor?:string;
      guaranteePeriod?:"DAY"|"MONTH";
      components?:Array<{
        componentType:
          "FIXED_PER_LESSON"|"HOURLY"|"PERCENT"|"PER_ATTENDEE"|
          "TIER_BONUS"|"DAILY_BASE"|"MONTHLY_BASE";
        amountMinor?:string;
        percentBps?:number;
        thresholdCount?:number;
        revenueBasis?:"LIST"|"BILLED"|"PAID"|"EARNED";
        priority?:number;
        metadata?:Record<string,unknown>;
      }>;
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
      input.thresholdExtraMinor??"0",
      input.minimumGuaranteeMinor??"0"
    ];
    if(money.some(value=>!/^\d+$/.test(value))){
      throw new BadRequestException("Некорректная денежная ставка");
    }

    const percent=Math.floor(input.percentBps??0);
    const priority=Math.floor(input.priority??100);
    const threshold=Math.floor(input.thresholdCount??0);
    if(
      percent<0||percent>10000||
      priority<1||priority>100000||
      threshold<0||threshold>100000
    ){
      throw new BadRequestException("Некорректные параметры правила");
    }
    const from=input.validFrom??new Date().toISOString().slice(0,10);
    if(
      !/^\d{4}-\d{2}-\d{2}$/.test(from)||
      (input.validTo&&!/^\d{4}-\d{2}-\d{2}$/.test(input.validTo))
    ){
      throw new BadRequestException("Некорректный период правила");
    }
    if((input.components?.length??0)>30){
      throw new BadRequestException("Слишком много компонентов зарплаты");
    }

    const components=(input.components??[]).map((component,index)=>{
      const amount=component.amountMinor??"0";
      const bps=Math.floor(component.percentBps??0);
      const componentThreshold=Math.floor(component.thresholdCount??0);
      const componentPriority=Math.floor(component.priority??100+index);
      if(!/^\d+$/.test(amount)){
        throw new BadRequestException("Некорректная ставка компонента");
      }
      if(
        bps<0||bps>10000||
        componentThreshold<0||componentThreshold>100000||
        componentPriority<1||componentPriority>100000
      ){
        throw new BadRequestException("Некорректный компонент зарплаты");
      }
      return {
        ...component,
        amountMinor:amount,
        percentBps:bps,
        thresholdCount:componentThreshold,
        priority:componentPriority,
        revenueBasis:component.revenueBasis??"EARNED"
      };
    });
    if(input.calculationType==="COMPOSITE"&&!components.length){
      throw new BadRequestException(
        "Для составной зарплаты добавьте хотя бы один компонент"
      );
    }

    return this.database.withTenantTransaction(context,async client=>{
      const trainer=await client.query(
        `SELECT 1 FROM service_resource
         WHERE tenant_id=$1 AND id=$2
           AND type='EMPLOYEE' AND status='ACTIVE'`,
        [context.tenantId,input.trainerResourceId]
      );
      if(!trainer.rowCount) throw new NotFoundException("Тренер не найден");

      if(input.serviceId){
        const service=await client.query(
          `SELECT 1 FROM service_catalog_item
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.serviceId]
        );
        if(!service.rowCount) throw new NotFoundException("Услуга не найдена");
      }
      if(input.danceProgramId){
        const program=await client.query(
          `SELECT 1 FROM dance_program
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.danceProgramId]
        );
        if(!program.rowCount) throw new NotFoundException("Направление не найдено");
      }
      if(input.danceGroupId){
        const group=await client.query<{program_id:string}>(
          `SELECT program_id FROM dance_group
           WHERE tenant_id=$1 AND id=$2 AND status<>'ARCHIVED'`,
          [context.tenantId,input.danceGroupId]
        );
        if(!group.rows[0]) throw new NotFoundException("Группа не найдена");
        if(
          input.danceProgramId &&
          group.rows[0].program_id!==input.danceProgramId
        ){
          throw new ConflictException("Группа относится к другому направлению");
        }
      }
      if(input.branchId){
        const branch=await client.query(
          `SELECT 1 FROM branch
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.branchId]
        );
        if(!branch.rowCount) throw new NotFoundException("Филиал не найден");
      }

      try{
        const row=await client.query<{id:string;status:string}>(
          `INSERT INTO trainer_compensation_plan(
             tenant_id,trainer_resource_id,service_id,lesson_type,
             dance_program_id,dance_group_id,branch_id,calculation_type,
             fixed_minor,hourly_minor,percent_bps,per_attendee_minor,
             threshold_count,threshold_extra_minor,revenue_basis,priority,
             minimum_guarantee_minor,guarantee_period,
             valid_from,valid_to,metadata
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21
           )
           RETURNING id,status`,
          [
            context.tenantId,input.trainerResourceId,input.serviceId??null,
            input.lessonType??null,input.danceProgramId??null,
            input.danceGroupId??null,input.branchId??null,
            input.calculationType,input.fixedMinor??"0",input.hourlyMinor??"0",
            percent,input.perAttendeeMinor??"0",threshold,
            input.thresholdExtraMinor??"0",input.revenueBasis??"EARNED",
            priority,input.minimumGuaranteeMinor??"0",
            input.guaranteePeriod??"MONTH",from,input.validTo??null,
            JSON.stringify(input.metadata??{})
          ]
        );
        const plan=row.rows[0];
        if(!plan) throw new Error("TRAINER_COMP_PLAN_CREATE_FAILED");

        for(const component of components){
          await client.query(
            `INSERT INTO trainer_compensation_component(
               tenant_id,plan_id,component_type,amount_minor,percent_bps,
               threshold_count,revenue_basis,priority,metadata
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              context.tenantId,plan.id,component.componentType,
              component.amountMinor,component.percentBps,
              component.thresholdCount,component.revenueBasis,
              component.priority,JSON.stringify(component.metadata??{})
            ]
          );
        }
        return plan;
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(
          message.includes("Trainer compensation rules overlap")||
          message.includes("trainer_compensation_component")
        ){
          throw new ConflictException(
            "Для тренера уже есть пересекающееся правило зарплаты с таким приоритетом"
          );
        }
        throw error;
      }
    });
  }

  async roomContracts(context:TenantContext){
    await this.requireAll(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           c.id,c.room_resource_id,r.name AS room_name,
           c.counterparty_party_id,p.display_name AS counterparty_name,
           c.pricing_type,c.hourly_rate_minor::text,c.monthly_minor::text,
           c.slot_minor::text,c.minimum_billable_minutes,
           c.cancellation_charge_bps,c.payment_term_days,
           c.capacity_units,c.zone_id,z.name AS zone_name,
           c.currency,c.valid_from,c.valid_to,
           c.status,c.metadata
         FROM room_rental_contract c
         JOIN service_resource r
           ON r.tenant_id=c.tenant_id AND r.id=c.room_resource_id
         LEFT JOIN party p
           ON p.tenant_id=c.tenant_id AND p.id=c.counterparty_party_id
         LEFT JOIN service_resource_zone z
           ON z.tenant_id=c.tenant_id AND z.id=c.zone_id
         WHERE c.tenant_id=$1 AND c.status='ACTIVE'
         ORDER BY r.name,c.valid_from DESC`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async roomStatements(
    context:TenantContext,
    month?:string
  ){
    await this.requireAll(context,"dance.read");
    const target=this.normalizeMonth(month);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           s.id,s.contract_id,c.room_resource_id,r.name AS room_name,
           c.counterparty_party_id,p.display_name AS counterparty_name,
           c.pricing_type,s.period_from,s.period_to,s.currency,
           s.amount_minor::text,s.lesson_count,s.status,s.obligation_id,
           s.finalized_at,s.calculation_snapshot
         FROM room_rental_statement s
         JOIN room_rental_contract c
           ON c.tenant_id=s.tenant_id AND c.id=s.contract_id
         JOIN service_resource r
           ON r.tenant_id=c.tenant_id AND r.id=c.room_resource_id
         LEFT JOIN party p
           ON p.tenant_id=c.tenant_id AND p.id=c.counterparty_party_id
         WHERE s.tenant_id=$1
           AND s.period_from=$2::date
         ORDER BY r.name,c.id`,
        [context.tenantId,target.from]
      );
      return result.rows;
    });
  }

  async createRoomContract(
    context:TenantContext,
    input:{
      roomResourceId:string;
      counterpartyPartyId?:string;
      zoneId?:string;
      capacityUnits?:number;
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
    const capacityUnits=Math.floor(input.capacityUnits??1);
    if(capacityUnits<1||capacityUnits>100000){
      throw new BadRequestException("Некорректная доля арендуемого зала");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const room=await client.query<{capacity:number}>(
        `SELECT capacity FROM service_resource
         WHERE tenant_id=$1 AND id=$2 AND type IN ('ROOM','HALL','WORKPLACE')
           AND status='ACTIVE'
         FOR UPDATE`,
        [context.tenantId,input.roomResourceId]
      );
      if(!room.rows[0]) throw new NotFoundException("Зал не найден");
      if(input.zoneId){
        const zone=await client.query<{capacity_units:number}>(
          `SELECT capacity_units
           FROM service_resource_zone
           WHERE tenant_id=$1 AND id=$2 AND resource_id=$3 AND status='ACTIVE'`,
          [context.tenantId,input.zoneId,input.roomResourceId]
        );
        if(!zone.rows[0]) throw new NotFoundException("Зона зала не найдена");
        if(capacityUnits>zone.rows[0].capacity_units){
          throw new BadRequestException("Доля аренды превышает вместимость зоны");
        }
      }else if(capacityUnits>room.rows[0].capacity){
        throw new BadRequestException("Доля аренды превышает вместимость зала");
      }
      if(input.counterpartyPartyId){
        const party=await client.query(
          "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
          [context.tenantId,input.counterpartyPartyId]
        );
        if(!party.rowCount) throw new NotFoundException("Арендодатель не найден");
      }
      const row=await client.query(
        `INSERT INTO room_rental_contract(
           tenant_id,room_resource_id,counterparty_party_id,zone_id,
           capacity_units,pricing_type,hourly_rate_minor,monthly_minor,
           slot_minor,minimum_billable_minutes,cancellation_charge_bps,
           payment_term_days,valid_from,valid_to,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id,status`,
        [
          context.tenantId,input.roomResourceId,input.counterpartyPartyId??null,
          input.zoneId??null,capacityUnits,input.pricingType,
          input.hourlyRateMinor??"0",input.monthlyMinor??"0",
          input.slotMinor??"0",minimum,cancelBps,paymentTermDays,
          from,input.validTo??null,JSON.stringify(input.metadata??{})
        ]
      );
      return row.rows[0];
    });
  }

  async finalizeRoomStatements(
    context:TenantContext,
    input:{month:string}
  ){
    await this.requireAll(context,"dance.write");
    const target=this.normalizeMonth(input.month);

    return this.database.withTenantTransaction(context,async client=>{
      const contracts=await client.query<{
        id:string;
        counterparty_party_id:string|null;
        pricing_type:"HOURLY"|"FIXED_MONTHLY"|"FIXED_SLOT";
        monthly_minor:string;
        currency:string;
        payment_term_days:number;
        valid_from:string;
        valid_to:string|null;
      }>(
        `SELECT
           id,counterparty_party_id,pricing_type,monthly_minor::text,
           currency,payment_term_days,valid_from::text,valid_to::text
         FROM room_rental_contract
         WHERE tenant_id=$1 AND status='ACTIVE'
           AND valid_from <= $3::date
           AND (valid_to IS NULL OR valid_to >= $2::date)
         ORDER BY id
         FOR UPDATE`,
        [context.tenantId,target.from,target.to]
      );

      const statements:Array<Record<string,unknown>>=[];

      for(const contract of contracts.rows){
        const finalized=await client.query<{
          id:string;amount_minor:string;obligation_id:string|null;
        }>(
          `SELECT id,amount_minor::text,obligation_id
           FROM room_rental_statement
           WHERE tenant_id=$1 AND contract_id=$2
             AND period_from=$3::date AND period_to=$4::date
             AND status='FINALIZED'`,
          [context.tenantId,contract.id,target.from,target.to]
        );
        if(finalized.rows[0]){
          statements.push({
            ...finalized.rows[0],
            contractId:contract.id,
            reused:true
          });
          continue;
        }

        const stats=await client.query<{
          lesson_count:number;amount_minor:string;
        }>(
          `SELECT
             count(*)::integer AS lesson_count,
             coalesce(sum(p.room_cost_minor),0)::text AS amount_minor
           FROM dance_lesson_profitability p
           JOIN dance_lesson l
             ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id
           WHERE p.tenant_id=$1
             AND l.starts_at >= $2::date
             AND l.starts_at < ($3::date + interval '1 day')
             AND p.calculation_snapshot #>> '{room,contractId}' = $4`,
          [context.tenantId,target.from,target.to,contract.id]
        );
        const lessonCount=stats.rows[0]?.lesson_count??0;
        let amount=BigInt(stats.rows[0]?.amount_minor??"0");
        let snapshot:Record<string,unknown>={
          pricingType:contract.pricing_type,
          lessonCount,
          source:"lesson_profitability"
        };

        if(contract.pricing_type==="FIXED_MONTHLY"){
          const active=await client.query<{
            active_days:number;month_days:number;
          }>(
            `SELECT
               (
                 least($2::date,coalesce($4::date,$2::date))
                 - greatest($1::date,$3::date) + 1
               )::integer AS active_days,
               ($2::date-$1::date+1)::integer AS month_days`,
            [target.from,target.to,contract.valid_from,contract.valid_to]
          );
          const activeDays=Math.max(0,active.rows[0]?.active_days??0);
          const monthDays=Math.max(1,active.rows[0]?.month_days??1);
          amount=(
            BigInt(contract.monthly_minor)*BigInt(activeDays)+
            BigInt(monthDays-1)
          )/BigInt(monthDays);
          snapshot={
            pricingType:"FIXED_MONTHLY",
            monthlyMinor:contract.monthly_minor,
            activeDays,
            monthDays,
            lessonCount
          };
        }

        const statement=await client.query<{id:string}>(
          `INSERT INTO room_rental_statement(
             tenant_id,contract_id,period_from,period_to,currency,
             amount_minor,lesson_count,calculation_snapshot
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(tenant_id,contract_id,period_from,period_to)
           DO UPDATE SET
             amount_minor=EXCLUDED.amount_minor,
             lesson_count=EXCLUDED.lesson_count,
             calculation_snapshot=EXCLUDED.calculation_snapshot,
             updated_at=now()
           WHERE room_rental_statement.status='DRAFT'
           RETURNING id`,
          [
            context.tenantId,contract.id,target.from,target.to,
            contract.currency,amount.toString(),lessonCount,
            JSON.stringify(snapshot)
          ]
        );
        let statementId=statement.rows[0]?.id;
        if(!statementId){
          const current=await client.query<{id:string}>(
            `SELECT id FROM room_rental_statement
             WHERE tenant_id=$1 AND contract_id=$2
               AND period_from=$3::date AND period_to=$4::date`,
            [context.tenantId,contract.id,target.from,target.to]
          );
          statementId=current.rows[0]?.id;
        }
        if(!statementId){
          throw new Error("ROOM_RENTAL_STATEMENT_CREATE_FAILED");
        }

        let obligationId:string|null=null;
        if(amount>0n&&contract.counterparty_party_id){
          const obligation=await client.query<{id:string}>(
            `INSERT INTO financial_obligation(
               tenant_id,direction,party_id,source_type,source_id,
               currency,amount_minor,due_at
             ) VALUES(
               $1,'PAYABLE',$2,'DANCE_ROOM_RENT_STATEMENT',$3,$4,$5,
               ($6::date + make_interval(days=>$7::int))
             )
             ON CONFLICT(tenant_id,direction,source_type,source_id)
             DO UPDATE SET
               party_id=EXCLUDED.party_id,
               currency=EXCLUDED.currency,
               amount_minor=EXCLUDED.amount_minor,
               due_at=EXCLUDED.due_at,
               updated_at=now()
             WHERE financial_obligation.status IN ('OPEN','PARTIALLY_SETTLED')
             RETURNING id`,
            [
              context.tenantId,contract.counterparty_party_id,statementId,
              contract.currency,amount.toString(),target.to,
              contract.payment_term_days
            ]
          );
          obligationId=obligation.rows[0]?.id??null;
          if(!obligationId){
            const existing=await client.query<{id:string}>(
              `SELECT id FROM financial_obligation
               WHERE tenant_id=$1 AND direction='PAYABLE'
                 AND source_type='DANCE_ROOM_RENT_STATEMENT'
                 AND source_id=$2`,
              [context.tenantId,statementId]
            );
            obligationId=existing.rows[0]?.id??null;
          }
        }

        await client.query(
          `UPDATE room_rental_statement
           SET status='FINALIZED',obligation_id=$3,
               finalized_at=now(),finalized_by_membership_id=$4,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='DRAFT'`,
          [context.tenantId,statementId,obligationId,context.membershipId]
        );

        await this.audit(
          client,context,"dance.room_rental_statement_finalized",
          "room_rental_statement",statementId,{
            contractId:contract.id,
            month:target.month,
            amountMinor:amount.toString(),
            obligationId
          }
        );

        statements.push({
          id:statementId,
          contractId:contract.id,
          amountMinor:amount.toString(),
          lessonCount,
          obligationId,
          reused:false
        });
      }

      return {month:target.month,statements};
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

      const material=await this.consumeLessonMaterials(
        client,context,lesson.host_booking_id
      );
      const revenue=await this.lessonRevenueBases(
        client,context.tenantId,lesson,earnedRevenue,attendedCount
      );
      const trainer=await this.calculateTrainerCost(
        client,context.tenantId,lesson,attendedCount,revenue
      );
      const room=await this.calculateRoomCost(
        client,context.tenantId,lesson,false
      );
      const margin=
        earnedRevenue-trainer.amount-room.amount-material.amount;

      const snapshot=await client.query(
        `INSERT INTO dance_lesson_profitability(
           tenant_id,lesson_id,booked_count,attended_count,
           earned_revenue_minor,trainer_cost_minor,room_cost_minor,
           other_cost_minor,contribution_margin_minor,currency,
           calculation_snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(tenant_id,lesson_id) DO NOTHING
         RETURNING *`,
        [
          context.tenantId,lessonId,bookedCount,attendedCount,
          earnedRevenue.toString(),trainer.amount.toString(),
          room.amount.toString(),material.amount.toString(),
          margin.toString(),lesson.currency,
          JSON.stringify({
            trainer:trainer.snapshot,
            room:room.snapshot,
            materials:material.snapshot,
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
        materialCostMinor:material.amount.toString(),
        marginMinor:margin.toString()
      });
      return snapshot.rows[0]??{
        lesson_id:lessonId,
        attended_count:attendedCount,
        earned_revenue_minor:earnedRevenue.toString(),
        trainer_cost_minor:trainer.amount.toString(),
        room_cost_minor:room.amount.toString(),
        other_cost_minor:material.amount.toString(),
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

      await this.cancelDirectLessonChargesTx(
        client,context,lessonId
      );

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
         SET status='CANCELLED_IN_TIME',
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND lesson_id=$2
           AND status NOT IN ('ATTENDED','LATE','CANCELLED_IN_TIME')`,
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

  async payrollStatements(
    context:TenantContext,
    input:{from?:string;to?:string}
  ){
    const scopeIds=await this.scopeIds(context,"dance.read");
    const from=input.from?new Date(input.from):new Date(new Date().getFullYear(),new Date().getMonth(),1);
    const to=input.to?new Date(input.to):new Date(Date.now()+86400000);
    if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<=from){
      throw new BadRequestException("Некорректный период ведомостей");
    }
    const periodFrom=from.toISOString().slice(0,10);
    const periodTo=new Date(to.getTime()-86400000).toISOString().slice(0,10);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           s.id,s.trainer_resource_id,r.name AS trainer_name,
           s.period_from,s.period_to,s.lesson_accrual_minor::text,
           s.base_minor::text,s.guarantee_adjustment_minor::text,
           s.adjustment_minor::text,s.total_minor::text,s.currency,
           s.status,s.payroll_batch_id,s.calculation_snapshot,
           s.finalized_at,s.exported_at,
           pr.id AS review_id,
           coalesce(pr.review_status,'PENDING') AS review_status,
           pr.employee_comment,pr.manager_comment,
           pr.acknowledged_at,pr.disputed_at,pr.resolved_at,
           coalesce((
             SELECT json_agg(json_build_object(
               'id',a.id,
               'adjustmentType',a.adjustment_type,
               'amountMinor',a.amount_minor::text,
               'reason',a.reason,
               'createdAt',a.created_at
             ) ORDER BY a.created_at,a.id)
             FROM trainer_payroll_adjustment a
             WHERE a.tenant_id=s.tenant_id AND a.statement_id=s.id
           ),'[]'::json) AS adjustments
         FROM trainer_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.trainer_resource_id
         LEFT JOIN payroll_statement_review pr
           ON pr.tenant_id=s.tenant_id
          AND pr.statement_kind='DANCE_TRAINER'
          AND pr.statement_id=s.id
         WHERE s.tenant_id=$1
           AND s.period_from=$2::date AND s.period_to=$3::date
           AND (
             $4::uuid[] IS NULL
             OR r.membership_id = ANY($4::uuid[])
           )
         ORDER BY r.name`,
        [context.tenantId,periodFrom,periodTo,scopeIds]
      );
      return result.rows;
    });
  }

  async payrollStatementDetails(
    context:TenantContext,
    statementId:string
  ){
    const scopeIds=await this.scopeIds(context,"dance.read");
    return this.database.withTenantTransaction(context,async client=>{
      const statement=await client.query(
        `SELECT
           s.id,s.trainer_resource_id,r.name AS trainer_name,
           s.period_from,s.period_to,s.lesson_accrual_minor::text,
           s.base_minor::text,s.guarantee_adjustment_minor::text,
           s.adjustment_minor::text,s.total_minor::text,s.currency,
           s.status,s.payroll_batch_id,s.calculation_snapshot,
           s.finalized_at,s.exported_at,r.membership_id,
           pr.id AS review_id,
           coalesce(pr.review_status,'PENDING') AS review_status,
           pr.employee_comment,pr.manager_comment,
           pr.acknowledged_at,pr.disputed_at,pr.resolved_at
         FROM trainer_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.trainer_resource_id
         LEFT JOIN payroll_statement_review pr
           ON pr.tenant_id=s.tenant_id
          AND pr.statement_kind='DANCE_TRAINER'
          AND pr.statement_id=s.id
         WHERE s.tenant_id=$1 AND s.id=$2
           AND (
             $3::uuid[] IS NULL
             OR r.membership_id=ANY($3::uuid[])
           )`,
        [context.tenantId,statementId,scopeIds]
      );
      const row=statement.rows[0];
      if(!row) throw new NotFoundException("Ведомость не найдена");

      const lessons=await client.query(
        `SELECT
           a.id AS accrual_id,a.lesson_id,
           l.starts_at,l.ends_at,l.lesson_type,
           coalesce(g.name,l.lesson_type) AS lesson_name,
           p.name AS program_name,
           svc.name AS service_name,
           a.attended_count,
           a.eligible_revenue_minor::text,
           a.amount_minor::text,
           a.currency,a.status,a.rule_snapshot,
           cp.id AS plan_id,cp.calculation_type,cp.revenue_basis
         FROM trainer_compensation_accrual a
         JOIN dance_lesson l
           ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
         LEFT JOIN dance_group g
           ON g.tenant_id=l.tenant_id AND g.id=l.group_id
         LEFT JOIN dance_program p
           ON p.tenant_id=g.tenant_id AND p.id=g.program_id
         LEFT JOIN service_booking b
           ON b.tenant_id=l.tenant_id AND b.id=l.host_booking_id
         LEFT JOIN service_catalog_item svc
           ON svc.tenant_id=b.tenant_id AND svc.id=b.service_id
         LEFT JOIN trainer_compensation_plan cp
           ON cp.tenant_id=a.tenant_id AND cp.id=a.plan_id
         WHERE a.tenant_id=$1
           AND a.trainer_resource_id=$2
           AND (l.starts_at AT TIME ZONE l.timezone)::date
               BETWEEN $3::date AND $4::date
           AND a.status IN ('APPROVED','EXPORTED')
         ORDER BY l.starts_at,a.id`,
        [
          context.tenantId,row.trainer_resource_id,
          row.period_from,row.period_to
        ]
      );

      const adjustments=await client.query(
        `SELECT
           id,adjustment_type,amount_minor::text,reason,created_at
         FROM trainer_payroll_adjustment
         WHERE tenant_id=$1 AND statement_id=$2
         ORDER BY created_at,id`,
        [context.tenantId,statementId]
      );

      const reviewEvents=row.review_id
        ?await client.query(
          `SELECT
             id,event_type,actor_membership_id,previous_status,new_status,
             comment,statement_total_minor_snapshot::text,metadata,created_at
           FROM payroll_statement_review_event
           WHERE tenant_id=$1 AND review_id=$2
           ORDER BY created_at,id`,
          [context.tenantId,row.review_id]
        )
        :{rows:[] as Array<Record<string,unknown>>};

      let payrollSources:Array<Record<string,unknown>>=[];
      if(row.payroll_batch_id&&row.membership_id){
        const sources=await client.query(
          `SELECT
             id,source_type,source_key,gross_minor::text,
             deduction_minor::text,metadata
           FROM payroll_accrual_component
           WHERE tenant_id=$1
             AND batch_id=$2
             AND employee_ref=$3
           ORDER BY source_type,source_key`,
          [
            context.tenantId,row.payroll_batch_id,
            String(row.membership_id)
          ]
        );
        payrollSources=sources.rows;
      }

      return {
        statement:row,
        lessons:lessons.rows,
        adjustments:adjustments.rows,
        payrollSources,
        reviewEvents:reviewEvents.rows
      };
    });
  }

  async addPayrollAdjustment(
    context:TenantContext,
    statementId:string,
    input:{
      type:"BONUS"|"DEDUCTION"|"CORRECTION"|"OTHER";
      amountMinor:string;
      reason:string;
    }
  ){
    await this.requireAll(context,"dance.write");
    if(!/^-?\d+$/.test(input.amountMinor)||BigInt(input.amountMinor)===0n){
      throw new BadRequestException("Некорректная сумма корректировки");
    }
    const reason=input.reason?.trim();
    if(!reason||reason.length<3||reason.length>500){
      throw new BadRequestException("Укажите причину корректировки");
    }
    if(!["BONUS","DEDUCTION","CORRECTION","OTHER"].includes(input.type)){
      throw new BadRequestException("Некорректный тип корректировки");
    }

    const raw=BigInt(input.amountMinor);
    const signed=
      input.type==="DEDUCTION"
        ?-(raw<0n?-raw:raw)
        :raw;

    return this.database.withTenantTransaction(context,async client=>{
      const statement=await client.query<{
        id:string;
        status:string;
        total_minor:string;
      }>(
        `SELECT id,status,total_minor::text
         FROM trainer_payroll_statement
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,statementId]
      );
      const row=statement.rows[0];
      if(!row) throw new NotFoundException("Ведомость не найдена");
      if(row.status!=="FINALIZED"){
        throw new ConflictException(
          "Корректировать можно только финализированную, но ещё не экспортированную ведомость"
        );
      }
      if(BigInt(row.total_minor)+signed<0n){
        throw new ConflictException("Корректировка делает зарплату отрицательной");
      }

      const result=await client.query(
        `INSERT INTO trainer_payroll_adjustment(
           tenant_id,statement_id,adjustment_type,amount_minor,reason,
           created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6)
         RETURNING
           id,statement_id,adjustment_type,amount_minor::text,reason,created_at`,
        [
          context.tenantId,statementId,input.type,signed.toString(),reason,
          context.membershipId
        ]
      );

      await this.audit(
        client,context,"dance.payroll_adjustment_added",
        "trainer_payroll_statement",statementId,{
          type:input.type,
          amountMinor:signed.toString(),
          reason
        }
      );
      return result.rows[0];
    });
  }

  async reviewPayrollStatement(
    context:TenantContext,
    statementId:string,
    input:{
      status:"ACKNOWLEDGED"|"DISPUTED";
      comment?:string;
    }
  ){
    const scopeIds=await this.scopeIds(context,"dance.read");
    const comment=input.comment?.trim()||null;
    if(!["ACKNOWLEDGED","DISPUTED"].includes(input.status)){
      throw new BadRequestException("Некорректный статус согласования");
    }
    if(input.status==="DISPUTED"&&(!comment||comment.length<3)){
      throw new BadRequestException("Опишите причину несогласия");
    }
    if(comment&&comment.length>1000){
      throw new BadRequestException("Комментарий слишком длинный");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const statement=await client.query<{
        id:string;
        trainer_resource_id:string;
        total_minor:string;
        currency:string;
        status:string;
        membership_id:string|null;
      }>(
        `SELECT
           s.id,s.trainer_resource_id,s.total_minor::text,s.currency,
           s.status,r.membership_id
         FROM trainer_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.trainer_resource_id
         WHERE s.tenant_id=$1 AND s.id=$2
           AND (
             $3::uuid[] IS NULL OR
             r.membership_id=ANY($3::uuid[])
           )
         FOR UPDATE OF s`,
        [context.tenantId,statementId,scopeIds]
      );
      const row=statement.rows[0];
      if(!row) throw new NotFoundException("Ведомость не найдена");
      if(!["FINALIZED","EXPORTED","PAID"].includes(row.status)){
        throw new ConflictException(
          "Согласовать можно только закрытую ведомость"
        );
      }
      if(
        scopeIds!==null &&
        row.membership_id!==context.membershipId
      ){
        throw new ForbiddenException(
          "Сотрудник может согласовать только собственную ведомость"
        );
      }

      const existing=await client.query<{
        id:string;
        review_status:string;
      }>(
        `SELECT id,review_status
         FROM payroll_statement_review
         WHERE tenant_id=$1
           AND statement_kind='DANCE_TRAINER'
           AND statement_id=$2
         FOR UPDATE`,
        [context.tenantId,statementId]
      );
      const previous=existing.rows[0]?.review_status??"PENDING";

      const review=await client.query<{
        id:string;
        review_status:string;
      }>(
        `INSERT INTO payroll_statement_review(
           tenant_id,statement_kind,statement_id,employee_resource_id,
           reviewer_membership_id,review_status,
           statement_total_minor_snapshot,currency,employee_comment,
           acknowledged_at,disputed_at
         ) VALUES(
           $1,'DANCE_TRAINER',$2,$3,$4,$5,$6,$7,$8,
           CASE WHEN $5='ACKNOWLEDGED' THEN now() ELSE NULL END,
           CASE WHEN $5='DISPUTED' THEN now() ELSE NULL END
         )
         ON CONFLICT(tenant_id,statement_kind,statement_id)
         DO UPDATE SET
           reviewer_membership_id=EXCLUDED.reviewer_membership_id,
           review_status=EXCLUDED.review_status,
           statement_total_minor_snapshot=EXCLUDED.statement_total_minor_snapshot,
           currency=EXCLUDED.currency,
           employee_comment=EXCLUDED.employee_comment,
           manager_comment=NULL,
           acknowledged_at=EXCLUDED.acknowledged_at,
           disputed_at=EXCLUDED.disputed_at,
           resolved_at=NULL,
           resolved_by_membership_id=NULL,
           updated_at=now()
         RETURNING id,review_status`,
        [
          context.tenantId,statementId,row.trainer_resource_id,
          context.membershipId,input.status,row.total_minor,row.currency,comment
        ]
      );
      const reviewRow=review.rows[0];
      if(!reviewRow) throw new Error("PAYROLL_REVIEW_SAVE_FAILED");

      await client.query(
        `INSERT INTO payroll_statement_review_event(
           tenant_id,review_id,event_type,actor_membership_id,
           previous_status,new_status,comment,
           statement_total_minor_snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          context.tenantId,reviewRow.id,input.status,
          context.membershipId,previous,input.status,comment,row.total_minor
        ]
      );
      await this.audit(
        client,context,"dance.payroll_review_"+input.status.toLowerCase(),
        "trainer_payroll_statement",statementId,{
          reviewId:reviewRow.id,
          totalMinor:row.total_minor,
          comment
        }
      );
      return {
        id:reviewRow.id,
        status:reviewRow.review_status
      };
    });
  }

  async resolvePayrollReview(
    context:TenantContext,
    reviewId:string,
    input:{
      status:"RESOLVED"|"WAIVED";
      comment:string;
    }
  ){
    await this.requireAll(context,"dance.write");
    const comment=input.comment?.trim();
    if(!["RESOLVED","WAIVED"].includes(input.status)){
      throw new BadRequestException("Некорректный статус решения");
    }
    if(!comment||comment.length<3||comment.length>1000){
      throw new BadRequestException("Укажите решение по ведомости");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const review=await client.query<{
        id:string;
        statement_id:string;
        review_status:string;
        statement_total_minor_snapshot:string;
      }>(
        `SELECT
           id,statement_id,review_status,
           statement_total_minor_snapshot::text
         FROM payroll_statement_review
         WHERE tenant_id=$1
           AND id=$2
           AND statement_kind='DANCE_TRAINER'
         FOR UPDATE`,
        [context.tenantId,reviewId]
      );
      const row=review.rows[0];
      if(!row) throw new NotFoundException("Согласование не найдено");
      if(["RESOLVED","WAIVED"].includes(row.review_status)){
        return {id:row.id,status:row.review_status,changed:false};
      }
      if(
        input.status==="RESOLVED" &&
        row.review_status!=="DISPUTED"
      ){
        throw new ConflictException(
          "Разрешить можно только спорную ведомость"
        );
      }

      const updated=await client.query(
        `UPDATE payroll_statement_review
         SET review_status=$3,
             manager_comment=$4,
             resolved_at=now(),
             resolved_by_membership_id=$5,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,review_status`,
        [
          context.tenantId,reviewId,input.status,comment,
          context.membershipId
        ]
      );

      await client.query(
        `INSERT INTO payroll_statement_review_event(
           tenant_id,review_id,event_type,actor_membership_id,
           previous_status,new_status,comment,
           statement_total_minor_snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          context.tenantId,reviewId,input.status,context.membershipId,
          row.review_status,input.status,comment,
          row.statement_total_minor_snapshot
        ]
      );
      await this.audit(
        client,context,"dance.payroll_review_"+input.status.toLowerCase(),
        "trainer_payroll_statement",row.statement_id,{
          reviewId,
          comment
        }
      );
      return {
        ...updated.rows[0],
        changed:true
      };
    });
  }

  async approveCompensation(
    context:TenantContext,
    input:{from:string;to:string}
  ){
    await this.requireAll(context,"dance.write");
    const {from,to}=this.dateRange(input.from,input.to);
    return this.database.withTenantTransaction(context,async client=>{
      const periodFrom=from.toISOString().slice(0,10);
      const periodTo=new Date(to.getTime()-86400000).toISOString().slice(0,10);
      const locked=await client.query(
        `SELECT 1
         FROM trainer_payroll_statement s
         WHERE s.tenant_id=$1
           AND s.period_from=$2::date
           AND s.period_to=$3::date
           AND s.status IN ('EXPORTED','PAID')
           AND EXISTS(
             SELECT 1
             FROM trainer_compensation_accrual a
             JOIN dance_lesson l
               ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
             WHERE a.tenant_id=s.tenant_id
               AND a.trainer_resource_id=s.trainer_resource_id
               AND a.status='CALCULATED'
               AND l.starts_at>=$4 AND l.starts_at<$5
           )
         LIMIT 1`,
        [context.tenantId,periodFrom,periodTo,from,to]
      );
      if(locked.rowCount){
        throw new ConflictException(
          "Ведомость периода уже экспортирована в payroll. Поздние начисления оформите корректировкой в новом периоде."
        );
      }

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
      const statements=await this.buildTrainerPayrollStatementsTx(
        client,context.tenantId,from,to
      );
      return {approved:result.rowCount,statements};
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

      const periodFrom=from.toISOString().slice(0,10);
      const periodTo=new Date(to.getTime()-86400000).toISOString().slice(0,10);

      await this.buildTrainerPayrollStatementsTx(
        client,context.tenantId,from,to
      );

      const disputed=await client.query(
        `SELECT pr.id
         FROM payroll_statement_review pr
         JOIN trainer_payroll_statement s
           ON s.tenant_id=pr.tenant_id AND s.id=pr.statement_id
         WHERE pr.tenant_id=$1
           AND pr.statement_kind='DANCE_TRAINER'
           AND pr.review_status='DISPUTED'
           AND s.period_from=$2::date
           AND s.period_to=$3::date
         LIMIT 1`,
        [context.tenantId,periodFrom,periodTo]
      );
      if(disputed.rowCount){
        throw new ConflictException(
          "Есть спорная ведомость. Сначала разрешите спор или оформите управленческое исключение."
        );
      }

      const missing=await client.query(
        `SELECT s.id
         FROM trainer_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.trainer_resource_id
         WHERE s.tenant_id=$1
           AND s.period_from=$2::date AND s.period_to=$3::date
           AND s.status='FINALIZED'
           AND r.membership_id IS NULL
         LIMIT 1`,
        [context.tenantId,periodFrom,periodTo]
      );
      if(missing.rowCount)
        throw new ConflictException("У одного из тренеров не привязан сотрудник tenant membership");

      const statements=await client.query<{
        id:string;
        trainer_resource_id:string;
        membership_id:string;
        total_minor:string;
      }>(
        `SELECT
           s.id,s.trainer_resource_id,r.membership_id,s.total_minor::text
         FROM trainer_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.trainer_resource_id
         WHERE s.tenant_id=$1
           AND s.period_from=$2::date AND s.period_to=$3::date
           AND s.status='FINALIZED'
         ORDER BY s.id
         FOR UPDATE OF s`,
        [context.tenantId,periodFrom,periodTo]
      );

      const totals=new Map<string,bigint>();
      for(const statement of statements.rows){
        totals.set(
          statement.membership_id,
          (totals.get(statement.membership_id)??0n)+BigInt(statement.total_minor)
        );
        await client.query(
          `INSERT INTO payroll_accrual_component(
             tenant_id,batch_id,employee_ref,source_type,source_key,
             gross_minor,deduction_minor,metadata
           ) VALUES(
             $1,$2,$3,'DANCE_TRAINER_STATEMENT',$4,$5,0,$6
           )
           ON CONFLICT(
             tenant_id,batch_id,employee_ref,source_type,source_key
           ) DO UPDATE SET
             gross_minor=EXCLUDED.gross_minor,
             deduction_minor=0,
             metadata=EXCLUDED.metadata,
             updated_at=now()`,
          [
            context.tenantId,input.batchId,statement.membership_id,
            statement.id,statement.total_minor,
            JSON.stringify({
              statementId:statement.id,
              trainerResourceId:statement.trainer_resource_id,
              periodFrom,
              periodTo
            })
          ]
        );
      }

      const statementIds=statements.rows.map((row)=>row.id);
      if(statementIds.length){
        await client.query(
          `UPDATE trainer_payroll_statement
           SET status='EXPORTED',payroll_batch_id=$3,exported_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='FINALIZED'`,
          [context.tenantId,statementIds,input.batchId]
        );
      }

      const exportedAccruals=await client.query(
        `UPDATE trainer_compensation_accrual a
         SET status='EXPORTED',payroll_batch_id=$4
         FROM dance_lesson l
         WHERE a.tenant_id=$1
           AND l.tenant_id=a.tenant_id AND l.id=a.lesson_id
           AND l.starts_at>=$2 AND l.starts_at<$3
           AND a.status='APPROVED'
         RETURNING a.id`,
        [context.tenantId,from,to,input.batchId]
      );

      return {
        trainers:totals.size,
        accruals:exportedAccruals.rowCount,
        statements:statementIds.length
      };
    });
  }

  private async buildTrainerPayrollStatementsTx(
    client:PoolClient,
    tenantId:string,
    from:Date,
    to:Date
  ){
    const periodFrom=from.toISOString().slice(0,10);
    const periodTo=new Date(to.getTime()-86400000).toISOString().slice(0,10);

    const trainers=await client.query<{
      trainer_resource_id:string;
      currency:string;
      lesson_accrual_minor:string;
    }>(
      `WITH candidates AS (
         SELECT DISTINCT a.trainer_resource_id
         FROM trainer_compensation_accrual a
         JOIN dance_lesson l
           ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
         WHERE a.tenant_id=$1
           AND l.starts_at>=$2 AND l.starts_at<$3
           AND a.status IN ('APPROVED','EXPORTED')
         UNION
         SELECT DISTINCT p.trainer_resource_id
         FROM trainer_payroll_profile p
         WHERE p.tenant_id=$1
           AND p.status='ACTIVE'
           AND p.valid_from <= $4::date
           AND (p.valid_to IS NULL OR p.valid_to >= $5::date)
         UNION
         SELECT DISTINCT p.trainer_resource_id
         FROM trainer_compensation_plan p
         WHERE p.tenant_id=$1
           AND p.status='ACTIVE'
           AND p.valid_from <= $4::date
           AND (p.valid_to IS NULL OR p.valid_to >= $5::date)
           AND (
             p.minimum_guarantee_minor>0
             OR EXISTS(
               SELECT 1
               FROM trainer_compensation_component c
               WHERE c.tenant_id=p.tenant_id
                 AND c.plan_id=p.id
                 AND c.component_type IN ('MONTHLY_BASE','DAILY_BASE')
             )
           )
       ),
       period_accrual AS (
         SELECT
           a.trainer_resource_id,
           min(a.currency)::text AS currency,
           coalesce(sum(a.amount_minor),0)::text AS lesson_accrual_minor
         FROM trainer_compensation_accrual a
         JOIN dance_lesson l
           ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
         WHERE a.tenant_id=$1
           AND l.starts_at>=$2 AND l.starts_at<$3
           AND a.status IN ('APPROVED','EXPORTED')
         GROUP BY a.trainer_resource_id
       )
       SELECT
         c.trainer_resource_id,
         coalesce(p.currency,'RUB')::text AS currency,
         coalesce(p.lesson_accrual_minor,'0')::text AS lesson_accrual_minor
       FROM candidates c
       LEFT JOIN period_accrual p
         ON p.trainer_resource_id=c.trainer_resource_id
       ORDER BY c.trainer_resource_id`,
      [tenantId,from,to,periodTo,periodFrom]
    );

    const output:Array<Record<string,unknown>>=[];
    for(const row of trainers.rows){
      const profileResult=await client.query<{
        id:string;
        monthly_base_minor:string;
        daily_base_minor:string;
        minimum_guarantee_minor:string;
        currency:string;
      }>(
        `SELECT
           id,monthly_base_minor::text,daily_base_minor::text,
           minimum_guarantee_minor::text,currency
         FROM trainer_payroll_profile
         WHERE tenant_id=$1
           AND trainer_resource_id=$2
           AND status='ACTIVE'
           AND valid_from <= $3::date
           AND (valid_to IS NULL OR valid_to >= $4::date)
         ORDER BY valid_from DESC,id
         LIMIT 1`,
        [tenantId,row.trainer_resource_id,periodTo,periodFrom]
      );
      const profile=profileResult.rows[0]??null;

      const plans=await client.query<{
        id:string;
        minimum_guarantee_minor:string;
      }>(
        `WITH used AS (
           SELECT DISTINCT a.plan_id AS id
           FROM trainer_compensation_accrual a
           JOIN dance_lesson l
             ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
           WHERE a.tenant_id=$1
             AND a.trainer_resource_id=$2
             AND a.plan_id IS NOT NULL
             AND l.starts_at>=$3 AND l.starts_at<$4
             AND a.status IN ('APPROVED','EXPORTED')
         ),
         fixed AS (
           SELECT DISTINCT p.id
           FROM trainer_compensation_plan p
           WHERE p.tenant_id=$1
             AND p.trainer_resource_id=$2
             AND p.status='ACTIVE'
             AND p.valid_from <= $5::date
             AND (p.valid_to IS NULL OR p.valid_to >= $6::date)
             AND (
               p.minimum_guarantee_minor>0
               OR EXISTS(
                 SELECT 1
                 FROM trainer_compensation_component c
                 WHERE c.tenant_id=p.tenant_id
                   AND c.plan_id=p.id
                   AND c.component_type IN ('MONTHLY_BASE','DAILY_BASE')
               )
             )
         )
         SELECT p.id,p.minimum_guarantee_minor::text
         FROM trainer_compensation_plan p
         WHERE p.tenant_id=$1
           AND p.id IN (
             SELECT id FROM used
             UNION
             SELECT id FROM fixed
           )
         ORDER BY p.id`,
        [tenantId,row.trainer_resource_id,from,to,periodTo,periodFrom]
      );
      const planIds=plans.rows.map((plan)=>plan.id);

      let base=0n;
      let guarantee=0n;
      const baseSnapshot:Array<Record<string,unknown>>=[];

      for(const plan of plans.rows){
        const value=BigInt(plan.minimum_guarantee_minor);
        if(value>guarantee) guarantee=value;
      }

      if(profile){
        guarantee=BigInt(profile.minimum_guarantee_minor);
        const monthly=BigInt(profile.monthly_base_minor);
        if(monthly>0n){
          base+=monthly;
          baseSnapshot.push({
            source:"PROFILE",
            profileId:profile.id,
            componentType:"MONTHLY_BASE",
            units:1,
            amountMinor:monthly.toString()
          });
        }

        const daily=BigInt(profile.daily_base_minor);
        if(daily>0n){
          const worked=await client.query<{days:number}>(
            `SELECT count(
               DISTINCT (l.starts_at AT TIME ZONE l.timezone)::date
             )::integer AS days
             FROM trainer_compensation_accrual a
             JOIN dance_lesson l
               ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
             WHERE a.tenant_id=$1
               AND a.trainer_resource_id=$2
               AND l.starts_at>=$3 AND l.starts_at<$4
               AND a.status IN ('APPROVED','EXPORTED')`,
            [tenantId,row.trainer_resource_id,from,to]
          );
          const units=Math.max(0,worked.rows[0]?.days??0);
          const amount=daily*BigInt(units);
          base+=amount;
          baseSnapshot.push({
            source:"PROFILE",
            profileId:profile.id,
            componentType:"DAILY_BASE",
            units,
            rateMinor:daily.toString(),
            amountMinor:amount.toString()
          });
        }
      }else if(planIds.length){
        const legacy=await client.query<{
          monthly_base_minor:string;
          daily_base_minor:string;
        }>(
          `SELECT
             coalesce(max(amount_minor) FILTER (
               WHERE component_type='MONTHLY_BASE'
             ),0)::text AS monthly_base_minor,
             coalesce(max(amount_minor) FILTER (
               WHERE component_type='DAILY_BASE'
             ),0)::text AS daily_base_minor
           FROM trainer_compensation_component
           WHERE tenant_id=$1
             AND plan_id=ANY($2::uuid[])
             AND component_type IN ('DAILY_BASE','MONTHLY_BASE')`,
          [tenantId,planIds]
        );
        const monthly=BigInt(legacy.rows[0]?.monthly_base_minor??"0");
        const daily=BigInt(legacy.rows[0]?.daily_base_minor??"0");
        if(monthly>0n){
          base+=monthly;
          baseSnapshot.push({
            source:"LEGACY_MAX",
            componentType:"MONTHLY_BASE",
            units:1,
            amountMinor:monthly.toString()
          });
        }
        if(daily>0n){
          const worked=await client.query<{days:number}>(
            `SELECT count(
               DISTINCT (l.starts_at AT TIME ZONE l.timezone)::date
             )::integer AS days
             FROM trainer_compensation_accrual a
             JOIN dance_lesson l
               ON l.tenant_id=a.tenant_id AND l.id=a.lesson_id
             WHERE a.tenant_id=$1
               AND a.trainer_resource_id=$2
               AND l.starts_at>=$3 AND l.starts_at<$4
               AND a.status IN ('APPROVED','EXPORTED')`,
            [tenantId,row.trainer_resource_id,from,to]
          );
          const units=Math.max(0,worked.rows[0]?.days??0);
          const amount=daily*BigInt(units);
          base+=amount;
          baseSnapshot.push({
            source:"LEGACY_MAX",
            componentType:"DAILY_BASE",
            units,
            rateMinor:daily.toString(),
            amountMinor:amount.toString()
          });
        }
      }

      const lesson=BigInt(row.lesson_accrual_minor);
      const subtotal=lesson+base;
      const adjustment=guarantee>subtotal?guarantee-subtotal:0n;
      const total=subtotal+adjustment;
      const currency=profile?.currency??row.currency;

      const statement=await client.query(
        `INSERT INTO trainer_payroll_statement(
           tenant_id,trainer_resource_id,period_from,period_to,
           lesson_accrual_minor,base_minor,guarantee_adjustment_minor,
           total_minor,currency,status,calculation_snapshot,finalized_at
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,'FINALIZED',$10,now()
         )
         ON CONFLICT(tenant_id,trainer_resource_id,period_from,period_to)
         DO UPDATE SET
           lesson_accrual_minor=EXCLUDED.lesson_accrual_minor,
           base_minor=EXCLUDED.base_minor,
           guarantee_adjustment_minor=EXCLUDED.guarantee_adjustment_minor,
           total_minor=
             EXCLUDED.total_minor+trainer_payroll_statement.adjustment_minor,
           currency=EXCLUDED.currency,
           status='FINALIZED',
           calculation_snapshot=EXCLUDED.calculation_snapshot,
           finalized_at=now(),
           updated_at=now()
         WHERE trainer_payroll_statement.status IN ('DRAFT','FINALIZED')
         RETURNING id,trainer_resource_id,lesson_accrual_minor::text,
                   base_minor::text,guarantee_adjustment_minor::text,
                   total_minor::text,status`,
        [
          tenantId,row.trainer_resource_id,periodFrom,periodTo,
          lesson.toString(),base.toString(),adjustment.toString(),
          total.toString(),currency,
          JSON.stringify({
            profileId:profile?.id??null,
            planIds,
            lessonAccrualMinor:lesson.toString(),
            baseComponents:baseSnapshot,
            minimumGuaranteeMinor:guarantee.toString()
          })
        ]
      );
      if(statement.rows[0]) output.push(statement.rows[0]);
    }
    return output;
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

  private async cancelDirectLessonChargesTx(
    client:PoolClient,
    context:TenantContext,
    lessonId:string
  ):Promise<void>{
    const charges=await client.query<{
      id:string;
      payer_party_id:string;
      currency:string;
      obligation_id:string|null;
      settled_minor:string;
    }>(
      `SELECT
         c.id,c.payer_party_id,c.currency,c.obligation_id,
         coalesce(o.settled_minor,0)::text AS settled_minor
       FROM dance_student_charge c
       LEFT JOIN financial_obligation o
         ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
       WHERE c.tenant_id=$1
         AND c.source_type='LESSON'
         AND c.source_id=$2
         AND c.status<>'CANCELLED'
       ORDER BY c.id
       FOR UPDATE OF c`,
      [context.tenantId,lessonId]
    );

    for(const charge of charges.rows){
      let settled=BigInt(charge.settled_minor);

      if(charge.obligation_id){
        const obligation=await client.query<{settled_minor:string}>(
          `SELECT settled_minor::text
           FROM financial_obligation
           WHERE tenant_id=$1 AND id=$2
           FOR UPDATE`,
          [context.tenantId,charge.obligation_id]
        );
        settled=BigInt(obligation.rows[0]?.settled_minor??"0");

        await client.query(
          `UPDATE financial_obligation
           SET status='CANCELLED',updated_at=now()
           WHERE tenant_id=$1 AND id=$2
             AND status<>'CANCELLED'`,
          [context.tenantId,charge.obligation_id]
        );
      }else{
        await client.query(
          `UPDATE dance_student_charge
           SET status='CANCELLED',updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,charge.id]
        );
      }

      if(settled<=0n) continue;

      await client.query(
        `INSERT INTO financial_obligation(
           tenant_id,direction,party_id,source_type,source_id,
           currency,amount_minor,due_at
         ) VALUES(
           $1,'PAYABLE',$2,'DANCE_LESSON_REFUND',$3,$4,$5,now()
         )
         ON CONFLICT(tenant_id,direction,source_type,source_id)
         DO NOTHING`,
        [
          context.tenantId,charge.payer_party_id,charge.id,
          charge.currency,settled.toString()
        ]
      );
    }
  }

  private async consumeLessonMaterials(
    client:PoolClient,
    context:TenantContext,
    bookingId:string
  ):Promise<{amount:bigint;snapshot:Record<string,unknown>}>{
    const lines=await client.query<{
      id:string;
      warehouse_id:string;
      sku_id:string;
      planned_quantity_milli:string;
      consumed_quantity_milli:string;
      unit_cost_minor_snapshot:string;
    }>(
      `SELECT
         id,warehouse_id,sku_id,planned_quantity_milli::text,
         consumed_quantity_milli::text,unit_cost_minor_snapshot::text
       FROM service_booking_material
       WHERE tenant_id=$1 AND booking_id=$2
       ORDER BY id
       FOR UPDATE`,
      [context.tenantId,bookingId]
    );

    const snapshot:Array<Record<string,unknown>>=[];
    for(const line of lines.rows){
      let consumed=BigInt(line.consumed_quantity_milli);
      const planned=BigInt(line.planned_quantity_milli);
      const remaining=planned-consumed;
      if(remaining>0n){
        const movement=await this.inventory.consumeForService(
          client,context,{
            bookingId,
            warehouseId:line.warehouse_id,
            materialLineId:line.id,
            skuId:line.sku_id,
            quantityMilli:remaining,
            idempotencyKey:"dance-complete"
          }
        );
        if(movement.applied){
          const updated=await client.query<{consumed_quantity_milli:string}>(
            `UPDATE service_booking_material
             SET consumed_quantity_milli=consumed_quantity_milli+$3::bigint,
                 updated_at=now()
             WHERE tenant_id=$1 AND id=$2
             RETURNING consumed_quantity_milli::text`,
            [context.tenantId,line.id,remaining.toString()]
          );
          consumed=BigInt(
            updated.rows[0]?.consumed_quantity_milli??consumed.toString()
          );
        }
      }
      snapshot.push({
        materialLineId:line.id,
        skuId:line.sku_id,
        consumedQuantityMilli:consumed.toString(),
        unitCostMinor:line.unit_cost_minor_snapshot
      });
    }

    const cost=await client.query<{amount:string}>(
      `SELECT coalesce(sum(
         (unit_cost_minor_snapshot*consumed_quantity_milli+500)/1000
       ),0)::text AS amount
       FROM service_booking_material
       WHERE tenant_id=$1 AND booking_id=$2`,
      [context.tenantId,bookingId]
    );
    return {
      amount:BigInt(cost.rows[0]?.amount??"0"),
      snapshot:{lines:snapshot}
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
         AND (service_id IS NULL OR service_id=$5::uuid)
         AND (dance_program_id IS NULL OR dance_program_id=$6::uuid)
         AND (dance_group_id IS NULL OR dance_group_id=$7::uuid)
         AND (branch_id IS NULL OR branch_id=$8::uuid)
       ORDER BY
         (
           (lesson_type IS NOT NULL)::int +
           (service_id IS NOT NULL)::int +
           (dance_program_id IS NOT NULL)::int +
           (dance_group_id IS NOT NULL)::int +
           (branch_id IS NOT NULL)::int
         ) DESC,
         priority ASC,
         valid_from DESC
       LIMIT 1`,
      [
        tenantId,lesson.trainer_resource_id,
        new Date(lesson.starts_at).toISOString().slice(0,10),
        lesson.lesson_type,
        lesson.service_id??null,
        lesson.program_id??null,
        lesson.group_id??null,
        lesson.branch_id??null
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
    const componentSnapshot:Array<Record<string,unknown>>=[];
    if(plan.calculation_type==="COMPOSITE"){
      const components=await client.query<any>(
        `SELECT *
         FROM trainer_compensation_component
         WHERE tenant_id=$1 AND plan_id=$2
         ORDER BY priority,id`,
        [tenantId,plan.id]
      );
      for(const component of components.rows){
        const componentEligible=
          component.revenue_basis==="PAID"?revenue.paid:
          component.revenue_basis==="LIST"?revenue.list:
          component.revenue_basis==="BILLED"?revenue.billed:
          revenue.earned;
        let value=0n;
        switch(component.component_type){
          case "FIXED_PER_LESSON":
            value=BigInt(component.amount_minor); break;
          case "HOURLY":
            value=(BigInt(component.amount_minor)*BigInt(duration)+59n)/60n; break;
          case "PERCENT":
            value=(componentEligible*BigInt(component.percent_bps)+9999n)/10000n; break;
          case "PER_ATTENDEE":
            value=BigInt(component.amount_minor)*BigInt(attendedCount); break;
          case "TIER_BONUS":
            value=BigInt(component.amount_minor)*
              BigInt(Math.max(0,attendedCount-component.threshold_count)); break;
          case "DAILY_BASE":
          case "MONTHLY_BASE":
            value=0n; break;
        }
        amount+=value;
        componentSnapshot.push({
          id:component.id,
          type:component.component_type,
          amountMinor:value.toString(),
          configuredAmountMinor:String(component.amount_minor),
          percentBps:component.percent_bps,
          thresholdCount:component.threshold_count,
          revenueBasis:component.revenue_basis,
          eligibleRevenueMinor:componentEligible.toString()
        });
      }
    }else{
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
        thresholdExtraMinor:String(plan.threshold_extra_minor),
        minimumGuaranteeMinor:String(plan.minimum_guarantee_minor??0),
        components:componentSnapshot
      }
    };
  }

  private async calculateRoomCost(
    client:PoolClient,
    tenantId:string,
    lesson:any,
    cancelled:boolean
  ){
    if(!lesson.room_resource_id){
      return {amount:0n,snapshot:{type:"NO_ROOM"}};
    }

    const resource=await client.query<{
      cost_per_hour_minor:string;
      timezone:string;
    }>(
      `SELECT cost_per_hour_minor::text,timezone
       FROM service_resource
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lesson.room_resource_id]
    );
    const rr=resource.rows[0];
    if(!rr) return {amount:0n,snapshot:{type:"ROOM_MISSING"}};

    const lessonUnits=Math.max(
      1,Number(lesson.room_capacity_units??1)
    );
    const lessonZone=lesson.room_zone_id??null;

    const contractResult=await client.query<any>(
      `SELECT *
       FROM room_rental_contract
       WHERE tenant_id=$1
         AND room_resource_id=$2
         AND status='ACTIVE'
         AND valid_from<=($3::timestamptz AT TIME ZONE $4)::date
         AND (
           valid_to IS NULL
           OR valid_to>=($3::timestamptz AT TIME ZONE $4)::date
         )
         AND (
           zone_id IS NULL
           OR zone_id=$5::uuid
         )
         AND capacity_units >= $6
       ORDER BY
         (zone_id IS NOT NULL) DESC,
         capacity_units ASC,
         valid_from DESC,
         id
       LIMIT 1`,
      [
        tenantId,lesson.room_resource_id,lesson.starts_at,rr.timezone,
        lessonZone,lessonUnits
      ]
    );
    const contract=contractResult.rows[0];

    const duration=Math.max(
      1,Math.round(
        (
          new Date(lesson.ends_at).getTime()-
          new Date(lesson.starts_at).getTime()
        )/60000
      )
    );

    let normal=0n;
    let snapshot:any={
      type:"RESOURCE_HOURLY",
      durationMinutes:duration,
      roomCapacityUnits:lessonUnits,
      roomZoneId:lessonZone
    };

    if(!contract){
      normal=(
        BigInt(rr.cost_per_hour_minor)*
        BigInt(duration)*
        BigInt(lessonUnits)+59n
      )/60n;
      snapshot.costPerHourMinor=rr.cost_per_hour_minor;
    }else{
      const contractUnits=Math.max(1,Number(contract.capacity_units??1));
      const prorate=(amount:bigint)=>
        (amount*BigInt(lessonUnits)+BigInt(contractUnits)-1n)/
        BigInt(contractUnits);

      if(contract.pricing_type==="HOURLY"){
        const minutes=Math.max(duration,contract.minimum_billable_minutes);
        const full=(
          BigInt(contract.hourly_rate_minor)*BigInt(minutes)+59n
        )/60n;
        normal=prorate(full);
        snapshot={
          type:"HOURLY",
          contractId:contract.id,
          durationMinutes:duration,
          billableMinutes:minutes,
          hourlyRateMinor:String(contract.hourly_rate_minor),
          contractCapacityUnits:contractUnits,
          lessonCapacityUnits:lessonUnits,
          roomZoneId:lessonZone,
          capacityProrated:true
        };
      }else if(contract.pricing_type==="FIXED_SLOT"){
        const slot=await client.query<{slot_minor:string}>(
          `SELECT slot_minor::text
           FROM room_rental_slot
           WHERE tenant_id=$1 AND contract_id=$2
             AND weekday=extract(
               isodow from ($3::timestamptz AT TIME ZONE $4)
             )::int
             AND start_minute<=(
               extract(hour from ($3::timestamptz AT TIME ZONE $4))::int*60+
               extract(minute from ($3::timestamptz AT TIME ZONE $4))::int
             )
             AND end_minute>=(
               extract(hour from ($5::timestamptz AT TIME ZONE $4))::int*60+
               extract(minute from ($5::timestamptz AT TIME ZONE $4))::int
             )
           ORDER BY start_minute DESC
           LIMIT 1`,
          [
            tenantId,contract.id,lesson.starts_at,rr.timezone,
            lesson.ends_at
          ]
        );
        const full=BigInt(slot.rows[0]?.slot_minor??contract.slot_minor);
        normal=prorate(full);
        snapshot={
          type:"FIXED_SLOT",
          contractId:contract.id,
          slotMinor:full.toString(),
          contractCapacityUnits:contractUnits,
          lessonCapacityUnits:lessonUnits,
          roomZoneId:lessonZone,
          capacityProrated:true
        };
      }else{
        const weight=BigInt(lessonUnits)*BigInt(duration);
        const totalWeight=await client.query<{weight:string}>(
          `SELECT coalesce(sum(
             l.room_capacity_units::bigint*
             greatest(
               1,
               round(
                 extract(epoch from (l.ends_at-l.starts_at))/60
               )::bigint
             )
           ),0)::text AS weight
           FROM dance_lesson l
           WHERE l.tenant_id=$1
             AND l.room_resource_id=$2
             AND l.status NOT IN (
               'CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER'
             )
             AND (
               $5::uuid IS NULL
               OR l.room_zone_id IS NOT DISTINCT FROM $5::uuid
             )
             AND date_trunc(
               'month',l.starts_at AT TIME ZONE $4
             )=date_trunc(
               'month',$3::timestamptz AT TIME ZONE $4
             )`,
          [
            tenantId,lesson.room_resource_id,lesson.starts_at,
            rr.timezone,contract.zone_id??null
          ]
        );
        const divisor=BigInt(totalWeight.rows[0]?.weight??"0");
        normal=divisor>0n
          ?(
            BigInt(contract.monthly_minor)*weight+
            divisor-1n
          )/divisor
          :0n;
        snapshot={
          type:"FIXED_MONTHLY",
          contractId:contract.id,
          monthlyMinor:String(contract.monthly_minor),
          lessonCapacityMinutes:weight.toString(),
          monthCapacityMinutes:divisor.toString(),
          contractCapacityUnits:contractUnits,
          lessonCapacityUnits:lessonUnits,
          roomZoneId:lessonZone
        };
      }
    }

    if(cancelled&&contract){
      const charged=(
        normal*BigInt(contract.cancellation_charge_bps)+9999n
      )/10000n;
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
             WHEN coalesce(pkg_o.amount_minor,so.amount_minor,0)>0 THEN
               (
                 CASE
                   WHEN coalesce(
                     pe.management_visit_value_minor_snapshot,
                     plan.management_visit_value_minor
                   )>0
                     THEN coalesce(
                       pe.management_visit_value_minor_snapshot,
                       plan.management_visit_value_minor
                     )
                   WHEN sp.visit_limit_snapshot IS NOT NULL
                     THEN sp.price_minor_snapshot/sp.visit_limit_snapshot
                   ELSE 0
                 END
                 * least(
                     coalesce(pkg_o.settled_minor,so.settled_minor,0),
                     coalesce(pkg_o.amount_minor,so.amount_minor,0)
                   )
                 / coalesce(pkg_o.amount_minor,so.amount_minor,1)
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
       LEFT JOIN service_package_entitlement pe
         ON pe.tenant_id=r.tenant_id
        AND pe.id=r.package_entitlement_id
       LEFT JOIN dance_student_charge dc
         ON dc.tenant_id=sp.tenant_id
        AND dc.source_type='PACKAGE'
        AND dc.source_id=sp.id
        AND dc.status<>'CANCELLED'
       LEFT JOIN financial_obligation pkg_o
         ON pkg_o.tenant_id=dc.tenant_id
        AND pkg_o.id=dc.obligation_id
        AND pkg_o.direction='RECEIVABLE'
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
         l.*,g.program_id,b.service_id,b.branch_id,
         tr.membership_id AS trainer_membership_id
       FROM dance_lesson l
       LEFT JOIN dance_group g
         ON g.tenant_id=l.tenant_id AND g.id=l.group_id
       JOIN service_booking b
         ON b.tenant_id=l.tenant_id AND b.id=l.host_booking_id
       LEFT JOIN service_resource tr
         ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
       WHERE l.tenant_id=$1 AND l.id=$2
         AND (
           $3::uuid[] IS NULL
           OR tr.membership_id = ANY($3::uuid[])
           OR (
             l.trainer_resource_id IS NULL
             AND l.created_by_membership_id = ANY($3::uuid[])
           )
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
             LEFT JOIN service_resource tr
               ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
             WHERE lp.tenant_id=s.tenant_id
               AND lp.student_id=s.id
               AND (
                 tr.membership_id = ANY($3::uuid[])
                 OR (
                   l.trainer_resource_id IS NULL
                   AND l.created_by_membership_id = ANY($3::uuid[])
                 )
               )
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
