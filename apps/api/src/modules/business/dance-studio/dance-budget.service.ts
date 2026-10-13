import {
  BadRequestException,ConflictException,ForbiddenException,Injectable
} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {AuthorizationService} from "../../platform/authorization/authorization.service";

export const danceBudgetFields=[
  "revenueMinor","rentBranchAMinor","rentBranchBMinor",
  "managersMinor","trainersMinor","taxesMinor","otherMinor","subleaseMinor"
] as const;
type BudgetField=typeof danceBudgetFields[number];
type BudgetValues=Record<BudgetField,string|null>;
type BudgetInput={month:string;expectedVersion:number;values:BudgetValues};
const moneyLimit=999999999999999n;

@Injectable()
export class DanceBudgetService{
  constructor(
    private readonly database:DatabaseService,
    private readonly authorization:AuthorizationService
  ) {}

  private month(raw:string):string{
    if(typeof raw!=="string"||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(raw))
      throw new BadRequestException("Укажите месяц в формате YYYY-MM");
    return raw+"-01";
  }

  private async requireScope(context:TenantContext,permission:
      "finance.read"|"finance.write"){
    const [finance,dance]=await Promise.all([
      this.authorization.resolveScope(context,permission),
      this.authorization.resolveScope(context,
        permission==="finance.read"?"dance.read":"dance.write")
    ]);
    if(finance!=="all"||dance!=="all")
      throw new ForbiddenException("Бюджет компании доступен только с полным финансовым доступом");
  }

  async read(context:TenantContext,month:string){
    await this.requireScope(context,"finance.read");
    const date=this.month(month);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{
        version:number;
        revenue_minor:string|null;
        rent_branch_a_minor:string|null;
        rent_branch_b_minor:string|null;
        managers_minor:string|null;
        trainers_minor:string|null;
        taxes_minor:string|null;
        other_minor:string|null;
        sublease_minor:string|null;
        updated_at:Date;
      }>(
        `SELECT version,revenue_minor::text,rent_branch_a_minor::text,
         rent_branch_b_minor::text,managers_minor::text,trainers_minor::text,
         taxes_minor::text,other_minor::text,sublease_minor::text,updated_at
         FROM dance_budget_plan WHERE tenant_id=$1 AND month_start=$2::date`,
        [context.tenantId,date]
      );
      const r=result.rows[0];
      if(!r)return {month,version:0,values:Object.fromEntries(
        danceBudgetFields.map(field=>[field,null])) as BudgetValues,
        updatedAt:null};
      return {month,version:r.version,values:{
        revenueMinor:r.revenue_minor,rentBranchAMinor:r.rent_branch_a_minor,
        rentBranchBMinor:r.rent_branch_b_minor,managersMinor:r.managers_minor,
        trainersMinor:r.trainers_minor,taxesMinor:r.taxes_minor,
        otherMinor:r.other_minor,subleaseMinor:r.sublease_minor
      },updatedAt:r.updated_at};
    });
  }

  /**
   * Sales of subleased rooms are NOT the studio's own lease expenses.
   * Count each booking exactly once even when it reserves multiple resources.
   * A confirmed booking creates a receivable, never a verified payment.
   */
  async rentalIncome(context:TenantContext,month:string){
    await this.requireScope(context,"finance.read");
    const date=this.month(month);
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{
        branch_id:string|null;branch_name:string|null;
        bookings:number;booked_minor:string;receivable_minor:string;
        settled_minor:string;unverified:number
      }>(
        `WITH rentals AS (
           SELECT b.id,b.branch_id,b.price_minor_snapshot,
                  coalesce(ch.amount_minor,0) AS receivable_minor,
                  coalesce(ch.settled_minor,0) AS settled_minor,
                  coalesce(ch.unverified,0) AS unverified
           FROM service_booking b
           LEFT JOIN LATERAL (
             SELECT
               coalesce(sum(c.amount_minor),0) AS amount_minor,
               coalesce(sum(coalesce(o.settled_minor,0)),0) AS settled_minor,
               (CASE WHEN count(c.id)=0 AND b.price_minor_snapshot>0
                 THEN 1
                 ELSE count(*) FILTER (WHERE o.id IS NULL)
               END)::int AS unverified
             FROM service_booking_charge c
             LEFT JOIN financial_obligation o ON
               o.tenant_id=c.tenant_id AND o.id=c.obligation_id
             WHERE c.tenant_id=b.tenant_id AND c.booking_id=b.id
           ) ch ON true
           WHERE b.tenant_id=$1
             AND b.delivery_format_snapshot='RENTAL'
             AND b.status<>'CANCELLED'
             AND b.starts_at>=($2::date AT TIME ZONE 'Europe/Moscow')
             AND b.starts_at<(($2::date + interval '1 month')
                                AT TIME ZONE 'Europe/Moscow')
         )
         SELECT r.branch_id,br.name AS branch_name,
                count(*)::int AS bookings,
                coalesce(sum(r.price_minor_snapshot),0)::text AS booked_minor,
                coalesce(sum(r.receivable_minor),0)::text AS receivable_minor,
                coalesce(sum(r.settled_minor),0)::text AS settled_minor,
                coalesce(sum(r.unverified),0)::int AS unverified
         FROM rentals r
         LEFT JOIN branch br ON br.tenant_id=$1 AND br.id=r.branch_id
         GROUP BY r.branch_id,br.name ORDER BY br.name NULLS LAST`,
        [context.tenantId,date]
      );
      const branches=result.rows;
      const sum=(key:"booked_minor"|"receivable_minor"|"settled_minor")=>
        branches.reduce((total,row)=>total+BigInt(row[key]),0n).toString();
      return {
        month,
        branches,
        totals:{
          bookings:branches.reduce((n,row)=>n+row.bookings,0),
          bookedMinor:sum("booked_minor"),
          receivableMinor:sum("receivable_minor"),
          settledMinor:sum("settled_minor"),
          unverified:branches.reduce((n,row)=>n+row.unverified,0)
        },
        notes:[
          "Booked rent is not cash collected",
          "Settlements exclude unverified obligations",
          "Room lease costs are separately recorded expenses"
        ]
      };
    });
  }

  async save(context:TenantContext,input:BudgetInput){
    await this.requireScope(context,"finance.write");
    const month=this.month(input?.month);
    if(!Number.isSafeInteger(input.expectedVersion)||
       input.expectedVersion<0||input.expectedVersion>2147483646)
      throw new BadRequestException("Некорректная версия бюджета");
    if(!input.values||typeof input.values!=="object"||
       Array.isArray(input.values))
      throw new BadRequestException("Передайте все статьи бюджета");
    const entries=[] as Array<string|null>;
    for(const field of danceBudgetFields){
      if(!Object.prototype.hasOwnProperty.call(input.values,field))
        throw new BadRequestException("Не указана статья "+field);
      const value=input.values[field];
      if(value===null){entries.push(null);continue;}
      if(typeof value!=="string"||!/^(0|[1-9]\d{0,15})$/.test(value)||
          BigInt(value)>moneyLimit)
        throw new BadRequestException("Неверная сумма по статье "+field);
      entries.push(value);
    }

    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{version:number}>(
        `INSERT INTO dance_budget_plan(
          tenant_id,month_start,revenue_minor,rent_branch_a_minor,
          rent_branch_b_minor,managers_minor,trainers_minor,taxes_minor,
          other_minor,sublease_minor,modified_by_membership_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(tenant_id,month_start)
        DO UPDATE SET
          revenue_minor=EXCLUDED.revenue_minor,
          rent_branch_a_minor=EXCLUDED.rent_branch_a_minor,
          rent_branch_b_minor=EXCLUDED.rent_branch_b_minor,
          managers_minor=EXCLUDED.managers_minor,
          trainers_minor=EXCLUDED.trainers_minor,
          taxes_minor=EXCLUDED.taxes_minor,
          other_minor=EXCLUDED.other_minor,
          sublease_minor=EXCLUDED.sublease_minor,
          modified_by_membership_id=EXCLUDED.modified_by_membership_id,
          updated_at=now(),version=dance_budget_plan.version+1
        WHERE dance_budget_plan.version=$12
        RETURNING version`,
        [context.tenantId,month,...entries,context.membershipId,
          input.expectedVersion]
      );
      if(!result.rows[0])
        throw new ConflictException("Бюджет изменён другим сотрудником. Обновите страницу");
      await client.query(
        `INSERT INTO audit_event(tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data)
         VALUES($1,$2,$3,'dance.budget_plan_saved',
           'dance_budget_plan',$4,jsonb_build_object('version',$5::integer))`,
        [context.tenantId,context.userId,context.membershipId,
          month,result.rows[0].version]
      );
      return {saved:true,month:input.month,version:result.rows[0].version};
    });
  }
}
