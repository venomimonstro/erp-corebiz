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

type ComponentType =
  | "FIXED_VISIT"
  | "HOURLY"
  | "PERCENT_REVENUE"
  | "PERCENT_MARGIN";

@Injectable()
export class ServiceEconomicsService {
  constructor(
    private readonly database:DatabaseService,
    private readonly authorization:AuthorizationService
  ) {}

  async compensationPlans(context:TenantContext){
    const scope=await this.payrollReadScope(context);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.id,p.employee_resource_id,r.name AS employee_name,
           p.service_id,s.name AS service_name,p.delivery_format,
           p.branch_id,b.name AS branch_name,p.priority,p.currency,
           p.valid_from,p.valid_to,p.status,p.metadata,
           coalesce((
             SELECT json_agg(json_build_object(
               'id',c.id,'componentType',c.component_type,
               'amountMinor',c.amount_minor::text,
               'percentBps',c.percent_bps,'priority',c.priority
             ) ORDER BY c.priority,c.id)
             FROM service_employee_compensation_component c
             WHERE c.tenant_id=p.tenant_id AND c.plan_id=p.id
           ),'[]'::json) AS components
         FROM service_employee_compensation_plan p
         JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.employee_resource_id
         LEFT JOIN service_catalog_item s
           ON s.tenant_id=p.tenant_id AND s.id=p.service_id
         LEFT JOIN branch b
           ON b.tenant_id=p.tenant_id AND b.id=p.branch_id
         WHERE p.tenant_id=$1
           AND p.status='ACTIVE'
           AND (
             $2::uuid[] IS NULL OR r.membership_id=ANY($2::uuid[])
           )
         ORDER BY r.name,p.priority,s.name NULLS FIRST`,
        [context.tenantId,scope]
      );
      return result.rows;
    });
  }

  async createCompensationPlan(
    context:TenantContext,
    input:{
      employeeResourceId:string;
      serviceId?:string;
      deliveryFormat?:"INDIVIDUAL"|"GROUP"|"SELF_PRACTICE"|"RENTAL";
      branchId?:string;
      priority?:number;
      currency?:string;
      validFrom?:string;
      validTo?:string;
      components:Array<{
        componentType:ComponentType;
        amountMinor?:string|number;
        percentBps?:number;
        priority?:number;
      }>;
      metadata?:Record<string,unknown>;
    }
  ){
    await this.requireAll(context,"service.write");
    await this.requireFinance(context,"finance.write");
    if(!input.employeeResourceId){
      throw new BadRequestException("Выберите сотрудника");
    }
    if(!Array.isArray(input.components)||!input.components.length||input.components.length>20){
      throw new BadRequestException("Добавьте от 1 до 20 компонентов зарплаты");
    }
    const allowed=new Set<ComponentType>([
      "FIXED_VISIT","HOURLY","PERCENT_REVENUE","PERCENT_MARGIN"
    ]);
    const normalized=input.components.map((component,index)=>{
      if(!allowed.has(component.componentType)){
        throw new BadRequestException("Неизвестный компонент зарплаты");
      }
      const amount=String(component.amountMinor??"0");
      if(!/^\d+$/.test(amount)){
        throw new BadRequestException("Некорректная сумма компонента");
      }
      const percent=Math.floor(component.percentBps??0);
      if(percent<0||percent>10000){
        throw new BadRequestException("Процент должен быть от 0 до 100%");
      }
      if(
        ["FIXED_VISIT","HOURLY"].includes(component.componentType) &&
        BigInt(amount)<=0n
      ){
        throw new BadRequestException("Фиксированный компонент должен быть больше нуля");
      }
      if(
        ["PERCENT_REVENUE","PERCENT_MARGIN"].includes(component.componentType) &&
        percent<=0
      ){
        throw new BadRequestException("Процентный компонент должен быть больше нуля");
      }
      return {
        ...component,
        amountMinor:amount,
        percentBps:percent,
        priority:Math.floor(component.priority??100+index)
      };
    });
    const currency=input.currency?.trim().toUpperCase()||"RUB";
    if(!/^[A-Z]{3}$/.test(currency)){
      throw new BadRequestException("Некорректная валюта");
    }
    const priority=Math.floor(input.priority??100);
    if(priority<1||priority>100000){
      throw new BadRequestException("Некорректный приоритет");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const employee=await client.query(
        `SELECT 1 FROM service_resource
         WHERE tenant_id=$1 AND id=$2 AND type='EMPLOYEE' AND status='ACTIVE'`,
        [context.tenantId,input.employeeResourceId]
      );
      if(!employee.rowCount) throw new NotFoundException("Сотрудник не найден");
      if(input.serviceId){
        const service=await client.query(
          `SELECT 1 FROM service_catalog_item
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.serviceId]
        );
        if(!service.rowCount) throw new NotFoundException("Услуга не найдена");
      }
      try{
        const plan=await client.query<{id:string}>(
          `INSERT INTO service_employee_compensation_plan(
             tenant_id,employee_resource_id,service_id,delivery_format,
             branch_id,priority,currency,valid_from,valid_to,metadata
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,coalesce($8::date,current_date),$9::date,$10
           )
           RETURNING id`,
          [
            context.tenantId,input.employeeResourceId,input.serviceId??null,
            input.deliveryFormat??null,input.branchId??null,priority,currency,
            input.validFrom??null,input.validTo??null,
            JSON.stringify(input.metadata??{})
          ]
        );
        const planId=plan.rows[0]?.id;
        if(!planId) throw new Error("SERVICE_EMPLOYEE_PLAN_CREATE_FAILED");
        for(const component of normalized){
          await client.query(
            `INSERT INTO service_employee_compensation_component(
               tenant_id,plan_id,component_type,amount_minor,
               percent_bps,priority
             ) VALUES($1,$2,$3,$4,$5,$6)`,
            [
              context.tenantId,planId,component.componentType,
              component.amountMinor,component.percentBps,component.priority
            ]
          );
        }
        return {id:planId};
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(message.includes("SERVICE_EMPLOYEE_PLAN_OVERLAP")){
          throw new ConflictException(
            "Для сотрудника уже есть пересекающееся правило с тем же приоритетом"
          );
        }
        throw error;
      }
    });
  }

  async payrollProfiles(context:TenantContext){
    const scope=await this.payrollReadScope(context);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.id,p.employee_resource_id,r.name AS employee_name,
           p.monthly_base_minor::text,p.daily_base_minor::text,
           p.minimum_guarantee_minor::text,p.currency,
           p.valid_from,p.valid_to,p.status,p.note,p.metadata
         FROM service_employee_payroll_profile p
         JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.employee_resource_id
         WHERE p.tenant_id=$1
           AND p.status='ACTIVE'
           AND ($2::uuid[] IS NULL OR r.membership_id=ANY($2::uuid[]))
         ORDER BY r.name,p.valid_from DESC`,
        [context.tenantId,scope]
      );
      return result.rows;
    });
  }

  async createPayrollProfile(
    context:TenantContext,
    input:{
      employeeResourceId:string;
      monthlyBaseMinor?:string|number;
      dailyBaseMinor?:string|number;
      minimumGuaranteeMinor?:string|number;
      currency?:string;
      validFrom?:string;
      validTo?:string;
      note?:string;
    }
  ){
    await this.requireAll(context,"service.write");
    await this.requireFinance(context,"finance.write");
    const monthly=String(input.monthlyBaseMinor??"0");
    const daily=String(input.dailyBaseMinor??"0");
    const guarantee=String(input.minimumGuaranteeMinor??"0");
    if(![monthly,daily,guarantee].every(value=>/^\d+$/.test(value))){
      throw new BadRequestException("Некорректные параметры оклада");
    }
    if(BigInt(monthly)===0n&&BigInt(daily)===0n&&BigInt(guarantee)===0n){
      throw new BadRequestException("Укажите оклад, дневную ставку или гарантию");
    }
    const currency=input.currency?.trim().toUpperCase()||"RUB";
    return this.database.withTenantTransaction(context,async client=>{
      try{
        const result=await client.query<{id:string}>(
          `INSERT INTO service_employee_payroll_profile(
             tenant_id,employee_resource_id,monthly_base_minor,daily_base_minor,
             minimum_guarantee_minor,currency,valid_from,valid_to,note
           ) VALUES(
             $1,$2,$3,$4,$5,$6,coalesce($7::date,current_date),$8::date,$9
           )
           RETURNING id`,
          [
            context.tenantId,input.employeeResourceId,monthly,daily,guarantee,
            currency,input.validFrom??null,input.validTo??null,
            input.note?.trim()||null
          ]
        );
        return result.rows[0]!;
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(message.includes("SERVICE_EMPLOYEE_PROFILE_OVERLAP")){
          throw new ConflictException(
            "У сотрудника уже есть профиль зарплаты на пересекающийся период"
          );
        }
        throw error;
      }
    });
  }

  async calculateBookingTx(
    client:PoolClient,
    context:TenantContext,
    bookingId:string
  ):Promise<Record<string,unknown>>{
    const existing=await client.query(
      `SELECT * FROM service_booking_profitability
       WHERE tenant_id=$1 AND booking_id=$2`,
      [context.tenantId,bookingId]
    );
    if(existing.rows[0]) return existing.rows[0];

    const bookingResult=await client.query<{
      id:string;
      service_id:string;
      branch_id:string|null;
      delivery_format_snapshot:string;
      starts_at:Date;
      ends_at:Date;
      price_minor_snapshot:string;
      currency:string;
      status:string;
    }>(
      `SELECT
         id,service_id,branch_id,delivery_format_snapshot,starts_at,ends_at,
         price_minor_snapshot::text,currency,status
       FROM service_booking
       WHERE tenant_id=$1 AND id=$2
       FOR UPDATE`,
      [context.tenantId,bookingId]
    );
    const booking=bookingResult.rows[0];
    if(!booking) throw new NotFoundException("Запись не найдена");
    if(booking.status!=="COMPLETED"){
      throw new ConflictException("Экономика рассчитывается только после завершения визита");
    }

    const employeeResult=await client.query<{
      id:string;
      cost_per_hour_minor:string;
      timezone:string;
    }>(
      `SELECT r.id,r.cost_per_hour_minor::text,r.timezone
       FROM service_booking_resource br
       JOIN service_resource r
         ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
       WHERE br.tenant_id=$1 AND br.booking_id=$2 AND r.type='EMPLOYEE'
       ORDER BY r.id
       LIMIT 1`,
      [context.tenantId,bookingId]
    );
    const employee=employeeResult.rows[0]??null;

    const materialResult=await client.query<{cost_minor:string}>(
      `SELECT coalesce(sum(
         consumed_quantity_milli*unit_cost_minor_snapshot/1000
       ),0)::text AS cost_minor
       FROM service_booking_material
       WHERE tenant_id=$1 AND booking_id=$2`,
      [context.tenantId,bookingId]
    );
    const materialCost=BigInt(materialResult.rows[0]?.cost_minor??"0");

    const resourceResult=await client.query<{cost_minor:string}>(
      `SELECT coalesce(sum(
         (
           extract(epoch FROM (b.ends_at-b.starts_at))::bigint*
           br.cost_per_hour_minor_snapshot::bigint*
           greatest(br.capacity_units,1)::bigint
         )/(3600*greatest(r.capacity,1)::bigint)
       ),0)::text AS cost_minor
       FROM service_booking b
       JOIN service_booking_resource br
         ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
       JOIN service_resource r
         ON r.tenant_id=br.tenant_id AND r.id=br.resource_id
       WHERE b.tenant_id=$1 AND b.id=$2 AND r.type<>'EMPLOYEE'`,
      [context.tenantId,bookingId]
    );
    const resourceCost=BigInt(resourceResult.rows[0]?.cost_minor??"0");

    const packageRevenue=await client.query<{revenue_minor:string}>(
      `SELECT
         CASE
           WHEN pe.management_visit_value_minor_snapshot>0
             THEN pe.management_visit_value_minor_snapshot
           WHEN plan.management_visit_value_minor>0
             THEN plan.management_visit_value_minor
           WHEN sp.visit_limit_snapshot IS NOT NULL
             AND sp.visit_limit_snapshot>0
             THEN sp.price_minor_snapshot/sp.visit_limit_snapshot
           ELSE 0
         END::text AS revenue_minor
       FROM service_package_redemption red
       JOIN service_package sp
         ON sp.tenant_id=red.tenant_id AND sp.id=red.package_id
       JOIN service_package_plan plan
         ON plan.tenant_id=sp.tenant_id AND plan.id=sp.plan_id
       LEFT JOIN service_package_entitlement pe
         ON pe.tenant_id=red.tenant_id
        AND pe.id=red.package_entitlement_id
       WHERE red.tenant_id=$1
         AND red.booking_id=$2
         AND red.state IN ('RESERVED','CONSUMED')
       LIMIT 1`,
      [context.tenantId,bookingId]
    );
    const revenue=packageRevenue.rows[0]
      ?BigInt(packageRevenue.rows[0].revenue_minor)
      :BigInt(booking.price_minor_snapshot);
    const revenueSource=packageRevenue.rows[0]?"PACKAGE":"DIRECT";
    const marginBeforeEmployee=
      revenue>materialCost+resourceCost
        ?revenue-materialCost-resourceCost
        :0n;

    let employeeCost=0n;
    let planId:string|null=null;
    let componentSnapshot:Array<Record<string,unknown>>=[];
    if(employee){
      const plan=await client.query<{
        id:string;
      }>(
        `SELECT p.id
         FROM service_employee_compensation_plan p
         WHERE p.tenant_id=$1
           AND p.employee_resource_id=$2
           AND p.status='ACTIVE'
           AND (p.service_id IS NULL OR p.service_id=$3)
           AND (p.delivery_format IS NULL OR p.delivery_format=$4)
           AND (p.branch_id IS NULL OR p.branch_id=$5::uuid)
           AND p.valid_from<=($6::timestamptz AT TIME ZONE $7)::date
           AND (
             p.valid_to IS NULL OR
             p.valid_to>=($6::timestamptz AT TIME ZONE $7)::date
           )
         ORDER BY
           (
             CASE WHEN p.service_id IS NULL THEN 0 ELSE 4 END+
             CASE WHEN p.delivery_format IS NULL THEN 0 ELSE 2 END+
             CASE WHEN p.branch_id IS NULL THEN 0 ELSE 1 END
           ) DESC,
           p.priority,p.valid_from DESC,p.id
         LIMIT 1`,
        [
          context.tenantId,employee.id,booking.service_id,
          booking.delivery_format_snapshot,booking.branch_id,booking.starts_at,
          employee.timezone
        ]
      );
      planId=plan.rows[0]?.id??null;
      if(planId){
        const components=await client.query<{
          component_type:ComponentType;
          amount_minor:string;
          percent_bps:number;
          priority:number;
        }>(
          `SELECT
             component_type,amount_minor::text,percent_bps,priority
           FROM service_employee_compensation_component
           WHERE tenant_id=$1 AND plan_id=$2
           ORDER BY priority,id`,
          [context.tenantId,planId]
        );
        const seconds=Math.max(
          0,
          Math.floor(
            (new Date(booking.ends_at).getTime()-
             new Date(booking.starts_at).getTime())/1000
          )
        );
        for(const component of components.rows){
          let amount=0n;
          if(component.component_type==="FIXED_VISIT"){
            amount=BigInt(component.amount_minor);
          }else if(component.component_type==="HOURLY"){
            amount=BigInt(component.amount_minor)*BigInt(seconds)/3600n;
          }else if(component.component_type==="PERCENT_REVENUE"){
            amount=revenue*BigInt(component.percent_bps)/10000n;
          }else if(component.component_type==="PERCENT_MARGIN"){
            amount=marginBeforeEmployee*BigInt(component.percent_bps)/10000n;
          }
          employeeCost+=amount;
          componentSnapshot.push({
            type:component.component_type,
            amountMinor:amount.toString(),
            rateMinor:component.amount_minor,
            percentBps:component.percent_bps
          });
        }
      }
    }

    const totalCosts=materialCost+resourceCost+employeeCost;
    const contribution=revenue-totalCosts;

    const snapshot=await client.query(
      `INSERT INTO service_booking_profitability(
         tenant_id,booking_id,employee_resource_id,revenue_minor,
         material_cost_minor,employee_cost_minor,resource_cost_minor,
         other_cost_minor,contribution_margin_minor,currency,
         calculation_snapshot
       ) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10)
       RETURNING *`,
      [
        context.tenantId,bookingId,employee?.id??null,revenue.toString(),
        materialCost.toString(),employeeCost.toString(),resourceCost.toString(),
        contribution.toString(),booking.currency,
        JSON.stringify({
          serviceId:booking.service_id,
          deliveryFormat:booking.delivery_format_snapshot,
          revenueSource,
          employeePlanId:planId,
          components:componentSnapshot
        })
      ]
    );

    if(employee&&planId){
      await client.query(
        `INSERT INTO service_employee_booking_accrual(
           tenant_id,booking_id,employee_resource_id,plan_id,amount_minor,
           currency,rule_snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(tenant_id,booking_id,employee_resource_id) DO NOTHING`,
        [
          context.tenantId,bookingId,employee.id,planId,
          employeeCost.toString(),booking.currency,
          JSON.stringify({components:componentSnapshot})
        ]
      );
    }
    return snapshot.rows[0]!;
  }

  async dashboard(
    context:TenantContext,
    fromInput?:string,
    toInput?:string
  ){
    await this.requireFinance(context,"finance.read");
    const scope=await this.scope(context,"service.read");
    const to=toInput?new Date(toInput):new Date();
    const from=fromInput
      ?new Date(fromInput)
      :new Date(Date.UTC(to.getUTCFullYear(),to.getUTCMonth(),1));
    if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<=from){
      throw new BadRequestException("Некорректный период");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const totals=await client.query(
        `SELECT
           count(p.id)::integer AS completed,
           coalesce(sum(p.revenue_minor),0)::text AS revenue_minor,
           coalesce(sum(p.material_cost_minor),0)::text AS material_cost_minor,
           coalesce(sum(p.employee_cost_minor),0)::text AS employee_cost_minor,
           coalesce(sum(p.resource_cost_minor),0)::text AS resource_cost_minor,
           coalesce(sum(p.contribution_margin_minor),0)::text AS margin_minor
         FROM service_booking_profitability p
         LEFT JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.employee_resource_id
         WHERE p.tenant_id=$1
           AND p.calculated_at>=$2 AND p.calculated_at<$3
           AND ($4::uuid[] IS NULL OR r.membership_id=ANY($4::uuid[]))`,
        [context.tenantId,from,to,scope]
      );
      const employees=await client.query(
        `SELECT
           r.id,r.name,count(p.id)::integer AS completed,
           coalesce(sum(p.revenue_minor),0)::text AS revenue_minor,
           coalesce(sum(p.material_cost_minor),0)::text AS material_cost_minor,
           coalesce(sum(p.employee_cost_minor),0)::text AS employee_cost_minor,
           coalesce(sum(p.contribution_margin_minor),0)::text AS margin_minor
         FROM service_booking_profitability p
         JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.employee_resource_id
         WHERE p.tenant_id=$1
           AND p.calculated_at>=$2 AND p.calculated_at<$3
           AND ($4::uuid[] IS NULL OR r.membership_id=ANY($4::uuid[]))
         GROUP BY r.id,r.name
         ORDER BY sum(p.contribution_margin_minor) DESC,r.name`,
        [context.tenantId,from,to,scope]
      );
      const services=await client.query(
        `SELECT
           s.id,s.name,count(p.id)::integer AS completed,
           coalesce(sum(p.revenue_minor),0)::text AS revenue_minor,
           coalesce(sum(p.material_cost_minor),0)::text AS material_cost_minor,
           coalesce(sum(p.employee_cost_minor),0)::text AS employee_cost_minor,
           coalesce(sum(p.contribution_margin_minor),0)::text AS margin_minor
         FROM service_booking_profitability p
         JOIN service_booking b
           ON b.tenant_id=p.tenant_id AND b.id=p.booking_id
         JOIN service_catalog_item s
           ON s.tenant_id=b.tenant_id AND s.id=b.service_id
         LEFT JOIN service_resource r
           ON r.tenant_id=p.tenant_id AND r.id=p.employee_resource_id
         WHERE p.tenant_id=$1
           AND p.calculated_at>=$2 AND p.calculated_at<$3
           AND ($4::uuid[] IS NULL OR r.membership_id=ANY($4::uuid[]))
         GROUP BY s.id,s.name
         ORDER BY sum(p.contribution_margin_minor) DESC,s.name`,
        [context.tenantId,from,to,scope]
      );
      const retention=await client.query(
        `WITH last_service AS (
           SELECT DISTINCT ON (b.party_id,b.service_id)
             b.party_id,b.service_id,b.completed_at,b.starts_at
           FROM service_booking b
           JOIN service_catalog_item s
             ON s.tenant_id=b.tenant_id AND s.id=b.service_id
           LEFT JOIN service_booking_resource br
             ON br.tenant_id=b.tenant_id AND br.booking_id=b.id
           LEFT JOIN service_resource r
             ON r.tenant_id=br.tenant_id
            AND r.id=br.resource_id
            AND r.type='EMPLOYEE'
           WHERE b.tenant_id=$1
             AND b.party_id IS NOT NULL
             AND b.status='COMPLETED'
             AND s.rebook_after_days IS NOT NULL
             AND (
               $2::uuid[] IS NULL
               OR r.membership_id=ANY($2::uuid[])
               OR r.id IS NULL
             )
           ORDER BY b.party_id,b.service_id,b.completed_at DESC,b.id DESC
         )
         SELECT
           ls.party_id,p.display_name AS party_name,
           ls.service_id,s.name AS service_name,
           ls.completed_at AS last_completed_at,
           s.rebook_after_days,s.rebook_grace_days,
           (
             ls.completed_at+
             make_interval(days=>s.rebook_after_days)
           ) AS target_at,
           greatest(
             0,
             floor(
               extract(epoch FROM (
                 now()-(
                   ls.completed_at+
                   make_interval(
                     days=>s.rebook_after_days+s.rebook_grace_days
                   )
                 )
               ))/86400
             )
           )::integer AS overdue_days
         FROM last_service ls
         JOIN party p
           ON p.tenant_id=$1 AND p.id=ls.party_id
         JOIN service_catalog_item s
           ON s.tenant_id=$1 AND s.id=ls.service_id
         WHERE now()>=(
             ls.completed_at+
             make_interval(
               days=>s.rebook_after_days+s.rebook_grace_days
             )
           )
           AND NOT EXISTS(
             SELECT 1
             FROM service_booking future
             WHERE future.tenant_id=$1
               AND future.party_id=ls.party_id
               AND future.service_id=ls.service_id
               AND future.status IN ('DRAFT','CONFIRMED','ARRIVED')
               AND future.starts_at>now()
           )
         ORDER BY overdue_days DESC,p.display_name
         LIMIT 100`,
        [context.tenantId,scope]
      );

      return {
        totals:totals.rows[0]??{},
        employees:employees.rows,
        services:services.rows,
        retentionAlerts:retention.rows
      };
    });
  }

  async draftPayrollBatches(
    context:TenantContext,
    month?:string
  ){
    await this.requireAll(context,"service.read");
    await this.requireFinance(context,"finance.read");
    const period=this.monthBounds(month);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           b.id,b.legal_entity_id,e.name AS legal_entity_name,
           b.period_from,b.period_to,b.status,b.currency
         FROM payroll_accrual_batch b
         JOIN legal_entity e
           ON e.tenant_id=b.tenant_id AND e.id=b.legal_entity_id
         WHERE b.tenant_id=$1
           AND b.status='DRAFT'
           AND b.period_from=$2::date
           AND b.period_to=$3::date
         ORDER BY e.name,b.created_at`,
        [context.tenantId,period.from,period.to]
      );
      return result.rows;
    });
  }

  async payrollStatements(context:TenantContext,month?:string){
    const scope=await this.payrollReadScope(context);
    const period=this.monthBounds(month);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           s.*,r.name AS employee_name,r.membership_id,
           pr.id AS review_id,
           coalesce(pr.review_status,'PENDING') AS review_status,
           pr.employee_comment,pr.manager_comment,
           pr.acknowledged_at,pr.disputed_at,pr.resolved_at
         FROM service_employee_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.employee_resource_id
         LEFT JOIN payroll_statement_review pr
           ON pr.tenant_id=s.tenant_id
          AND pr.statement_kind='SERVICE_EMPLOYEE'
          AND pr.statement_id=s.id
         WHERE s.tenant_id=$1
           AND s.period_from=$2 AND s.period_to=$3
           AND ($4::uuid[] IS NULL OR r.membership_id=ANY($4::uuid[]))
         ORDER BY r.name`,
        [context.tenantId,period.from,period.to,scope]
      );
      return result.rows;
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
    const scope=await this.scope(context,"service.read");
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
        employee_resource_id:string;
        total_minor:string;
        currency:string;
        status:string;
        membership_id:string|null;
      }>(
        `SELECT
           s.id,s.employee_resource_id,s.total_minor::text,s.currency,
           s.status,r.membership_id
         FROM service_employee_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.employee_resource_id
         WHERE s.tenant_id=$1 AND s.id=$2
           AND (
             $3::uuid[] IS NULL OR
             r.membership_id=ANY($3::uuid[])
           )
         FOR UPDATE OF s`,
        [context.tenantId,statementId,scope]
      );
      const row=statement.rows[0];
      if(!row) throw new NotFoundException("Ведомость не найдена");
      if(!["FINALIZED","EXPORTED","PAID"].includes(row.status)){
        throw new ConflictException(
          "Согласовать можно только закрытую ведомость"
        );
      }
      if(scope!==null&&row.membership_id!==context.membershipId){
        throw new ForbiddenException(
          "Сотрудник может согласовать только собственную ведомость"
        );
      }

      const current=await client.query<{
        id:string;
        review_status:string;
      }>(
        `SELECT id,review_status
         FROM payroll_statement_review
         WHERE tenant_id=$1
           AND statement_kind='SERVICE_EMPLOYEE'
           AND statement_id=$2
         FOR UPDATE`,
        [context.tenantId,statementId]
      );
      const previous=current.rows[0]?.review_status??"PENDING";

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
           $1,'SERVICE_EMPLOYEE',$2,$3,$4,$5,$6,$7,$8,
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
          context.tenantId,statementId,row.employee_resource_id,
          context.membershipId,input.status,row.total_minor,row.currency,comment
        ]
      );
      const saved=review.rows[0];
      if(!saved) throw new Error("PAYROLL_REVIEW_SAVE_FAILED");

      await client.query(
        `INSERT INTO payroll_statement_review_event(
           tenant_id,review_id,event_type,actor_membership_id,
           previous_status,new_status,comment,
           statement_total_minor_snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          context.tenantId,saved.id,input.status,context.membershipId,
          previous,input.status,comment,row.total_minor
        ]
      );
      return {id:saved.id,status:saved.review_status};
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
    await this.requireAll(context,"service.write");
    await this.requireFinance(context,"finance.write");
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
           AND statement_kind='SERVICE_EMPLOYEE'
         FOR UPDATE`,
        [context.tenantId,reviewId]
      );
      const row=review.rows[0];
      if(!row) throw new NotFoundException("Согласование не найдено");
      if(["RESOLVED","WAIVED"].includes(row.review_status)){
        return {id:row.id,status:row.review_status,changed:false};
      }
      if(input.status==="RESOLVED"&&row.review_status!=="DISPUTED"){
        throw new ConflictException(
          "Разрешить можно только спорную ведомость"
        );
      }

      const result=await client.query(
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
      return {...result.rows[0],changed:true};
    });
  }

  async finalizePayroll(context:TenantContext,month?:string){
    await this.requireAll(context,"service.write");
    await this.requireFinance(context,"finance.write");
    const period=this.monthBounds(month);
    return this.database.withTenantTransaction(context,async client=>{
      const employees=await client.query<{id:string}>(
        `SELECT DISTINCT r.id
         FROM service_resource r
         WHERE r.tenant_id=$1
           AND r.type='EMPLOYEE'
           AND r.status='ACTIVE'
           AND (
             EXISTS(
               SELECT 1 FROM service_employee_booking_accrual a
               WHERE a.tenant_id=r.tenant_id
                 AND a.employee_resource_id=r.id
                 AND a.created_at::date BETWEEN $2 AND $3
             )
             OR EXISTS(
               SELECT 1 FROM service_employee_payroll_profile p
               WHERE p.tenant_id=r.tenant_id
                 AND p.employee_resource_id=r.id
                 AND p.status='ACTIVE'
                 AND p.valid_from<=$3
                 AND (p.valid_to IS NULL OR p.valid_to>=$2)
             )
           )
         ORDER BY r.id`,
        [context.tenantId,period.from,period.to]
      );

      let finalized=0;
      for(const employee of employees.rows){
        const existing=await client.query<{status:string}>(
          `SELECT status
           FROM service_employee_payroll_statement
           WHERE tenant_id=$1 AND employee_resource_id=$2
             AND period_from=$3 AND period_to=$4
           FOR UPDATE`,
          [context.tenantId,employee.id,period.from,period.to]
        );
        if(existing.rows[0]?.status&&existing.rows[0].status!=="DRAFT"){
          continue;
        }

        const variableResult=await client.query<{
          variable_minor:string;
          work_days:number;
        }>(
          `SELECT
             coalesce(sum(a.amount_minor),0)::text AS variable_minor,
             count(DISTINCT (
               b.starts_at AT TIME ZONE r.timezone
             )::date)::integer AS work_days
           FROM service_employee_booking_accrual a
           JOIN service_booking b
             ON b.tenant_id=a.tenant_id AND b.id=a.booking_id
           JOIN service_resource r
             ON r.tenant_id=a.tenant_id AND r.id=a.employee_resource_id
           WHERE a.tenant_id=$1
             AND a.employee_resource_id=$2
             AND (
               b.starts_at AT TIME ZONE r.timezone
             )::date BETWEEN $3 AND $4
             AND a.status<>'REVERSED'`,
          [context.tenantId,employee.id,period.from,period.to]
        );
        const variable=BigInt(variableResult.rows[0]?.variable_minor??"0");
        const workDays=variableResult.rows[0]?.work_days??0;

        const profile=await client.query<{
          monthly_base_minor:string;
          daily_base_minor:string;
          minimum_guarantee_minor:string;
          currency:string;
          valid_from:string;
          valid_to:string|null;
        }>(
          `SELECT
             monthly_base_minor::text,daily_base_minor::text,
             minimum_guarantee_minor::text,currency,
             valid_from::text,valid_to::text
           FROM service_employee_payroll_profile
           WHERE tenant_id=$1
             AND employee_resource_id=$2
             AND status='ACTIVE'
             AND valid_from<=$4
             AND (valid_to IS NULL OR valid_to>=$3)
           ORDER BY valid_from DESC,id DESC
           LIMIT 1`,
          [context.tenantId,employee.id,period.from,period.to]
        );
        const profileRow=profile.rows[0];
        const monthly=BigInt(profileRow?.monthly_base_minor??"0");
        const daily=BigInt(profileRow?.daily_base_minor??"0");
        const guarantee=BigInt(profileRow?.minimum_guarantee_minor??"0");

        const activeFrom=profileRow
          ?new Date(Math.max(
             new Date(period.from+"T00:00:00Z").getTime(),
             new Date(profileRow.valid_from+"T00:00:00Z").getTime()
           ))
          :null;
        const activeTo=profileRow
          ?new Date(Math.min(
             new Date(period.to+"T00:00:00Z").getTime(),
             new Date((profileRow.valid_to??period.to)+"T00:00:00Z").getTime()
           ))
          :null;
        const periodDays=
          Math.floor(
            (
              new Date(period.to+"T00:00:00Z").getTime()-
              new Date(period.from+"T00:00:00Z").getTime()
            )/86400000
          )+1;
        const activeDays=
          activeFrom&&activeTo
            ?Math.max(
              0,
              Math.floor((activeTo.getTime()-activeFrom.getTime())/86400000)+1
            )
            :0;
        const monthlyProrated=
          periodDays>0?monthly*BigInt(activeDays)/BigInt(periodDays):0n;
        const dailyTotal=daily*BigInt(workDays);
        const subtotal=variable+monthlyProrated+dailyTotal;
        const guaranteeAdjustment=
          guarantee>subtotal?guarantee-subtotal:0n;
        const total=subtotal+guaranteeAdjustment;

        const statement=await client.query<{id:string}>(
          `INSERT INTO service_employee_payroll_statement(
             tenant_id,employee_resource_id,period_from,period_to,
             variable_minor,monthly_base_minor,daily_base_minor,
             guarantee_adjustment_minor,total_minor,currency,status,
             calculation_snapshot,finalized_at,finalized_by_membership_id
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'FINALIZED',$11,now(),$12
           )
           ON CONFLICT(
             tenant_id,employee_resource_id,period_from,period_to
           )
           DO UPDATE SET
             variable_minor=EXCLUDED.variable_minor,
             monthly_base_minor=EXCLUDED.monthly_base_minor,
             daily_base_minor=EXCLUDED.daily_base_minor,
             guarantee_adjustment_minor=EXCLUDED.guarantee_adjustment_minor,
             total_minor=EXCLUDED.total_minor,
             currency=EXCLUDED.currency,
             status='FINALIZED',
             calculation_snapshot=EXCLUDED.calculation_snapshot,
             finalized_at=now(),
             finalized_by_membership_id=EXCLUDED.finalized_by_membership_id,
             updated_at=now()
           WHERE service_employee_payroll_statement.status='DRAFT'
           RETURNING id`,
          [
            context.tenantId,employee.id,period.from,period.to,
            variable.toString(),monthlyProrated.toString(),dailyTotal.toString(),
            guaranteeAdjustment.toString(),total.toString(),
            profileRow?.currency??"RUB",
            JSON.stringify({
              workDays,profileMonthlyMinor:monthly.toString(),
              activeDays,periodDays
            }),
            context.membershipId
          ]
        );
        if(statement.rowCount) finalized++;
      }
      return {finalized,periodFrom:period.from,periodTo:period.to};
    });
  }

  async exportPayrollToBatch(
    context:TenantContext,
    input:{batchId:string;month?:string}
  ){
    await this.requireAll(context,"service.write");
    await this.requireFinance(context,"finance.write");
    if(!input.batchId){
      throw new BadRequestException("Выберите payroll batch");
    }
    const period=this.monthBounds(input.month);
    return this.database.withTenantTransaction(context,async client=>{
      const batch=await client.query<{
        period_from:string;
        period_to:string;
      }>(
        `SELECT period_from::text,period_to::text
         FROM payroll_accrual_batch
         WHERE tenant_id=$1 AND id=$2 AND status='DRAFT'
         FOR UPDATE`,
        [context.tenantId,input.batchId]
      );
      const batchRow=batch.rows[0];
      if(!batchRow){
        throw new ConflictException(
          "Payroll batch не найден или уже утверждён"
        );
      }
      if(
        batchRow.period_from!==period.from||
        batchRow.period_to!==period.to
      ){
        throw new ConflictException(
          "Период payroll batch не совпадает с выбранным месяцем"
        );
      }

      const disputed=await client.query(
        `SELECT pr.id
         FROM payroll_statement_review pr
         JOIN service_employee_payroll_statement st
           ON st.tenant_id=pr.tenant_id AND st.id=pr.statement_id
         WHERE pr.tenant_id=$1
           AND pr.statement_kind='SERVICE_EMPLOYEE'
           AND pr.review_status='DISPUTED'
           AND st.period_from=$2::date
           AND st.period_to=$3::date
         LIMIT 1`,
        [context.tenantId,period.from,period.to]
      );
      if(disputed.rowCount){
        throw new ConflictException(
          "Есть спорная ведомость. Сначала разрешите спор или оформите управленческое исключение."
        );
      }

      const statements=await client.query<{
        id:string;
        employee_resource_id:string;
        membership_id:string|null;
        total_minor:string;
        currency:string;
      }>(
        `SELECT
           s.id,s.employee_resource_id,r.membership_id,
           s.total_minor::text,s.currency
         FROM service_employee_payroll_statement s
         JOIN service_resource r
           ON r.tenant_id=s.tenant_id AND r.id=s.employee_resource_id
         WHERE s.tenant_id=$1
           AND s.period_from=$2::date
           AND s.period_to=$3::date
           AND s.status='FINALIZED'
         ORDER BY s.id
         FOR UPDATE OF s`,
        [context.tenantId,period.from,period.to]
      );

      for(const statement of statements.rows){
        const employeeRef=
          statement.membership_id ??
          "service-resource:"+statement.employee_resource_id;
        await client.query(
          `INSERT INTO payroll_accrual_component(
             tenant_id,batch_id,employee_ref,source_type,source_key,
             gross_minor,deduction_minor,metadata
           ) VALUES(
             $1,$2,$3,'SERVICE_EMPLOYEE_STATEMENT',$4,$5,0,$6
           )
           ON CONFLICT(
             tenant_id,batch_id,employee_ref,source_type,source_key
           )
           DO UPDATE SET
             gross_minor=EXCLUDED.gross_minor,
             deduction_minor=0,
             metadata=EXCLUDED.metadata,
             updated_at=now()`,
          [
            context.tenantId,input.batchId,employeeRef,statement.id,
            statement.total_minor,
            JSON.stringify({
              statementId:statement.id,
              employeeResourceId:statement.employee_resource_id,
              periodFrom:period.from,
              periodTo:period.to,
              currency:statement.currency
            })
          ]
        );
      }

      const ids=statements.rows.map(row=>row.id);
      if(ids.length){
        await client.query(
          `UPDATE service_employee_payroll_statement
           SET status='EXPORTED',payroll_batch_id=$3,
               exported_at=now(),updated_at=now()
           WHERE tenant_id=$1
             AND id=ANY($2::uuid[])
             AND status='FINALIZED'`,
          [context.tenantId,ids,input.batchId]
        );
      }

      const accruals=await client.query(
        `UPDATE service_employee_booking_accrual a
         SET status='EXPORTED',payroll_batch_id=$4
         FROM service_booking b
         WHERE a.tenant_id=$1
           AND b.tenant_id=a.tenant_id AND b.id=a.booking_id
           AND b.starts_at::date BETWEEN $2::date AND $3::date
           AND a.status IN ('CALCULATED','APPROVED')
         RETURNING a.id`,
        [context.tenantId,period.from,period.to,input.batchId]
      );

      return {
        statements:ids.length,
        accruals:accruals.rowCount??0,
        batchId:input.batchId
      };
    });
  }

  private monthBounds(month?:string){
    const value=month?.trim()||new Date().toISOString().slice(0,7);
    if(!/^\d{4}-\d{2}$/.test(value)){
      throw new BadRequestException("Месяц должен быть в формате YYYY-MM");
    }
    const start=new Date(value+"-01T00:00:00Z");
    if(Number.isNaN(start.getTime())){
      throw new BadRequestException("Некорректный месяц");
    }
    const next=new Date(Date.UTC(
      start.getUTCFullYear(),start.getUTCMonth()+1,1
    ));
    const end=new Date(next.getTime()-86400000);
    return {
      from:start.toISOString().slice(0,10),
      to:end.toISOString().slice(0,10)
    };
  }

  private async requireFinance(
    context:TenantContext, permission:"finance.read"|"finance.write"
  ):Promise<void>{
    if(!await this.authorization.resolveScope(context,permission))
      throw new ForbiddenException("Необходим доступ к финансовым данным");
  }

  private async payrollReadScope(context:TenantContext):Promise<string[]|null>{
    const scope=await this.scope(context,"service.read");
    if(await this.authorization.resolveScope(context,"finance.read"))return scope;
    return scope===null||scope.includes(context.membershipId)
      ?[context.membershipId]:[];
  }

  private async scope(
    context:TenantContext,
    permission:"service.read"|"service.write"
  ){
    const scope=await this.authorization.resolveScope(context,permission);
    if(!scope) throw new ForbiddenException("Недостаточно прав");
    return this.authorization.membershipIdsForScope(context,scope);
  }

  private async requireAll(
    context:TenantContext,
    permission:"service.read"|"service.write"
  ){
    const scope=await this.authorization.resolveScope(context,permission);
    if(scope!=="all"){
      throw new ForbiddenException(
        "Настройка зарплаты доступна администратору сервисного бизнеса"
      );
    }
  }
}
