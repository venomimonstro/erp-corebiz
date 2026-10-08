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

  async initializeLocationLedger(
    context: TenantContext,
    warehouseId: string
  ): Promise<{
    initialized: boolean;
    unassignedLocationId: string;
    skuCount: number;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertProfile(client,context.tenantId,warehouseId);

      const profile=await client.query<{stock_tracking_state:string}>(
        `SELECT stock_tracking_state
         FROM warehouse_wms_profile
         WHERE tenant_id=$1 AND warehouse_id=$2
         FOR UPDATE`,
        [context.tenantId,warehouseId]
      );

      if(profile.rows[0]?.stock_tracking_state==="LOCATION_LEDGER"){
        const systemLocation=await client.query<{id:string}>(
          `SELECT id FROM warehouse_location
           WHERE tenant_id=$1 AND warehouse_id=$2
             AND is_system=true AND code='UNASSIGNED'
           LIMIT 1`,
          [context.tenantId,warehouseId]
        );
        if(!systemLocation.rows[0]){
          throw new ConflictException("WMS инициализирован некорректно: UNASSIGNED отсутствует");
        }

        const count=await client.query<{count:string}>(
          `SELECT count(DISTINCT sku_id)::text AS count
           FROM warehouse_location_balance
           WHERE tenant_id=$1 AND warehouse_id=$2 AND physical_milli>0`,
          [context.tenantId,warehouseId]
        );

        return {
          initialized:false,
          unassignedLocationId:systemLocation.rows[0].id,
          skuCount:Number(count.rows[0]?.count??"0")
        };
      }

      const existing=await client.query<{count:string}>(
        `SELECT count(*)::text AS count
         FROM warehouse_location_balance
         WHERE tenant_id=$1 AND warehouse_id=$2`,
        [context.tenantId,warehouseId]
      );
      if(Number(existing.rows[0]?.count??"0")>0){
        throw new ConflictException(
          "Location balances уже существуют до инициализации — требуется сверка"
        );
      }

      let zone=await client.query<{id:string}>(
        `SELECT id FROM warehouse_zone
         WHERE tenant_id=$1 AND warehouse_id=$2 AND is_system=true
         LIMIT 1`,
        [context.tenantId,warehouseId]
      );

      if(!zone.rows[0]){
        zone=await client.query<{id:string}>(
          `INSERT INTO warehouse_zone(
             tenant_id,warehouse_id,code,name,zone_type,priority,status,
             is_system,created_by_membership_id
           ) VALUES (
             $1,$2,'__SYSTEM__','Системная зона','RECEIVING',0,'ACTIVE',
             true,$3
           )
           RETURNING id`,
          [context.tenantId,warehouseId,context.membershipId]
        );
      }

      let location=await client.query<{id:string}>(
        `SELECT id FROM warehouse_location
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND is_system=true AND code='UNASSIGNED'
         LIMIT 1`,
        [context.tenantId,warehouseId]
      );

      if(!location.rows[0]){
        location=await client.query<{id:string}>(
          `INSERT INTO warehouse_location(
             tenant_id,warehouse_id,zone_id,
             code,full_code,name,location_type,status,
             pick_sequence,allow_mixed_sku,allow_mixed_lot,
             is_system,created_by_membership_id
           ) VALUES (
             $1,$2,$3,'UNASSIGNED','__SYSTEM__-UNASSIGNED',
             'Не размещено','BUFFER','ACTIVE',
             0,true,true,true,$4
           )
           RETURNING id`,
          [
            context.tenantId,warehouseId,zone.rows[0]!.id,
            context.membershipId
          ]
        );
      }

      const unassignedId=location.rows[0]!.id;

      const balances=await client.query<{
        sku_id:string;
        physical_milli:string;
      }>(
        `SELECT sku_id,physical_milli::text
         FROM inventory_balance
         WHERE tenant_id=$1 AND warehouse_id=$2 AND physical_milli>0
         ORDER BY sku_id
         FOR UPDATE`,
        [context.tenantId,warehouseId]
      );

      for(const balance of balances.rows){
        await client.query(
          `INSERT INTO warehouse_location_balance(
             tenant_id,warehouse_id,location_id,sku_id,physical_milli
           ) VALUES ($1,$2,$3,$4,$5)`,
          [
            context.tenantId,warehouseId,unassignedId,
            balance.sku_id,balance.physical_milli
          ]
        );

        await client.query(
          `INSERT INTO wms_location_movement(
             tenant_id,warehouse_id,sku_id,movement_type,
             to_location_id,quantity_milli,
             source_type,idempotency_key,actor_membership_id
           ) VALUES (
             $1,$2,$3,'BOOTSTRAP',$4,$5,
             'WMS_INITIALIZATION',$6,$7
           )`,
          [
            context.tenantId,warehouseId,balance.sku_id,unassignedId,
            balance.physical_milli,
            "wms-bootstrap:"+warehouseId+":"+balance.sku_id,
            context.membershipId
          ]
        );
      }

      await client.query(
        `UPDATE warehouse_wms_profile
         SET stock_tracking_state='LOCATION_LEDGER',
             updated_at=now()
         WHERE tenant_id=$1 AND warehouse_id=$2`,
        [context.tenantId,warehouseId]
      );

      await this.assertLocationReconciliation(
        client,context.tenantId,warehouseId
      );

      await this.audit(
        client,context,"wms.location_ledger_initialized","warehouse",warehouseId,
        {skuCount:balances.rowCount??0}
      );

      return {
        initialized:true,
        unassignedLocationId:unassignedId,
        skuCount:balances.rowCount??0
      };
    });
  }

  async locationBalances(
    context: TenantContext,
    warehouseId: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           b.location_id,l.full_code,l.name AS location_name,l.is_system,
           z.name AS zone_name,z.zone_type,
           b.sku_id,s.code AS sku_code,p.name AS product_name,
           b.physical_milli::text
         FROM warehouse_location_balance b
         JOIN warehouse_location l
           ON l.tenant_id=b.tenant_id AND l.id=b.location_id
         JOIN warehouse_zone z
           ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
         JOIN sku s
           ON s.tenant_id=b.tenant_id AND s.id=b.sku_id
         JOIN product_variant v
           ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p
           ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE b.tenant_id=$1
           AND b.warehouse_id=$2
           AND b.physical_milli>0
         ORDER BY l.is_system DESC,z.priority,l.pick_sequence,p.name,s.code`,
        [context.tenantId,warehouseId]
      );
      return result.rows;
    });
  }

  async createPutawayTask(
    context: TenantContext,
    warehouseId: string,
    input: {
      skuId: string;
      quantityMilli: string;
    }
  ): Promise<{
    taskId:string;
    fromLocationId:string;
    toLocationId:string;
    toLocationCode:string;
    quantityMilli:string;
  }> {
    if(!/^\d+$/.test(input.quantityMilli)||BigInt(input.quantityMilli)<=0n){
      throw new BadRequestException("Некорректное количество размещения");
    }

    const quantity=BigInt(input.quantityMilli);

    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query<{stock_tracking_state:string}>(
        `SELECT stock_tracking_state
         FROM warehouse_wms_profile
         WHERE tenant_id=$1 AND warehouse_id=$2 AND status='ACTIVE'`,
        [context.tenantId,warehouseId]
      );
      if(profile.rows[0]?.stock_tracking_state!=="LOCATION_LEDGER"){
        throw new BadRequestException("Сначала инициализируйте ячеечный учёт");
      }

      const source=await client.query<{id:string;physical_milli:string}>(
        `SELECT l.id,b.physical_milli::text
         FROM warehouse_location l
         JOIN warehouse_location_balance b
           ON b.tenant_id=l.tenant_id
          AND b.location_id=l.id
          AND b.sku_id=$3
         WHERE l.tenant_id=$1
           AND l.warehouse_id=$2
           AND l.is_system=true
           AND l.code='UNASSIGNED'
           AND b.physical_milli>0
         FOR UPDATE OF b`,
        [context.tenantId,warehouseId,input.skuId]
      );
      const sourceRow=source.rows[0];
      if(!sourceRow||BigInt(sourceRow.physical_milli)<quantity){
        throw new ConflictException("В UNASSIGNED недостаточно товара");
      }

      const candidates=await client.query<{
        id:string;
        full_code:string;
        allow_mixed_sku:boolean;
        rule_rank:number;
        rule_priority:number;
        zone_priority:number;
        pick_sequence:number;
      }>(
        `SELECT
           l.id,l.full_code,l.allow_mixed_sku,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM warehouse_location_sku_rule r
               WHERE r.tenant_id=l.tenant_id
                 AND r.warehouse_id=l.warehouse_id
                 AND r.sku_id=$3
                 AND r.rule_type='FIXED_PICK'
                 AND (r.location_id=l.id OR (r.location_id IS NULL AND r.zone_id=l.zone_id))
             ) THEN 0
             WHEN EXISTS (
               SELECT 1 FROM warehouse_location_sku_rule r
               WHERE r.tenant_id=l.tenant_id
                 AND r.warehouse_id=l.warehouse_id
                 AND r.sku_id=$3
                 AND r.rule_type='PREFER'
                 AND (r.location_id=l.id OR (r.location_id IS NULL AND r.zone_id=l.zone_id))
             ) THEN 10
             WHEN EXISTS (
               SELECT 1 FROM warehouse_location_sku_rule r
               WHERE r.tenant_id=l.tenant_id
                 AND r.warehouse_id=l.warehouse_id
                 AND r.sku_id=$3
                 AND r.rule_type='ALLOW'
                 AND (r.location_id=l.id OR (r.location_id IS NULL AND r.zone_id=l.zone_id))
             ) THEN 50
             ELSE 100
           END AS rule_rank,
           COALESCE((
             SELECT min(r.priority)
             FROM warehouse_location_sku_rule r
             WHERE r.tenant_id=l.tenant_id
               AND r.warehouse_id=l.warehouse_id
               AND r.sku_id=$3
               AND r.rule_type IN ('FIXED_PICK','PREFER','ALLOW')
               AND (r.location_id=l.id OR (r.location_id IS NULL AND r.zone_id=l.zone_id))
           ),100) AS rule_priority,
           z.priority AS zone_priority,
           l.pick_sequence
         FROM warehouse_location l
         JOIN warehouse_zone z
           ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
         WHERE l.tenant_id=$1
           AND l.warehouse_id=$2
           AND l.status='ACTIVE'
           AND l.is_system=false
           AND l.location_type IN ('BIN','SHELF','FLOOR','BUFFER')
           AND z.status='ACTIVE'
           AND z.zone_type IN ('STORAGE','PICKING')
           AND NOT EXISTS (
             SELECT 1 FROM warehouse_location_sku_rule r
             WHERE r.tenant_id=l.tenant_id
               AND r.warehouse_id=l.warehouse_id
               AND r.sku_id=$3
               AND r.rule_type='FORBID'
               AND (r.location_id=l.id OR (r.location_id IS NULL AND r.zone_id=l.zone_id))
           )
           AND (
             l.allow_mixed_sku=true OR
             NOT EXISTS (
               SELECT 1 FROM warehouse_location_balance b
               WHERE b.tenant_id=l.tenant_id
                 AND b.location_id=l.id
                 AND b.physical_milli>0
                 AND b.sku_id<>$3
             )
           )
         ORDER BY
           rule_rank,rule_priority,z.priority,l.pick_sequence,l.full_code
         LIMIT 1`,
        [context.tenantId,warehouseId,input.skuId]
      );

      const target=candidates.rows[0];
      if(!target){
        throw new ConflictException(
          "Нет подходящей активной ячейки для размещения SKU"
        );
      }

      const taskKey=
        "putaway:"+warehouseId+":"+input.skuId+":"+
        Date.now().toString()+":"+context.membershipId;

      const task=await client.query<{id:string}>(
        `INSERT INTO warehouse_task(
           tenant_id,warehouse_id,task_type,status,priority,
           sku_id,quantity_milli,from_location_id,to_location_id,
           idempotency_key,instructions
         ) VALUES (
           $1,$2,'PUTAWAY','OPEN',100,
           $3,$4,$5,$6,$7,$8
         )
         RETURNING id`,
        [
          context.tenantId,warehouseId,input.skuId,quantity.toString(),
          sourceRow.id,target.id,taskKey,
          JSON.stringify({
            targetCode:target.full_code,
            reason:"Лучший доступный адрес по SKU-правилам, приоритету зоны и pick sequence"
          })
        ]
      );

      return {
        taskId:task.rows[0]!.id,
        fromLocationId:sourceRow.id,
        toLocationId:target.id,
        toLocationCode:target.full_code,
        quantityMilli:quantity.toString()
      };
    });
  }

  async tasks(
    context:TenantContext,
    warehouseId:string
  ):Promise<Array<Record<string,unknown>>>{
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           t.id,t.task_type,t.status,t.priority,t.sku_id,
           s.code AS sku_code,p.name AS product_name,
           t.quantity_milli::text,
           t.from_location_id,fl.full_code AS from_code,
           t.to_location_id,tl.full_code AS to_code,
           t.claimed_by_membership_id,t.claimed_at,t.completed_at,
           t.instructions,t.last_error,t.created_at
         FROM warehouse_task t
         LEFT JOIN sku s
           ON s.tenant_id=t.tenant_id AND s.id=t.sku_id
         LEFT JOIN product_variant v
           ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         LEFT JOIN product p
           ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         LEFT JOIN warehouse_location fl
           ON fl.tenant_id=t.tenant_id AND fl.id=t.from_location_id
         LEFT JOIN warehouse_location tl
           ON tl.tenant_id=t.tenant_id AND tl.id=t.to_location_id
         WHERE t.tenant_id=$1 AND t.warehouse_id=$2
         ORDER BY
           CASE t.status WHEN 'CLAIMED' THEN 0 WHEN 'OPEN' THEN 1 ELSE 2 END,
           t.priority,t.created_at
         LIMIT 500`,
        [context.tenantId,warehouseId]
      );
      return result.rows;
    });
  }

  async claimTask(
    context:TenantContext,
    taskId:string
  ):Promise<void>{
    await this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        status:string;
        claimed_by_membership_id:string|null;
      }>(
        `SELECT status,claimed_by_membership_id
         FROM warehouse_task
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,taskId]
      );
      const row=task.rows[0];
      if(!row) throw new NotFoundException("Задача не найдена");
      if(row.status==="COMPLETED") return;
      if(row.status==="CLAIMED"&&row.claimed_by_membership_id!==context.membershipId){
        throw new ConflictException("Задачу уже выполняет другой сотрудник");
      }
      if(row.status!=="OPEN"&&row.status!=="CLAIMED"){
        throw new BadRequestException("Задачу нельзя взять в работу");
      }

      await client.query(
        `UPDATE warehouse_task
         SET status='CLAIMED',
             claimed_by_membership_id=$3,
             claimed_at=COALESCE(claimed_at,now()),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,taskId,context.membershipId]
      );
    });
  }

  async completePutaway(
    context:TenantContext,
    taskId:string
  ):Promise<void>{
    await this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        warehouse_id:string;
        task_type:string;
        status:string;
        sku_id:string;
        quantity_milli:string;
        from_location_id:string;
        to_location_id:string;
        claimed_by_membership_id:string|null;
      }>(
        `SELECT
           warehouse_id,task_type,status,sku_id,quantity_milli::text,
           from_location_id,to_location_id,claimed_by_membership_id
         FROM warehouse_task
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,taskId]
      );

      const row=task.rows[0];
      if(!row) throw new NotFoundException("Задача не найдена");
      if(row.status==="COMPLETED") return;
      if(row.task_type!=="PUTAWAY"){
        throw new BadRequestException("Это не задача размещения");
      }
      if(row.status!=="CLAIMED"||row.claimed_by_membership_id!==context.membershipId){
        throw new ConflictException("Сначала возьмите задачу в работу");
      }

      const target=await client.query<{
        status:string;
        allow_mixed_sku:boolean;
      }>(
        `SELECT status,allow_mixed_sku
         FROM warehouse_location
         WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3
         FOR UPDATE`,
        [context.tenantId,row.warehouse_id,row.to_location_id]
      );
      const targetRow=target.rows[0];
      if(!targetRow||targetRow.status!=="ACTIVE"){
        throw new ConflictException("Целевая ячейка недоступна");
      }

      if(!targetRow.allow_mixed_sku){
        const mixed=await client.query(
          `SELECT 1 FROM warehouse_location_balance
           WHERE tenant_id=$1
             AND warehouse_id=$2
             AND location_id=$3
             AND physical_milli>0
             AND sku_id<>$4
           LIMIT 1`,
          [
            context.tenantId,row.warehouse_id,row.to_location_id,row.sku_id
          ]
        );
        if(mixed.rowCount){
          throw new ConflictException("Целевая ячейка не допускает смешивание SKU");
        }
      }

      const source=await client.query<{physical_milli:string}>(
        `SELECT physical_milli::text
         FROM warehouse_location_balance
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND location_id=$3
           AND sku_id=$4
         FOR UPDATE`,
        [
          context.tenantId,row.warehouse_id,row.from_location_id,row.sku_id
        ]
      );
      const quantity=BigInt(row.quantity_milli);
      if(BigInt(source.rows[0]?.physical_milli??"0")<quantity){
        throw new ConflictException("В исходном адресе недостаточно товара");
      }

      await client.query(
        `UPDATE warehouse_location_balance
         SET physical_milli=physical_milli-$5::bigint,updated_at=now()
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND location_id=$3
           AND sku_id=$4`,
        [
          context.tenantId,row.warehouse_id,row.from_location_id,row.sku_id,
          quantity.toString()
        ]
      );

      await client.query(
        `INSERT INTO warehouse_location_balance(
           tenant_id,warehouse_id,location_id,sku_id,physical_milli
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id,warehouse_id,location_id,sku_id)
         DO UPDATE SET
           physical_milli=warehouse_location_balance.physical_milli+
             EXCLUDED.physical_milli,
           updated_at=now()`,
        [
          context.tenantId,row.warehouse_id,row.to_location_id,row.sku_id,
          quantity.toString()
        ]
      );

      await client.query(
        `INSERT INTO wms_location_movement(
           tenant_id,warehouse_id,sku_id,movement_type,
           from_location_id,to_location_id,quantity_milli,
           source_type,source_id,idempotency_key,actor_membership_id
         ) VALUES (
           $1,$2,$3,'PUTAWAY',$4,$5,$6,
           'WAREHOUSE_TASK',$7,$8,$9
         )
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
        [
          context.tenantId,row.warehouse_id,row.sku_id,
          row.from_location_id,row.to_location_id,quantity.toString(),
          taskId,"putaway-task:"+taskId,context.membershipId
        ]
      );

      await client.query(
        `UPDATE warehouse_task
         SET status='COMPLETED',
             completed_at=now(),
             result=$3,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,taskId,
          JSON.stringify({completedBy:context.membershipId})
        ]
      );

      await this.assertLocationReconciliation(
        client,context.tenantId,row.warehouse_id
      );
    });
  }

  async reconciliation(
    context:TenantContext,
    warehouseId:string
  ):Promise<Array<Record<string,unknown>>>{
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           COALESCE(i.sku_id,l.sku_id) AS sku_id,
           s.code AS sku_code,
           COALESCE(i.physical_milli,0)::text AS inventory_physical_milli,
           COALESCE(l.location_milli,0)::text AS location_physical_milli,
           (
             COALESCE(i.physical_milli,0)-
             COALESCE(l.location_milli,0)
           )::text AS difference_milli
         FROM inventory_balance i
         FULL OUTER JOIN (
           SELECT tenant_id,warehouse_id,sku_id,
                  sum(physical_milli) AS location_milli
           FROM warehouse_location_balance
           WHERE tenant_id=$1 AND warehouse_id=$2
           GROUP BY tenant_id,warehouse_id,sku_id
         ) l
           ON l.tenant_id=i.tenant_id
          AND l.warehouse_id=i.warehouse_id
          AND l.sku_id=i.sku_id
         JOIN sku s
           ON s.tenant_id=COALESCE(i.tenant_id,l.tenant_id)
          AND s.id=COALESCE(i.sku_id,l.sku_id)
         WHERE COALESCE(i.tenant_id,l.tenant_id)=$1
           AND COALESCE(i.warehouse_id,l.warehouse_id)=$2
         ORDER BY s.code`,
        [context.tenantId,warehouseId]
      );
      return result.rows;
    });
  }

  private async assertLocationReconciliation(
    client:PoolClient,
    tenantId:string,
    warehouseId:string
  ):Promise<void>{
    const mismatch=await client.query(
      `SELECT 1
       FROM (
         SELECT
           COALESCE(i.sku_id,l.sku_id) AS sku_id,
           COALESCE(i.physical_milli,0) AS inventory_milli,
           COALESCE(l.location_milli,0) AS location_milli
         FROM inventory_balance i
         FULL OUTER JOIN (
           SELECT tenant_id,warehouse_id,sku_id,
                  sum(physical_milli) AS location_milli
           FROM warehouse_location_balance
           WHERE tenant_id=$1 AND warehouse_id=$2
           GROUP BY tenant_id,warehouse_id,sku_id
         ) l
           ON l.tenant_id=i.tenant_id
          AND l.warehouse_id=i.warehouse_id
          AND l.sku_id=i.sku_id
         WHERE COALESCE(i.tenant_id,l.tenant_id)=$1
           AND COALESCE(i.warehouse_id,l.warehouse_id)=$2
       ) q
       WHERE inventory_milli<>location_milli
       LIMIT 1`,
      [tenantId,warehouseId]
    );
    if(mismatch.rowCount){
      throw new ConflictException(
        "WMS location ledger не сходится с Inventory Balance"
      );
    }
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
