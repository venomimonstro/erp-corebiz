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
