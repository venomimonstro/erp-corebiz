import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";

const ZONE_TYPES = new Set([
  "RECEIVING","STORAGE","PICKING","PACKING","SHIPPING",
  "QUARANTINE","RETURNS","CROSS_DOCK"
]);

const LOCATION_TYPES = new Set([
  "DOCK","STAGING","AISLE","RACK","SHELF","BIN","FLOOR","BUFFER"
]);

@Injectable()
export class WmsService {
  constructor(private readonly database: DatabaseService) {}

  async warehouses(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           w.id,w.name,w.code,w.is_default,
           p.mode,p.status AS wms_status,p.stock_tracking_state,
           count(DISTINCT z.id) FILTER (WHERE z.status<>'ARCHIVED')::int AS zones,
           count(DISTINCT l.id) FILTER (WHERE l.status<>'ARCHIVED')::int AS locations
         FROM warehouse w
         LEFT JOIN warehouse_wms_profile p
           ON p.tenant_id=w.tenant_id AND p.warehouse_id=w.id
         LEFT JOIN warehouse_zone z
           ON z.tenant_id=w.tenant_id AND z.warehouse_id=w.id
         LEFT JOIN warehouse_location l
           ON l.tenant_id=w.tenant_id AND l.warehouse_id=w.id
         WHERE w.tenant_id=$1 AND w.status='ACTIVE'
         GROUP BY w.id,p.warehouse_id
         ORDER BY w.is_default DESC,w.name`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async configure(
    context: TenantContext,
    warehouseId: string,
    input: {
      mode?: "ADDRESS" | "ADVANCED";
      status?: "DRAFT" | "ACTIVE" | "DISABLED";
      coordinateUnit?: "GRID" | "CM";
    }
  ): Promise<void> {
    const mode=input.mode??"ADDRESS";
    const status=input.status??"DRAFT";
    const unit=input.coordinateUnit??"GRID";

    await this.database.withTenantTransaction(context, async (client) => {
      await this.assertWarehouse(client,context.tenantId,warehouseId);

      await client.query(
        `INSERT INTO warehouse_wms_profile(
           warehouse_id,tenant_id,mode,status,coordinate_unit,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (warehouse_id)
         DO UPDATE SET
           mode=EXCLUDED.mode,
           status=EXCLUDED.status,
           coordinate_unit=EXCLUDED.coordinate_unit,
           updated_at=now()`,
        [
          warehouseId,context.tenantId,mode,status,unit,
          context.membershipId
        ]
      );

      await this.audit(
        client,context,"wms.profile_configured","warehouse",warehouseId,
        {mode,status,stockTrackingState:"TOPOLOGY_ONLY"}
      );
    });
  }

  async topology(
    context: TenantContext,
    warehouseId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertWarehouse(client,context.tenantId,warehouseId);

      const profile=await client.query(
        `SELECT mode,status,stock_tracking_state,coordinate_unit
         FROM warehouse_wms_profile
         WHERE tenant_id=$1 AND warehouse_id=$2`,
        [context.tenantId,warehouseId]
      );

      const zones=await client.query(
        `SELECT
           id,code,name,zone_type,priority,status,
           x,y,width,height,created_at,updated_at
         FROM warehouse_zone
         WHERE tenant_id=$1 AND warehouse_id=$2 AND status<>'ARCHIVED'
         ORDER BY priority,code`,
        [context.tenantId,warehouseId]
      );

      const locations=await client.query(
        `SELECT
           l.id,l.zone_id,l.parent_location_id,l.code,l.full_code,l.name,
           l.location_type,l.status,l.pick_sequence,
           l.allow_mixed_sku,l.allow_mixed_lot,
           l.max_weight_grams::text,l.max_volume_cm3::text,
           l.x,l.y,l.width,l.height,l.level_no,l.metadata,
           z.code AS zone_code,z.name AS zone_name
         FROM warehouse_location l
         JOIN warehouse_zone z
           ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
         WHERE l.tenant_id=$1
           AND l.warehouse_id=$2
           AND l.status<>'ARCHIVED'
         ORDER BY z.priority,l.pick_sequence,l.full_code`,
        [context.tenantId,warehouseId]
      );

      return {
        profile:profile.rows[0]??null,
        zones:zones.rows,
        locations:locations.rows
      };
    });
  }

  async createZone(
    context: TenantContext,
    warehouseId: string,
    input: {
      code: string;
      name: string;
      zoneType: string;
      priority?: number;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }
  ): Promise<{id:string}> {
    const code=this.code(input.code,40);
    const name=this.text(input.name,2,160,"Название зоны");
    const zoneType=String(input.zoneType??"").toUpperCase();
    if(!ZONE_TYPES.has(zoneType)){
      throw new BadRequestException("Неизвестный тип зоны");
    }

    const priority=this.integer(input.priority??100,0,10000,"Приоритет");
    const x=this.integer(input.x??0,-100000,100000,"X");
    const y=this.integer(input.y??0,-100000,100000,"Y");
    const width=this.integer(input.width??1,1,100000,"Ширина");
    const height=this.integer(input.height??1,1,100000,"Высота");

    return this.database.withTenantTransaction(context,async client=>{
      await this.assertProfile(client,context.tenantId,warehouseId);

      try{
        const result=await client.query<{id:string}>(
          `INSERT INTO warehouse_zone(
             tenant_id,warehouse_id,code,name,zone_type,priority,
             x,y,width,height,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            context.tenantId,warehouseId,code,name,zoneType,priority,
            x,y,width,height,context.membershipId
          ]
        );
        return result.rows[0]!;
      }catch(error){
        if(this.unique(error)){
          throw new ConflictException("Зона с таким кодом уже существует");
        }
        throw error;
      }
    });
  }

  async createLocation(
    context: TenantContext,
    warehouseId: string,
    input: {
      zoneId: string;
      parentLocationId?: string;
      code: string;
      name?: string;
      locationType: string;
      pickSequence?: number;
      allowMixedSku?: boolean;
      allowMixedLot?: boolean;
      maxWeightGrams?: string;
      maxVolumeCm3?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      levelNo?: number;
    }
  ): Promise<{id:string;fullCode:string}> {
    const code=this.code(input.code,60);
    const type=String(input.locationType??"").toUpperCase();
    if(!LOCATION_TYPES.has(type)){
      throw new BadRequestException("Неизвестный тип адреса");
    }

    const pickSequence=this.integer(input.pickSequence??1000,0,100000000,"Pick sequence");
    const x=this.integer(input.x??0,-100000,100000,"X");
    const y=this.integer(input.y??0,-100000,100000,"Y");
    const width=this.integer(input.width??1,1,100000,"Ширина");
    const height=this.integer(input.height??1,1,100000,"Высота");
    const levelNo=this.integer(input.levelNo??0,0,1000,"Уровень");
    const maxWeight=this.optionalPositiveBigint(input.maxWeightGrams,"Максимальный вес");
    const maxVolume=this.optionalPositiveBigint(input.maxVolumeCm3,"Максимальный объём");

    return this.database.withTenantTransaction(context,async client=>{
      await this.assertProfile(client,context.tenantId,warehouseId);

      const zone=await client.query<{code:string}>(
        `SELECT code FROM warehouse_zone
         WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3 AND status='ACTIVE'`,
        [context.tenantId,warehouseId,input.zoneId]
      );
      if(!zone.rows[0]) throw new NotFoundException("Активная зона не найдена");

      let parentCode:string|null=null;
      if(input.parentLocationId){
        const parent=await client.query<{full_code:string}>(
          `SELECT full_code FROM warehouse_location
           WHERE tenant_id=$1
             AND warehouse_id=$2
             AND zone_id=$3
             AND id=$4
             AND status='ACTIVE'`,
          [
            context.tenantId,warehouseId,input.zoneId,input.parentLocationId
          ]
        );
        if(!parent.rows[0]){
          throw new NotFoundException("Родительский адрес недоступен");
        }
        parentCode=parent.rows[0].full_code;
      }

      const fullCode=
        (parentCode??zone.rows[0].code)+"-"+code;

      try{
        const result=await client.query<{id:string}>(
          `INSERT INTO warehouse_location(
             tenant_id,warehouse_id,zone_id,parent_location_id,
             code,full_code,name,location_type,pick_sequence,
             allow_mixed_sku,allow_mixed_lot,
             max_weight_grams,max_volume_cm3,
             x,y,width,height,level_no,created_by_membership_id
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
           )
           RETURNING id`,
          [
            context.tenantId,warehouseId,input.zoneId,input.parentLocationId??null,
            code,fullCode,input.name?.trim()||null,type,pickSequence,
            input.allowMixedSku??true,input.allowMixedLot??true,
            maxWeight,maxVolume,x,y,width,height,levelNo,context.membershipId
          ]
        );
        return {id:result.rows[0]!.id,fullCode};
      }catch(error){
        if(this.unique(error)){
          throw new ConflictException("Такой адрес уже существует");
        }
        throw error;
      }
    });
  }

  async updateLocationStatus(
    context: TenantContext,
    warehouseId: string,
    locationId: string,
    status: "ACTIVE" | "BLOCKED" | "MAINTENANCE"
  ): Promise<void> {
    if(!["ACTIVE","BLOCKED","MAINTENANCE"].includes(status)){
      throw new BadRequestException("Некорректный статус адреса");
    }

    await this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE warehouse_location
         SET status=$4,updated_at=now()
         WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3
           AND status<>'ARCHIVED'
         RETURNING id`,
        [context.tenantId,warehouseId,locationId,status]
      );
      if(!result.rowCount) throw new NotFoundException("Адрес не найден");
    });
  }

  async setSkuRule(
    context: TenantContext,
    warehouseId: string,
    input: {
      skuId: string;
      zoneId?: string;
      locationId?: string;
      ruleType: "ALLOW" | "PREFER" | "FORBID" | "FIXED_PICK";
      priority?: number;
      minQuantityMilli?: string;
      maxQuantityMilli?: string;
    }
  ): Promise<{id:string}> {
    if(!input.zoneId&&!input.locationId){
      throw new BadRequestException("Укажите зону или адрес");
    }

    return this.database.withTenantTransaction(context,async client=>{
      await this.assertProfile(client,context.tenantId,warehouseId);

      const sku=await client.query(
        `SELECT 1 FROM sku
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,input.skuId]
      );
      if(!sku.rowCount) throw new NotFoundException("SKU не найден");

      let zoneId=input.zoneId??null;

      if(input.locationId){
        const location=await client.query<{zone_id:string}>(
          `SELECT zone_id FROM warehouse_location
           WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3
             AND status='ACTIVE'`,
          [context.tenantId,warehouseId,input.locationId]
        );
        if(!location.rows[0]) throw new NotFoundException("Адрес не найден");

        if(zoneId&&zoneId!==location.rows[0].zone_id){
          throw new BadRequestException("Адрес относится к другой зоне");
        }
        zoneId=location.rows[0].zone_id;
      }else if(zoneId){
        const zone=await client.query(
          `SELECT 1 FROM warehouse_zone
           WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3
             AND status='ACTIVE'`,
          [context.tenantId,warehouseId,zoneId]
        );
        if(!zone.rowCount) throw new NotFoundException("Зона не найдена");
      }

      const min=this.optionalNonNegativeBigint(input.minQuantityMilli,"Минимум");
      const max=this.optionalPositiveBigint(input.maxQuantityMilli,"Максимум");
      if(min!==null&&max!==null&&BigInt(min)>BigInt(max)){
        throw new BadRequestException("Минимум больше максимума");
      }

      const result=await client.query<{id:string}>(
        `INSERT INTO warehouse_location_sku_rule(
           tenant_id,warehouse_id,sku_id,zone_id,location_id,
           rule_type,priority,min_quantity_milli,max_quantity_milli,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          context.tenantId,warehouseId,input.skuId,zoneId,input.locationId??null,
          input.ruleType,this.integer(input.priority??100,0,10000,"Приоритет"),
          min,max,context.membershipId
        ]
      );
      return result.rows[0]!;
    });
  }

  private async assertWarehouse(
    client:PoolClient,tenantId:string,warehouseId:string
  ):Promise<void>{
    const result=await client.query(
      `SELECT 1 FROM warehouse
       WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
      [tenantId,warehouseId]
    );
    if(!result.rowCount) throw new NotFoundException("Склад не найден");
  }

  private async assertProfile(
    client:PoolClient,tenantId:string,warehouseId:string
  ):Promise<void>{
    await this.assertWarehouse(client,tenantId,warehouseId);
    const result=await client.query(
      `SELECT 1 FROM warehouse_wms_profile
       WHERE tenant_id=$1 AND warehouse_id=$2 AND status<>'DISABLED'`,
      [tenantId,warehouseId]
    );
    if(!result.rowCount){
      throw new BadRequestException("Сначала включите адресный WMS для склада");
    }
  }

  private code(value:unknown,max:number):string{
    const code=String(value??"").trim().toUpperCase();
    if(!/^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9._-]{0,59}$/u.test(code)||code.length>max){
      throw new BadRequestException("Некорректный код");
    }
    return code;
  }

  private text(value:unknown,min:number,max:number,label:string):string{
    const text=String(value??"").trim();
    if(text.length<min||text.length>max){
      throw new BadRequestException(label+": некорректная длина");
    }
    return text;
  }

  private integer(value:unknown,min:number,max:number,label:string):number{
    const number=Number(value);
    if(!Number.isInteger(number)||number<min||number>max){
      throw new BadRequestException(label+": некорректное значение");
    }
    return number;
  }

  private optionalPositiveBigint(value:unknown,label:string):string|null{
    if(value===undefined||value===null||value==="") return null;
    const raw=String(value);
    if(!/^\d+$/.test(raw)||BigInt(raw)<=0n){
      throw new BadRequestException(label+": некорректное значение");
    }
    return raw;
  }

  private optionalNonNegativeBigint(value:unknown,label:string):string|null{
    if(value===undefined||value===null||value==="") return null;
    const raw=String(value);
    if(!/^\d+$/.test(raw)){
      throw new BadRequestException(label+": некорректное значение");
    }
    return raw;
  }

  private unique(error:unknown):boolean{
    return Boolean(
      error&&typeof error==="object"&&"code" in error&&error.code==="23505"
    );
  }

  private async audit(
    client:PoolClient,
    context:TenantContext,
    action:string,
    resourceType:string,
    resourceId:string,
    data?:Record<string,unknown>
  ):Promise<void>{
    await client.query(
      `INSERT INTO audit_event(
         tenant_id,actor_user_id,actor_membership_id,
         action,resource_type,resource_id,after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,context.userId,context.membershipId,
        action,resourceType,resourceId,data?JSON.stringify(data):null
      ]
    );
  }
}
