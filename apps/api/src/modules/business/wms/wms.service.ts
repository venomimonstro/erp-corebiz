import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { InventoryService } from "../inventory/inventory.service";

const ZONE_TYPES = new Set([
  "RECEIVING","STORAGE","PICKING","PACKING","SHIPPING",
  "QUARANTINE","RETURNS","CROSS_DOCK"
]);

const LOCATION_TYPES = new Set([
  "DOCK","STAGING","AISLE","RACK","SHELF","BIN","FLOOR","BUFFER"
]);

@Injectable()
export class WmsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventory: InventoryService
  ) {}

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
           t.source_type,t.source_id,t.source_line_id,
           t.wave_id,t.cluster_slot,
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

  async planOutbound(
    context: TenantContext,
    orderId: string
  ): Promise<{
    orderId:string;
    pickTasks:number;
    allocations:number;
  }> {
    return this.database.withTenantTransaction(context,async client=>{
      const reservations=await client.query<{
        id:string;
        sales_order_line_id:string;
        warehouse_id:string;
        sku_id:string;
        quantity_milli:string;
      }>(
        `SELECT
           r.id,r.sales_order_line_id,r.warehouse_id,r.sku_id,
           r.quantity_milli::text
         FROM inventory_reservation r
         JOIN warehouse_wms_profile p
           ON p.tenant_id=r.tenant_id
          AND p.warehouse_id=r.warehouse_id
          AND p.status='ACTIVE'
          AND p.stock_tracking_state='LOCATION_LEDGER'
         WHERE r.tenant_id=$1
           AND r.sales_order_id=$2
           AND r.status='ACTIVE'
         ORDER BY r.warehouse_id,r.created_at
         FOR UPDATE OF r`,
        [context.tenantId,orderId]
      );

      if(!reservations.rowCount){
        throw new ConflictException(
          "Для заказа нет активных резервов в адресном WMS"
        );
      }

      let taskCount=0;
      let allocationCount=0;

      for(const reservation of reservations.rows){
        const allocated=await client.query<{quantity:string}>(
          `SELECT COALESCE(sum(quantity_milli),0)::text AS quantity
           FROM wms_pick_allocation
           WHERE tenant_id=$1
             AND reservation_id=$2
             AND status<>'RELEASED'`,
          [context.tenantId,reservation.id]
        );

        let remaining=
          BigInt(reservation.quantity_milli)-
          BigInt(allocated.rows[0]?.quantity??"0");

        if(remaining<=0n) continue;

        const outbound=await client.query<{id:string;full_code:string}>(
          `SELECT l.id,l.full_code
           FROM warehouse_location l
           JOIN warehouse_zone z
             ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
           WHERE l.tenant_id=$1
             AND l.warehouse_id=$2
             AND l.status='ACTIVE'
             AND l.is_system=false
             AND z.status='ACTIVE'
             AND z.zone_type IN ('PACKING','SHIPPING')
           ORDER BY
             CASE z.zone_type WHEN 'PACKING' THEN 0 ELSE 1 END,
             z.priority,l.pick_sequence,l.full_code
           LIMIT 1`,
          [context.tenantId,reservation.warehouse_id]
        );

        const outboundRow=outbound.rows[0];
        if(!outboundRow){
          throw new ConflictException(
            "Для склада нет активной PACKING/SHIPPING ячейки"
          );
        }

        const sources=await client.query<{
          location_id:string;
          full_code:string;
          physical_milli:string;
          planned_milli:string;
        }>(
          `SELECT
             b.location_id,l.full_code,b.physical_milli::text,
             COALESCE((
               SELECT sum(a.quantity_milli)
               FROM wms_pick_allocation a
               WHERE a.tenant_id=b.tenant_id
                 AND a.warehouse_id=b.warehouse_id
                 AND a.source_location_id=b.location_id
                 AND a.sku_id=b.sku_id
                 AND a.status='PLANNED'
             ),0)::text AS planned_milli
           FROM warehouse_location_balance b
           JOIN warehouse_location l
             ON l.tenant_id=b.tenant_id AND l.id=b.location_id
           JOIN warehouse_zone z
             ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
           WHERE b.tenant_id=$1
             AND b.warehouse_id=$2
             AND b.sku_id=$3
             AND b.physical_milli>0
             AND l.status='ACTIVE'
             AND l.is_system=false
             AND z.status='ACTIVE'
             AND z.zone_type IN ('PICKING','STORAGE')
           ORDER BY
             CASE WHEN EXISTS (
               SELECT 1
               FROM warehouse_location_sku_rule r
               WHERE r.tenant_id=b.tenant_id
                 AND r.warehouse_id=b.warehouse_id
                 AND r.sku_id=b.sku_id
                 AND r.rule_type='FIXED_PICK'
                 AND (
                   r.location_id=b.location_id OR
                   (r.location_id IS NULL AND r.zone_id=l.zone_id)
                 )
             ) THEN 0 ELSE 1 END,
             z.priority,l.pick_sequence,l.full_code
           FOR UPDATE OF b`,
          [
            context.tenantId,
            reservation.warehouse_id,
            reservation.sku_id
          ]
        );

        for(const source of sources.rows){
          if(remaining<=0n) break;

          const available=
            BigInt(source.physical_milli)-
            BigInt(source.planned_milli);
          if(available<=0n) continue;

          const quantity=available<remaining?available:remaining;

          const allocation=await client.query<{id:string}>(
            `INSERT INTO wms_pick_allocation(
               tenant_id,sales_order_id,reservation_id,warehouse_id,sku_id,
               source_location_id,outbound_location_id,quantity_milli
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (reservation_id,source_location_id) DO NOTHING
             RETURNING id`,
            [
              context.tenantId,orderId,reservation.id,
              reservation.warehouse_id,reservation.sku_id,
              source.location_id,outboundRow.id,quantity.toString()
            ]
          );

          const allocationId=allocation.rows[0]?.id;
          if(!allocationId) continue;

          const task=await client.query<{id:string}>(
            `INSERT INTO warehouse_task(
               tenant_id,warehouse_id,task_type,status,priority,
               sku_id,quantity_milli,from_location_id,to_location_id,
               source_type,source_id,source_line_id,
               idempotency_key,instructions
             ) VALUES (
               $1,$2,'PICK','OPEN',100,
               $3,$4,$5,$6,
               'INVENTORY_RESERVATION',$7,$8,
               $9,$10
             )
             RETURNING id`,
            [
              context.tenantId,reservation.warehouse_id,reservation.sku_id,
              quantity.toString(),source.location_id,outboundRow.id,
              reservation.id,reservation.sales_order_line_id,
              "pick:"+reservation.id+":"+source.location_id,
              JSON.stringify({
                orderId,
                from:source.full_code,
                to:outboundRow.full_code
              })
            ]
          );

          await client.query(
            `UPDATE wms_pick_allocation
             SET pick_task_id=$3
             WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId,allocationId,task.rows[0]!.id]
          );

          taskCount+=1;
          allocationCount+=1;
          remaining-=quantity;
        }

        if(remaining>0n){
          throw new ConflictException(
            "Недостаточно товара по активным WMS-ячейкам для полного отбора"
          );
        }
      }

      await this.audit(
        client,context,"wms.outbound_planned","sales_order",orderId,
        {pickTasks:taskCount,allocations:allocationCount}
      );

      return {orderId,pickTasks:taskCount,allocations:allocationCount};
    });
  }

  async completePick(
    context:TenantContext,
    taskId:string
  ):Promise<void>{
    await this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        status:string;
        warehouse_id:string;
        sku_id:string;
        quantity_milli:string;
        from_location_id:string;
        to_location_id:string;
        claimed_by_membership_id:string|null;
        allocation_id:string;
        allocation_status:string;
        sales_order_id:string;
        wave_id:string|null;
      }>(
        `SELECT
           t.status,t.warehouse_id,t.sku_id,t.quantity_milli::text,
           t.from_location_id,t.to_location_id,t.claimed_by_membership_id,
           t.wave_id,
           a.id AS allocation_id,a.status AS allocation_status,
           a.sales_order_id
         FROM warehouse_task t
         JOIN wms_pick_allocation a
           ON a.tenant_id=t.tenant_id AND a.pick_task_id=t.id
         WHERE t.tenant_id=$1 AND t.id=$2 AND t.task_type='PICK'
         FOR UPDATE OF t,a`,
        [context.tenantId,taskId]
      );

      const row=task.rows[0];
      if(!row) throw new NotFoundException("PICK-задача не найдена");
      if(row.status==="COMPLETED"&&row.allocation_status==="PICKED") return;
      if(row.status!=="CLAIMED"){
        throw new ConflictException("Сначала возьмите PICK-задачу");
      }
      if(
        row.claimed_by_membership_id &&
        row.claimed_by_membership_id!==context.membershipId
      ){
        throw new ConflictException("PICK-задача взята другим сотрудником");
      }

      const target=await client.query<{status:string;zone_type:string}>(
        `SELECT l.status,z.zone_type
         FROM warehouse_location l
         JOIN warehouse_zone z
           ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
         WHERE l.tenant_id=$1 AND l.id=$2
         FOR UPDATE OF l`,
        [context.tenantId,row.to_location_id]
      );
      const targetRow=target.rows[0];
      if(
        !targetRow ||
        targetRow.status!=="ACTIVE" ||
        !["PACKING","SHIPPING"].includes(targetRow.zone_type)
      ){
        throw new ConflictException("Outbound ячейка недоступна");
      }

      const source=await client.query<{physical_milli:string}>(
        `SELECT physical_milli::text
         FROM warehouse_location_balance
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND location_id=$3 AND sku_id=$4
         FOR UPDATE`,
        [
          context.tenantId,row.warehouse_id,
          row.from_location_id,row.sku_id
        ]
      );

      const quantity=BigInt(row.quantity_milli);
      if(BigInt(source.rows[0]?.physical_milli??"0")<quantity){
        throw new ConflictException("В исходной ячейке недостаточно товара");
      }

      await client.query(
        `UPDATE warehouse_location_balance
         SET physical_milli=physical_milli-$5::bigint,updated_at=now()
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND location_id=$3 AND sku_id=$4`,
        [
          context.tenantId,row.warehouse_id,
          row.from_location_id,row.sku_id,quantity.toString()
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
          context.tenantId,row.warehouse_id,
          row.to_location_id,row.sku_id,quantity.toString()
        ]
      );

      await client.query(
        `INSERT INTO wms_location_movement(
           tenant_id,warehouse_id,sku_id,movement_type,
           from_location_id,to_location_id,quantity_milli,
           source_type,source_id,idempotency_key,actor_membership_id
         ) VALUES (
           $1,$2,$3,'PICK',$4,$5,$6,
           'WAREHOUSE_TASK',$7,$8,$9
         )
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
        [
          context.tenantId,row.warehouse_id,row.sku_id,
          row.from_location_id,row.to_location_id,quantity.toString(),
          taskId,"pick-task:"+taskId,context.membershipId
        ]
      );

      await client.query(
        `UPDATE wms_pick_allocation
         SET status='PICKED',picked_at=COALESCE(picked_at,now())
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,row.allocation_id]
      );

      await client.query(
        `UPDATE warehouse_task
         SET status='COMPLETED',completed_at=now(),
             result=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,taskId,
          JSON.stringify({completedBy:context.membershipId})
        ]
      );

      const pending=await client.query(
        `SELECT 1
         FROM wms_pick_allocation
         WHERE tenant_id=$1
           AND sales_order_id=$2
           AND warehouse_id=$3
           AND status='PLANNED'
         LIMIT 1`,
        [context.tenantId,row.sales_order_id,row.warehouse_id]
      );

      if(!pending.rowCount){
        await client.query(
          `INSERT INTO warehouse_task(
             tenant_id,warehouse_id,task_type,status,priority,
             source_type,source_id,idempotency_key,instructions
           ) VALUES (
             $1,$2,'PACK','OPEN',100,
             'SALES_ORDER',$3,$4,$5
           )
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
          [
            context.tenantId,row.warehouse_id,row.sales_order_id,
            "pack:"+row.sales_order_id+":"+row.warehouse_id,
            JSON.stringify({
              orderId:row.sales_order_id,
              warehouseId:row.warehouse_id
            })
          ]
        );
      }

      if(row.wave_id){
        const activeWaveTask=await client.query(
          `SELECT 1
           FROM warehouse_task
           WHERE tenant_id=$1 AND wave_id=$2
             AND status IN ('OPEN','CLAIMED')
           LIMIT 1`,
          [context.tenantId,row.wave_id]
        );
        if(!activeWaveTask.rowCount){
          await client.query(
            `UPDATE wms_wave
             SET status='COMPLETED',completed_at=COALESCE(completed_at,now())
             WHERE tenant_id=$1 AND id=$2
               AND status IN ('RELEASED','IN_PROGRESS')`,
            [context.tenantId,row.wave_id]
          );
        }
      }

      await this.assertLocationReconciliation(
        client,context.tenantId,row.warehouse_id
      );
    });
  }

  async createPackTask(
    context:TenantContext,
    orderId:string,
    warehouseId:string
  ):Promise<{taskId:string}>{
    return this.database.withTenantTransaction(context,async client=>{
      const counts=await client.query<{
        planned:string;
        picked:string;
        packed:string;
        shipped:string;
      }>(
        `SELECT
           count(*) FILTER (WHERE status='PLANNED')::text AS planned,
           count(*) FILTER (WHERE status='PICKED')::text AS picked,
           count(*) FILTER (WHERE status='PACKED')::text AS packed,
           count(*) FILTER (WHERE status='SHIPPED')::text AS shipped
         FROM wms_pick_allocation
         WHERE tenant_id=$1 AND sales_order_id=$2 AND warehouse_id=$3`,
        [context.tenantId,orderId,warehouseId]
      );
      const row=counts.rows[0]!;
      if(Number(row.planned)>0){
        throw new ConflictException("Не все PICK-задачи завершены");
      }
      if(
        Number(row.picked)+Number(row.packed)+Number(row.shipped)===0
      ){
        throw new ConflictException("Для упаковки нет отобранного товара");
      }

      const existing=await client.query<{id:string}>(
        `SELECT id FROM warehouse_task
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND task_type='PACK' AND source_type='SALES_ORDER'
           AND source_id=$3 AND status<>'CANCELLED'
         ORDER BY created_at DESC LIMIT 1`,
        [context.tenantId,warehouseId,orderId]
      );
      if(existing.rows[0]) return {taskId:existing.rows[0].id};

      const task=await client.query<{id:string}>(
        `INSERT INTO warehouse_task(
           tenant_id,warehouse_id,task_type,status,priority,
           source_type,source_id,idempotency_key,instructions
         ) VALUES (
           $1,$2,'PACK','OPEN',100,
           'SALES_ORDER',$3,$4,$5
         )
         RETURNING id`,
        [
          context.tenantId,warehouseId,orderId,
          "pack:"+orderId+":"+warehouseId,
          JSON.stringify({orderId,warehouseId})
        ]
      );
      return {taskId:task.rows[0]!.id};
    });
  }

  async completePack(
    context:TenantContext,
    taskId:string
  ):Promise<{shipTaskId:string}>{
    return this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        status:string;
        warehouse_id:string;
        source_id:string;
        claimed_by_membership_id:string|null;
      }>(
        `SELECT status,warehouse_id,source_id,claimed_by_membership_id
         FROM warehouse_task
         WHERE tenant_id=$1 AND id=$2 AND task_type='PACK'
         FOR UPDATE`,
        [context.tenantId,taskId]
      );
      const row=task.rows[0];
      if(!row) throw new NotFoundException("PACK-задача не найдена");
      if(row.status==="COMPLETED"){
        const existingShip=await client.query<{id:string}>(
          `SELECT id FROM warehouse_task
           WHERE tenant_id=$1 AND warehouse_id=$2
             AND task_type='SHIP' AND source_type='SALES_ORDER'
             AND source_id=$3 AND status<>'CANCELLED'
           ORDER BY created_at DESC LIMIT 1`,
          [context.tenantId,row.warehouse_id,row.source_id]
        );
        if(!existingShip.rows[0]){
          throw new ConflictException("PACK завершён без SHIP-задачи");
        }
        return {shipTaskId:existingShip.rows[0].id};
      }
      if(row.status!=="CLAIMED"){
        throw new ConflictException("Сначала возьмите PACK-задачу");
      }
      if(
        row.claimed_by_membership_id &&
        row.claimed_by_membership_id!==context.membershipId
      ){
        throw new ConflictException("PACK-задача взята другим сотрудником");
      }

      const pending=await client.query(
        `SELECT 1 FROM wms_pick_allocation
         WHERE tenant_id=$1 AND sales_order_id=$2 AND warehouse_id=$3
           AND status='PLANNED'
         LIMIT 1`,
        [context.tenantId,row.source_id,row.warehouse_id]
      );
      if(pending.rowCount){
        throw new ConflictException("Есть незавершённый отбор");
      }

      await client.query(
        `UPDATE wms_pick_allocation
         SET status='PACKED',packed_at=COALESCE(packed_at,now())
         WHERE tenant_id=$1 AND sales_order_id=$2 AND warehouse_id=$3
           AND status='PICKED'`,
        [context.tenantId,row.source_id,row.warehouse_id]
      );

      const ship=await client.query<{id:string}>(
        `INSERT INTO warehouse_task(
           tenant_id,warehouse_id,task_type,status,priority,
           source_type,source_id,idempotency_key,instructions
         ) VALUES (
           $1,$2,'SHIP','OPEN',100,
           'SALES_ORDER',$3,$4,$5
         )
         ON CONFLICT (tenant_id,idempotency_key)
         DO UPDATE SET updated_at=warehouse_task.updated_at
         RETURNING id`,
        [
          context.tenantId,row.warehouse_id,row.source_id,
          "ship:"+row.source_id+":"+row.warehouse_id,
          JSON.stringify({orderId:row.source_id,warehouseId:row.warehouse_id})
        ]
      );

      await client.query(
        `UPDATE warehouse_task
         SET status='COMPLETED',completed_at=now(),
             result=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,taskId,
          JSON.stringify({completedBy:context.membershipId,shipTaskId:ship.rows[0]!.id})
        ]
      );

      return {shipTaskId:ship.rows[0]!.id};
    });
  }

  async completeShip(
    context:TenantContext,
    taskId:string
  ):Promise<{
    orderId:string;
    fulfillmentStatus:"PARTIALLY_SHIPPED"|"SHIPPED";
  }>{
    return this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        status:string;
        warehouse_id:string;
        source_id:string;
        claimed_by_membership_id:string|null;
      }>(
        `SELECT status,warehouse_id,source_id,claimed_by_membership_id
         FROM warehouse_task
         WHERE tenant_id=$1 AND id=$2 AND task_type='SHIP'
         FOR UPDATE`,
        [context.tenantId,taskId]
      );
      const row=task.rows[0];
      if(!row) throw new NotFoundException("SHIP-задача не найдена");

      if(row.status==="COMPLETED"){
        const order=await client.query<{fulfillment_status:string}>(
          `SELECT fulfillment_status FROM sales_order
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.source_id]
        );
        return {
          orderId:row.source_id,
          fulfillmentStatus:
            order.rows[0]?.fulfillment_status==="SHIPPED"
              ? "SHIPPED"
              : "PARTIALLY_SHIPPED"
        };
      }

      if(row.status!=="CLAIMED"){
        throw new ConflictException("Сначала возьмите SHIP-задачу");
      }
      if(
        row.claimed_by_membership_id &&
        row.claimed_by_membership_id!==context.membershipId
      ){
        throw new ConflictException("SHIP-задача взята другим сотрудником");
      }

      const allocations=await client.query<{
        id:string;
        reservation_id:string;
        sku_id:string;
        outbound_location_id:string;
        quantity_milli:string;
        status:string;
      }>(
        `SELECT
           id,reservation_id,sku_id,outbound_location_id,
           quantity_milli::text,status
         FROM wms_pick_allocation
         WHERE tenant_id=$1
           AND sales_order_id=$2
           AND warehouse_id=$3
         ORDER BY reservation_id,id
         FOR UPDATE`,
        [context.tenantId,row.source_id,row.warehouse_id]
      );

      if(!allocations.rowCount){
        throw new ConflictException("Для SHIP-задачи нет WMS allocation");
      }
      if(allocations.rows.some(a=>!["PACKED","SHIPPED"].includes(a.status))){
        throw new ConflictException("Перед отгрузкой весь товар должен быть PACKED");
      }

      const reservationIds=Array.from(
        new Set(
          allocations.rows
            .filter(a=>a.status==="PACKED")
            .map(a=>a.reservation_id)
        )
      );

      for(const reservationId of reservationIds){
        const total=await client.query<{
          allocation_milli:string;
          reservation_milli:string;
        }>(
          `SELECT
             COALESCE(sum(a.quantity_milli),0)::text AS allocation_milli,
             max(r.quantity_milli)::text AS reservation_milli
           FROM inventory_reservation r
           LEFT JOIN wms_pick_allocation a
             ON a.tenant_id=r.tenant_id
            AND a.reservation_id=r.id
            AND a.status IN ('PACKED','SHIPPED')
           WHERE r.tenant_id=$1 AND r.id=$2
           GROUP BY r.id`,
          [context.tenantId,reservationId]
        );
        const totals=total.rows[0];
        if(
          !totals ||
          BigInt(totals.allocation_milli)!==BigInt(totals.reservation_milli)
        ){
          throw new ConflictException(
            "WMS allocation не покрывает резерв полностью"
          );
        }

        await this.inventory.consumeWmsReservation(
          client,
          context,
          {
            reservationId,
            idempotencyKey:"wms-reservation-ship:"+reservationId
          }
        );
      }

      for(const allocation of allocations.rows.filter(a=>a.status==="PACKED")){
        const quantity=BigInt(allocation.quantity_milli);
        const balance=await client.query<{physical_milli:string}>(
          `SELECT physical_milli::text
           FROM warehouse_location_balance
           WHERE tenant_id=$1 AND warehouse_id=$2
             AND location_id=$3 AND sku_id=$4
           FOR UPDATE`,
          [
            context.tenantId,row.warehouse_id,
            allocation.outbound_location_id,allocation.sku_id
          ]
        );
        if(BigInt(balance.rows[0]?.physical_milli??"0")<quantity){
          throw new ConflictException(
            "В outbound ячейке недостаточно товара для отгрузки"
          );
        }

        await client.query(
          `UPDATE warehouse_location_balance
           SET physical_milli=physical_milli-$5::bigint,updated_at=now()
           WHERE tenant_id=$1 AND warehouse_id=$2
             AND location_id=$3 AND sku_id=$4`,
          [
            context.tenantId,row.warehouse_id,
            allocation.outbound_location_id,allocation.sku_id,
            quantity.toString()
          ]
        );

        await client.query(
          `INSERT INTO wms_location_movement(
             tenant_id,warehouse_id,sku_id,movement_type,
             from_location_id,quantity_milli,
             source_type,source_id,idempotency_key,actor_membership_id
           ) VALUES (
             $1,$2,$3,'SHIP',$4,$5,
             'SALES_ORDER',$6,$7,$8
           )
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
          [
            context.tenantId,row.warehouse_id,allocation.sku_id,
            allocation.outbound_location_id,quantity.toString(),
            row.source_id,
            "ship-allocation:"+allocation.id,
            context.membershipId
          ]
        );

        await client.query(
          `UPDATE wms_pick_allocation
           SET status='SHIPPED',shipped_at=COALESCE(shipped_at,now())
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,allocation.id]
        );
      }

      const final=await this.inventory.finalizeWmsOrderShipment(
        client,context,row.source_id
      );

      await client.query(
        `UPDATE warehouse_task
         SET status='COMPLETED',completed_at=now(),
             result=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,taskId,
          JSON.stringify({
            completedBy:context.membershipId,
            fulfillmentStatus:final.fulfillmentStatus
          })
        ]
      );

      await this.assertLocationReconciliation(
        client,context.tenantId,row.warehouse_id
      );

      return {
        orderId:row.source_id,
        fulfillmentStatus:final.fulfillmentStatus
      };
    });
  }

  async createCycleCount(
    context:TenantContext,
    warehouseId:string,
    input:{
      zoneId?:string;
      locationId?:string;
      reason?:string;
    }={}
  ):Promise<{countId:string;tasks:number}>{
    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query<{stock_tracking_state:string}>(
        `SELECT stock_tracking_state
         FROM warehouse_wms_profile
         WHERE tenant_id=$1 AND warehouse_id=$2 AND status='ACTIVE'`,
        [context.tenantId,warehouseId]
      );
      if(profile.rows[0]?.stock_tracking_state!=="LOCATION_LEDGER"){
        throw new BadRequestException("Cycle count требует активный ячеечный учёт");
      }

      if(input.locationId){
        const location=await client.query<{zone_id:string}>(
          `SELECT zone_id
           FROM warehouse_location
           WHERE tenant_id=$1 AND warehouse_id=$2
             AND id=$3 AND status='ACTIVE' AND is_system=false`,
          [context.tenantId,warehouseId,input.locationId]
        );
        if(!location.rows[0]){
          throw new NotFoundException("Ячейка для пересчёта не найдена");
        }
        if(input.zoneId&&input.zoneId!==location.rows[0].zone_id){
          throw new BadRequestException("Ячейка относится к другой зоне");
        }
      }

      const balances=await client.query<{
        location_id:string;
        sku_id:string;
        physical_milli:string;
      }>(
        `SELECT
           b.location_id,b.sku_id,b.physical_milli::text
         FROM warehouse_location_balance b
         JOIN warehouse_location l
           ON l.tenant_id=b.tenant_id AND l.id=b.location_id
         WHERE b.tenant_id=$1
           AND b.warehouse_id=$2
           AND b.physical_milli>0
           AND l.status='ACTIVE'
           AND l.is_system=false
           AND ($3::uuid IS NULL OR l.zone_id=$3)
           AND ($4::uuid IS NULL OR l.id=$4)
         ORDER BY l.pick_sequence,l.full_code,b.sku_id
         FOR UPDATE OF b`,
        [
          context.tenantId,
          warehouseId,
          input.zoneId??null,
          input.locationId??null
        ]
      );

      if(!balances.rowCount){
        throw new ConflictException(
          "В выбранной области нет положительного остатка для пересчёта"
        );
      }

      const count=await client.query<{id:string}>(
        `INSERT INTO wms_cycle_count(
           tenant_id,warehouse_id,zone_id,location_id,reason,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,warehouseId,
          input.zoneId??null,input.locationId??null,
          input.reason?.trim()||null,context.membershipId
        ]
      );
      const countId=count.rows[0]!.id;
      let tasks=0;

      for(const balance of balances.rows){
        const line=await client.query<{id:string}>(
          `INSERT INTO wms_cycle_count_line(
             tenant_id,count_id,warehouse_id,location_id,sku_id,expected_milli
           ) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            context.tenantId,countId,warehouseId,
            balance.location_id,balance.sku_id,balance.physical_milli
          ]
        );
        const lineId=line.rows[0]!.id;

        const task=await client.query<{id:string}>(
          `INSERT INTO warehouse_task(
             tenant_id,warehouse_id,task_type,status,priority,
             sku_id,quantity_milli,from_location_id,
             source_type,source_id,source_line_id,
             idempotency_key,instructions
           ) VALUES (
             $1,$2,'COUNT','OPEN',80,
             $3,$4,$5,
             'WMS_CYCLE_COUNT',$6,$7,
             $8,$9
           )
           RETURNING id`,
          [
            context.tenantId,warehouseId,balance.sku_id,
            balance.physical_milli,balance.location_id,
            countId,lineId,
            "count:"+lineId,
            JSON.stringify({
              countId,
              countLineId:lineId,
              expectedMilli:balance.physical_milli
            })
          ]
        );

        await client.query(
          `UPDATE wms_cycle_count_line
           SET task_id=$3
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,lineId,task.rows[0]!.id]
        );
        tasks+=1;
      }

      await this.audit(
        client,context,"wms.cycle_count_created","wms_cycle_count",countId,
        {
          warehouseId,
          zoneId:input.zoneId??null,
          locationId:input.locationId??null,
          tasks
        }
      );

      return {countId,tasks};
    });
  }

  async completeCycleCountTask(
    context:TenantContext,
    taskId:string,
    countedMilliInput:string
  ):Promise<{
    varianceMilli:string;
    countCompleted:boolean;
  }>{
    if(!/^\d+$/.test(countedMilliInput)){
      throw new BadRequestException("Некорректный фактический остаток");
    }
    const counted=BigInt(countedMilliInput);

    return this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        task_status:string;
        claimed_by_membership_id:string|null;
        warehouse_id:string;
        line_id:string;
        count_id:string;
        count_status:string;
        line_status:string;
        location_id:string;
        sku_id:string;
        expected_milli:string;
      }>(
        `SELECT
           t.status AS task_status,t.claimed_by_membership_id,t.warehouse_id,
           l.id AS line_id,l.count_id,c.status AS count_status,
           l.status AS line_status,l.location_id,l.sku_id,
           l.expected_milli::text
         FROM warehouse_task t
         JOIN wms_cycle_count_line l
           ON l.tenant_id=t.tenant_id AND l.task_id=t.id
         JOIN wms_cycle_count c
           ON c.tenant_id=l.tenant_id AND c.id=l.count_id
         WHERE t.tenant_id=$1 AND t.id=$2 AND t.task_type='COUNT'
         FOR UPDATE OF t,l,c`,
        [context.tenantId,taskId]
      );

      const row=task.rows[0];
      if(!row) throw new NotFoundException("COUNT-задача не найдена");
      if(row.task_status==="COMPLETED"&&row.line_status==="POSTED"){
        const line=await client.query<{variance_milli:string}>(
          `SELECT variance_milli::text
           FROM wms_cycle_count_line
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.line_id]
        );
        return {
          varianceMilli:line.rows[0]?.variance_milli??"0",
          countCompleted:row.count_status==="POSTED"
        };
      }
      if(row.count_status!=="OPEN"){
        throw new ConflictException("Пересчёт уже закрыт");
      }
      if(
        row.task_status!=="CLAIMED" ||
        row.claimed_by_membership_id!==context.membershipId
      ){
        throw new ConflictException("Сначала возьмите COUNT-задачу");
      }

      const current=await client.query<{physical_milli:string}>(
        `SELECT physical_milli::text
         FROM warehouse_location_balance
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND location_id=$3 AND sku_id=$4
         FOR UPDATE`,
        [
          context.tenantId,row.warehouse_id,row.location_id,row.sku_id
        ]
      );
      const currentMilli=BigInt(current.rows[0]?.physical_milli??"0");
      const expected=BigInt(row.expected_milli);

      if(currentMilli!==expected){
        throw new ConflictException(
          "Остаток в ячейке изменился после создания пересчёта. Создайте новый count."
        );
      }

      const variance=counted-expected;

      if(variance!==0n){
        await this.inventory.applyWmsCountAdjustment(
          client,
          context,
          {
            warehouseId:row.warehouse_id,
            skuId:row.sku_id,
            quantityDeltaMilli:variance,
            countId:row.count_id,
            countLineId:row.line_id,
            reason:"WMS cycle count",
            idempotencyKey:"wms-count-adjust:"+row.line_id
          }
        );

        await client.query(
          `UPDATE warehouse_location_balance
           SET physical_milli=$5::bigint,updated_at=now()
           WHERE tenant_id=$1 AND warehouse_id=$2
             AND location_id=$3 AND sku_id=$4`,
          [
            context.tenantId,row.warehouse_id,row.location_id,row.sku_id,
            counted.toString()
          ]
        );

        await client.query(
          `INSERT INTO wms_location_movement(
             tenant_id,warehouse_id,sku_id,movement_type,
             from_location_id,to_location_id,quantity_milli,
             source_type,source_id,source_line_id,
             idempotency_key,actor_membership_id
           ) VALUES (
             $1,$2,$3,'ADJUSTMENT',
             CASE WHEN $4::bigint<0 THEN $5::uuid ELSE NULL END,
             CASE WHEN $4::bigint>0 THEN $5::uuid ELSE NULL END,
             abs($4::bigint),
             'WMS_CYCLE_COUNT',$6,$7,$8,$9
           )
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
          [
            context.tenantId,row.warehouse_id,row.sku_id,
            variance.toString(),row.location_id,row.count_id,row.line_id,
            "count-location-adjust:"+row.line_id,
            context.membershipId
          ]
        );
      }

      await client.query(
        `UPDATE wms_cycle_count_line
         SET counted_milli=$3,
             variance_milli=$4,
             status='POSTED',
             posted_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,row.line_id,
          counted.toString(),variance.toString()
        ]
      );

      await client.query(
        `UPDATE warehouse_task
         SET status='COMPLETED',completed_at=now(),
             result=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,taskId,
          JSON.stringify({
            countedMilli:counted.toString(),
            varianceMilli:variance.toString(),
            completedBy:context.membershipId
          })
        ]
      );

      const open=await client.query(
        `SELECT 1
         FROM wms_cycle_count_line
         WHERE tenant_id=$1 AND count_id=$2 AND status='OPEN'
         LIMIT 1`,
        [context.tenantId,row.count_id]
      );

      const countCompleted=!open.rowCount;
      if(countCompleted){
        await client.query(
          `UPDATE wms_cycle_count
           SET status='POSTED',posted_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='OPEN'`,
          [context.tenantId,row.count_id]
        );
      }

      await this.assertLocationReconciliation(
        client,context.tenantId,row.warehouse_id
      );

      return {
        varianceMilli:variance.toString(),
        countCompleted
      };
    });
  }

  async planReplenishment(
    context:TenantContext,
    warehouseId:string
  ):Promise<{
    tasks:number;
    shortages:Array<{skuId:string;targetLocationId:string;missingMilli:string}>;
  }>{
    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query<{stock_tracking_state:string}>(
        `SELECT stock_tracking_state
         FROM warehouse_wms_profile
         WHERE tenant_id=$1 AND warehouse_id=$2 AND status='ACTIVE'`,
        [context.tenantId,warehouseId]
      );
      if(profile.rows[0]?.stock_tracking_state!=="LOCATION_LEDGER"){
        throw new BadRequestException("Replenishment требует активный ячеечный учёт");
      }

      const targets=await client.query<{
        sku_id:string;
        location_id:string;
        min_quantity_milli:string;
        max_quantity_milli:string|null;
        current_milli:string;
      }>(
        `SELECT
           r.sku_id,r.location_id,
           r.min_quantity_milli::text,
           r.max_quantity_milli::text,
           COALESCE(b.physical_milli,0)::text AS current_milli
         FROM warehouse_location_sku_rule r
         JOIN warehouse_location l
           ON l.tenant_id=r.tenant_id AND l.id=r.location_id
         LEFT JOIN warehouse_location_balance b
           ON b.tenant_id=r.tenant_id
          AND b.warehouse_id=r.warehouse_id
          AND b.location_id=r.location_id
          AND b.sku_id=r.sku_id
         WHERE r.tenant_id=$1
           AND r.warehouse_id=$2
           AND r.rule_type='FIXED_PICK'
           AND r.location_id IS NOT NULL
           AND r.min_quantity_milli IS NOT NULL
           AND l.status='ACTIVE'
           AND COALESCE(b.physical_milli,0)<r.min_quantity_milli
           AND NOT EXISTS (
             SELECT 1 FROM warehouse_task t
             WHERE t.tenant_id=r.tenant_id
               AND t.warehouse_id=r.warehouse_id
               AND t.task_type='REPLENISH'
               AND t.sku_id=r.sku_id
               AND t.to_location_id=r.location_id
               AND t.status IN ('OPEN','CLAIMED')
           )
         ORDER BY r.priority,l.pick_sequence,r.sku_id`,
        [context.tenantId,warehouseId]
      );

      let tasks=0;
      const shortages:Array<{
        skuId:string;
        targetLocationId:string;
        missingMilli:string;
      }>=[];

      for(const target of targets.rows){
        const current=BigInt(target.current_milli);
        const desired=BigInt(
          target.max_quantity_milli??target.min_quantity_milli
        );
        let need=desired-current;
        if(need<=0n) continue;

        const sources=await client.query<{
          location_id:string;
          physical_milli:string;
          planned_milli:string;
        }>(
          `SELECT
             b.location_id,b.physical_milli::text,
             COALESCE((
               SELECT sum(t.quantity_milli)
               FROM warehouse_task t
               WHERE t.tenant_id=b.tenant_id
                 AND t.warehouse_id=b.warehouse_id
                 AND t.task_type='REPLENISH'
                 AND t.sku_id=b.sku_id
                 AND t.from_location_id=b.location_id
                 AND t.status IN ('OPEN','CLAIMED')
             ),0)::text AS planned_milli
           FROM warehouse_location_balance b
           JOIN warehouse_location l
             ON l.tenant_id=b.tenant_id AND l.id=b.location_id
           JOIN warehouse_zone z
             ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
           WHERE b.tenant_id=$1
             AND b.warehouse_id=$2
             AND b.sku_id=$3
             AND b.location_id<>$4
             AND b.physical_milli>0
             AND l.status='ACTIVE'
             AND l.is_system=false
             AND z.status='ACTIVE'
             AND z.zone_type='STORAGE'
           ORDER BY z.priority,l.pick_sequence,l.full_code
           FOR UPDATE OF b`,
          [
            context.tenantId,warehouseId,
            target.sku_id,target.location_id
          ]
        );

        let sequence=0;
        for(const source of sources.rows){
          if(need<=0n) break;
          const available=
            BigInt(source.physical_milli)-BigInt(source.planned_milli);
          if(available<=0n) continue;

          const quantity=available<need?available:need;
          const key=
            "replenish:"+warehouseId+":"+
            target.location_id+":"+target.sku_id+":"+
            source.location_id+":"+
            current.toString()+":"+
            desired.toString()+":"+
            sequence.toString();

          await client.query(
            `INSERT INTO warehouse_task(
               tenant_id,warehouse_id,task_type,status,priority,
               sku_id,quantity_milli,from_location_id,to_location_id,
               source_type,source_id,idempotency_key,instructions
             ) VALUES (
               $1,$2,'REPLENISH','OPEN',60,
               $3,$4,$5,$6,
               'FIXED_PICK_RULE',$6,$7,$8
             )`,
            [
              context.tenantId,warehouseId,target.sku_id,
              quantity.toString(),source.location_id,target.location_id,
              key,
              JSON.stringify({
                minMilli:target.min_quantity_milli,
                maxMilli:target.max_quantity_milli,
                plannedMilli:quantity.toString()
              })
            ]
          );

          tasks+=1;
          sequence+=1;
          need-=quantity;
        }

        if(need>0n){
          shortages.push({
            skuId:target.sku_id,
            targetLocationId:target.location_id,
            missingMilli:need.toString()
          });
        }
      }

      return {tasks,shortages};
    });
  }

  async completeReplenishment(
    context:TenantContext,
    taskId:string
  ):Promise<void>{
    await this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        status:string;
        warehouse_id:string;
        sku_id:string;
        quantity_milli:string;
        from_location_id:string;
        to_location_id:string;
        claimed_by_membership_id:string|null;
      }>(
        `SELECT
           status,warehouse_id,sku_id,quantity_milli::text,
           from_location_id,to_location_id,claimed_by_membership_id
         FROM warehouse_task
         WHERE tenant_id=$1 AND id=$2 AND task_type='REPLENISH'
         FOR UPDATE`,
        [context.tenantId,taskId]
      );
      const row=task.rows[0];
      if(!row) throw new NotFoundException("REPLENISH-задача не найдена");
      if(row.status==="COMPLETED") return;
      if(
        row.status!=="CLAIMED" ||
        row.claimed_by_membership_id!==context.membershipId
      ){
        throw new ConflictException("Сначала возьмите REPLENISH-задачу");
      }

      const target=await client.query<{status:string}>(
        `SELECT status
         FROM warehouse_location
         WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3
         FOR UPDATE`,
        [context.tenantId,row.warehouse_id,row.to_location_id]
      );
      if(target.rows[0]?.status!=="ACTIVE"){
        throw new ConflictException("Целевая pick-ячейка недоступна");
      }

      const source=await client.query<{physical_milli:string}>(
        `SELECT physical_milli::text
         FROM warehouse_location_balance
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND location_id=$3 AND sku_id=$4
         FOR UPDATE`,
        [
          context.tenantId,row.warehouse_id,
          row.from_location_id,row.sku_id
        ]
      );
      const quantity=BigInt(row.quantity_milli);
      if(BigInt(source.rows[0]?.physical_milli??"0")<quantity){
        throw new ConflictException("В STORAGE ячейке недостаточно товара");
      }

      await client.query(
        `UPDATE warehouse_location_balance
         SET physical_milli=physical_milli-$5::bigint,updated_at=now()
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND location_id=$3 AND sku_id=$4`,
        [
          context.tenantId,row.warehouse_id,
          row.from_location_id,row.sku_id,quantity.toString()
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
          context.tenantId,row.warehouse_id,
          row.to_location_id,row.sku_id,quantity.toString()
        ]
      );

      await client.query(
        `INSERT INTO wms_location_movement(
           tenant_id,warehouse_id,sku_id,movement_type,
           from_location_id,to_location_id,quantity_milli,
           source_type,source_id,idempotency_key,actor_membership_id
         ) VALUES (
           $1,$2,$3,'MOVE',$4,$5,$6,
           'WAREHOUSE_TASK',$7,$8,$9
         )
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
        [
          context.tenantId,row.warehouse_id,row.sku_id,
          row.from_location_id,row.to_location_id,quantity.toString(),
          taskId,"replenish-task:"+taskId,context.membershipId
        ]
      );

      await client.query(
        `UPDATE warehouse_task
         SET status='COMPLETED',completed_at=now(),
             result=$3,updated_at=now()
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

  async nextMobileTask(
    context:TenantContext,
    warehouseId:string
  ):Promise<Record<string,unknown>|null>{
    return this.database.withTenantTransaction(context,async client=>{
      const profile=await client.query(
        `SELECT 1
         FROM warehouse_wms_profile
         WHERE tenant_id=$1 AND warehouse_id=$2
           AND status='ACTIVE'
           AND stock_tracking_state='LOCATION_LEDGER'`,
        [context.tenantId,warehouseId]
      );
      if(!profile.rowCount){
        throw new BadRequestException("Мобильный WMS доступен только для активного ячеечного склада");
      }

      let task=await client.query<{id:string}>(
        `SELECT id
         FROM warehouse_task
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND status='CLAIMED'
           AND claimed_by_membership_id=$3
         ORDER BY priority,claimed_at,created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [context.tenantId,warehouseId,context.membershipId]
      );

      if(!task.rows[0]){
        task=await client.query<{id:string}>(
          `SELECT t.id
           FROM warehouse_task t
           LEFT JOIN wms_wave w
             ON w.tenant_id=t.tenant_id AND w.id=t.wave_id
           WHERE t.tenant_id=$1
             AND t.warehouse_id=$2
             AND t.status='OPEN'
             AND (
               t.wave_id IS NULL OR
               w.status IN ('RELEASED','IN_PROGRESS')
             )
           ORDER BY
             CASE WHEN t.wave_id IS NOT NULL THEN 0 ELSE 1 END,
             COALESCE(w.priority,t.priority),
             t.priority,
             t.created_at
           LIMIT 1
           FOR UPDATE OF t SKIP LOCKED`,
          [context.tenantId,warehouseId]
        );

        if(task.rows[0]){
          await client.query(
            `UPDATE warehouse_task
             SET status='CLAIMED',
                 claimed_by_membership_id=$3,
                 claimed_at=COALESCE(claimed_at,now()),
                 updated_at=now()
             WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId,task.rows[0].id,context.membershipId]
          );

          await client.query(
            `UPDATE wms_wave w
             SET status='IN_PROGRESS'
             FROM warehouse_task t
             WHERE t.tenant_id=$1
               AND t.id=$2
               AND t.wave_id=w.id
               AND w.tenant_id=t.tenant_id
               AND w.status='RELEASED'`,
            [context.tenantId,task.rows[0].id]
          );
        }
      }

      const taskId=task.rows[0]?.id;
      if(!taskId) return null;

      const detail=await client.query<{
        id:string;
        task_type:string;
        status:string;
        priority:number;
        sku_id:string|null;
        sku_code:string|null;
        barcode:string|null;
        product_name:string|null;
        quantity_milli:string|null;
        from_code:string|null;
        from_short_code:string|null;
        to_code:string|null;
        to_short_code:string|null;
        wave_id:string|null;
        cluster_slot:string|null;
        order_number:string|null;
        instructions:Record<string,unknown>;
      }>(
        `SELECT
           t.id,t.task_type,t.status,t.priority,t.sku_id,
           s.code AS sku_code,s.barcode,
           p.name AS product_name,
           t.quantity_milli::text,
           fl.full_code AS from_code,fl.code AS from_short_code,
           tl.full_code AS to_code,tl.code AS to_short_code,
           t.wave_id,t.cluster_slot,
           CASE
             WHEN t.task_type IN ('PACK','SHIP') THEN so.business_number
             ELSE NULL
           END AS order_number,
           t.instructions
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
         LEFT JOIN sales_order so
           ON so.tenant_id=t.tenant_id
          AND so.id=t.source_id
          AND t.task_type IN ('PACK','SHIP')
         WHERE t.tenant_id=$1 AND t.id=$2`,
        [context.tenantId,taskId]
      );

      const row=detail.rows[0];
      if(!row) return null;

      const scans=await client.query<{scan_kind:string}>(
        `SELECT DISTINCT scan_kind
         FROM wms_task_scan
         WHERE tenant_id=$1 AND task_id=$2 AND verified=true`,
        [context.tenantId,taskId]
      );

      return {
        ...row,
        verifiedScans:scans.rows.map(scan=>scan.scan_kind)
      };
    });
  }

  async scanMobileTask(
    context:TenantContext,
    taskId:string,
    input:{
      kind:"FROM_LOCATION"|"SKU"|"TO_LOCATION"|"ORDER";
      value:string;
      idempotencyKey:string;
    }
  ):Promise<{verified:true;kind:string}>{
    const kind=String(input.kind??"").toUpperCase();
    if(!["FROM_LOCATION","SKU","TO_LOCATION","ORDER"].includes(kind)){
      throw new BadRequestException("Неизвестный тип скана");
    }
    const value=String(input.value??"").trim();
    if(!value||value.length>200){
      throw new BadRequestException("Некорректное значение сканера");
    }
    if(!input.idempotencyKey?.trim()||input.idempotencyKey.length>180){
      throw new BadRequestException("Требуется idempotencyKey скана");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const task=await client.query<{
        status:string;
        claimed_by_membership_id:string|null;
        sku_code:string|null;
        barcode:string|null;
        from_code:string|null;
        from_short_code:string|null;
        to_code:string|null;
        to_short_code:string|null;
        source_id:string|null;
        order_number:string|null;
      }>(
        `SELECT
           t.status,t.claimed_by_membership_id,
           s.code AS sku_code,s.barcode,
           fl.full_code AS from_code,fl.code AS from_short_code,
           tl.full_code AS to_code,tl.code AS to_short_code,
           t.source_id,
           CASE
             WHEN t.task_type IN ('PACK','SHIP') THEN so.business_number
             ELSE NULL
           END AS order_number
         FROM warehouse_task t
         LEFT JOIN sku s
           ON s.tenant_id=t.tenant_id AND s.id=t.sku_id
         LEFT JOIN warehouse_location fl
           ON fl.tenant_id=t.tenant_id AND fl.id=t.from_location_id
         LEFT JOIN warehouse_location tl
           ON tl.tenant_id=t.tenant_id AND tl.id=t.to_location_id
         LEFT JOIN sales_order so
           ON so.tenant_id=t.tenant_id
          AND so.id=t.source_id
          AND t.task_type IN ('PACK','SHIP')
         WHERE t.tenant_id=$1 AND t.id=$2
         FOR UPDATE OF t`,
        [context.tenantId,taskId]
      );
      const row=task.rows[0];
      if(!row) throw new NotFoundException("WMS-задача не найдена");
      if(
        row.status!=="CLAIMED" ||
        row.claimed_by_membership_id!==context.membershipId
      ){
        throw new ConflictException("Задача не находится у текущего сотрудника");
      }

      const normalized=value.toUpperCase();
      let expectedValues:string[]=[];

      if(kind==="FROM_LOCATION"){
        expectedValues=[row.from_code,row.from_short_code]
          .filter(Boolean)
          .map(item=>String(item).toUpperCase());
      }else if(kind==="TO_LOCATION"){
        expectedValues=[row.to_code,row.to_short_code]
          .filter(Boolean)
          .map(item=>String(item).toUpperCase());
      }else if(kind==="SKU"){
        expectedValues=[row.sku_code,row.barcode]
          .filter(Boolean)
          .map(item=>String(item).toUpperCase());
      }else{
        expectedValues=[row.order_number,row.source_id]
          .filter(Boolean)
          .map(item=>String(item).toUpperCase());
      }

      if(!expectedValues.length||!expectedValues.includes(normalized)){
        throw new ConflictException(
          kind==="SKU"
            ? "Отсканирован другой SKU/штрихкод"
            : kind==="ORDER"
              ? "Отсканирован другой заказ"
              : "Отсканирована другая складская ячейка"
        );
      }

      await client.query(
        `INSERT INTO wms_task_scan(
           tenant_id,task_id,scan_kind,scanned_value,matched_value,verified,
           idempotency_key,actor_membership_id
         ) VALUES ($1,$2,$3,$4,$5,true,$6,$7)
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
        [
          context.tenantId,taskId,kind,value,expectedValues[0]!,
          input.idempotencyKey.trim(),context.membershipId
        ]
      );

      return {verified:true,kind};
    });
  }

  async reportMobileTaskProblem(
    context:TenantContext,
    taskId:string,
    input:{
      exceptionType:
        |"STOCK_MISMATCH"
        |"LOCATION_BLOCKED"
        |"BARCODE_MISMATCH"
        |"DAMAGE"
        |"EQUIPMENT"
        |"OTHER";
      message?:string;
    }
  ):Promise<{blocked:true;exceptionId:string}>{
    const type=String(input.exceptionType??"").toUpperCase();
    if(![
      "STOCK_MISMATCH","LOCATION_BLOCKED","BARCODE_MISMATCH",
      "DAMAGE","EQUIPMENT","OTHER"
    ].includes(type)){
      throw new BadRequestException("Неизвестный тип проблемы");
    }

    const message=String(input.message??"").trim().slice(0,2000);

    return this.database.withTenantTransaction(context,async client=>{
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
      if(!row) throw new NotFoundException("WMS-задача не найдена");
      if(
        row.status!=="CLAIMED" ||
        row.claimed_by_membership_id!==context.membershipId
      ){
        throw new ConflictException("Блокировать можно только свою активную задачу");
      }

      const exception=await client.query<{id:string}>(
        `INSERT INTO wms_task_exception(
           tenant_id,task_id,exception_type,message,reported_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [
          context.tenantId,taskId,type,message||null,context.membershipId
        ]
      );

      await client.query(
        `UPDATE warehouse_task
         SET status='BLOCKED',
             last_error=$3,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,taskId,
          (type+(message?": "+message:"")).slice(0,2000)
        ]
      );

      return {
        blocked:true,
        exceptionId:exception.rows[0]!.id
      };
    });
  }

  async completeMobileTask(
    context:TenantContext,
    taskId:string,
    input?:{
      countedMilli?:string;
    }
  ):Promise<Record<string,unknown>>{
    const task=await this.database.withTenantTransaction(
      context,
      async client=>{
        const result=await client.query<{
          task_type:string;
          status:string;
          claimed_by_membership_id:string|null;
          from_location_id:string|null;
          to_location_id:string|null;
          sku_id:string|null;
        }>(
          `SELECT
             task_type,status,claimed_by_membership_id,
             from_location_id,to_location_id,sku_id
           FROM warehouse_task
           WHERE tenant_id=$1 AND id=$2
           FOR UPDATE`,
          [context.tenantId,taskId]
        );
        const row=result.rows[0];
        if(!row) throw new NotFoundException("WMS-задача не найдена");
        if(row.status==="COMPLETED"){
          return {...row,already:true};
        }
        if(
          row.status!=="CLAIMED" ||
          row.claimed_by_membership_id!==context.membershipId
        ){
          throw new ConflictException(
            "Задача не находится у текущего сотрудника"
          );
        }

        const required:string[]=[];
        if(row.from_location_id) required.push("FROM_LOCATION");
        if(row.sku_id) required.push("SKU");
        if(row.to_location_id) required.push("TO_LOCATION");

        const scanRequired=
          ["PUTAWAY","PICK","REPLENISH","COUNT"].includes(row.task_type)
            ? [...required]
            : ["PACK","SHIP"].includes(row.task_type)
              ? ["ORDER"]
              : [];

        if(row.task_type==="COUNT"){
          const index=scanRequired.indexOf("TO_LOCATION");
          if(index>=0) scanRequired.splice(index,1);
        }

        if(scanRequired.length){
          const scans=await client.query<{scan_kind:string}>(
            `SELECT DISTINCT scan_kind
             FROM wms_task_scan
             WHERE tenant_id=$1
               AND task_id=$2
               AND verified=true`,
            [context.tenantId,taskId]
          );
          const verified=new Set(scans.rows.map(item=>item.scan_kind));
          const missing=scanRequired.filter(kind=>!verified.has(kind));
          if(missing.length){
            throw new ConflictException(
              "TASK_CONFLICT: не подтверждены сканы " + missing.join(", ")
            );
          }
        }

        return {...row,already:false};
      }
    );

    if(task.already){
      return {completed:true,taskId,reused:true};
    }

    switch(task.task_type){
      case "PUTAWAY":
        await this.completePutaway(context,taskId);
        break;
      case "PICK":
        await this.completePick(context,taskId);
        break;
      case "PACK":
        await this.completePack(context,taskId);
        break;
      case "SHIP":
        await this.completeShip(context,taskId);
        break;
      case "REPLENISH":
        await this.completeReplenishment(context,taskId);
        break;
      case "COUNT":
        if(!input?.countedMilli){
          throw new BadRequestException(
            "Для COUNT требуется фактическое количество"
          );
        }
        await this.completeCycleCountTask(
          context,taskId,input.countedMilli
        );
        break;
      default:
        throw new BadRequestException(
          "Этот тип задачи пока не поддерживает мобильное завершение"
        );
    }

    return {completed:true,taskId};
  }

  async dispatcher(
    context:TenantContext,
    warehouseId:string
  ):Promise<Record<string,unknown>>{
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertProfile(client,context.tenantId,warehouseId);

      const backlog=await client.query(
        `SELECT
           count(*) FILTER (WHERE status='OPEN')::int AS open,
           count(*) FILTER (WHERE status='CLAIMED')::int AS claimed,
           count(*) FILTER (
             WHERE task_type='PICK'
               AND status='OPEN'
               AND wave_id IS NULL
           )::int AS unplanned_pick,
           min(created_at) FILTER (WHERE status='OPEN') AS oldest_open_at
         FROM warehouse_task
         WHERE tenant_id=$1 AND warehouse_id=$2`,
        [context.tenantId,warehouseId]
      );

      const waves=await client.query(
        `SELECT
           w.id,w.strategy,w.status,w.priority,w.max_tasks,
           w.created_at,w.released_at,w.completed_at,
           count(t.id)::int AS tasks,
           count(t.id) FILTER (WHERE t.status='OPEN')::int AS open_tasks,
           count(t.id) FILTER (WHERE t.status='CLAIMED')::int AS claimed_tasks,
           count(t.id) FILTER (WHERE t.status='COMPLETED')::int AS completed_tasks,
           count(t.id) FILTER (WHERE t.status='FAILED')::int AS failed_tasks,
           CASE
             WHEN count(t.id)=0 THEN 0
             ELSE round(
               100.0*count(t.id) FILTER (WHERE t.status='COMPLETED')/
               count(t.id),
               1
             )
           END AS progress_percent
         FROM wms_wave w
         LEFT JOIN warehouse_task t
           ON t.tenant_id=w.tenant_id AND t.wave_id=w.id
         WHERE w.tenant_id=$1
           AND w.warehouse_id=$2
           AND w.status IN ('DRAFT','RELEASED','IN_PROGRESS')
         GROUP BY w.id
         ORDER BY w.priority,w.created_at`,
        [context.tenantId,warehouseId]
      );

      const taskFlow=await client.query(
        `SELECT task_type,status,count(*)::int AS count
         FROM warehouse_task
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND status IN ('OPEN','CLAIMED','BLOCKED','FAILED')
         GROUP BY task_type,status
         ORDER BY task_type,status`,
        [context.tenantId,warehouseId]
      );

      const exceptions=await client.query(
        `SELECT
           e.id AS exception_id,
           t.id,
           t.task_type,t.status,t.last_error,t.cluster_slot,
           e.exception_type,e.message,e.reported_at,
           s.code AS sku_code,
           fl.full_code AS from_code,
           tl.full_code AS to_code
         FROM warehouse_task t
         LEFT JOIN wms_task_exception e
           ON e.tenant_id=t.tenant_id
          AND e.task_id=t.id
          AND e.status='OPEN'
         LEFT JOIN sku s
           ON s.tenant_id=t.tenant_id AND s.id=t.sku_id
         LEFT JOIN warehouse_location fl
           ON fl.tenant_id=t.tenant_id AND fl.id=t.from_location_id
         LEFT JOIN warehouse_location tl
           ON tl.tenant_id=t.tenant_id AND tl.id=t.to_location_id
         WHERE t.tenant_id=$1
           AND t.warehouse_id=$2
           AND (
             t.status IN ('BLOCKED','FAILED')
             OR (
               t.status='CLAIMED'
               AND t.claimed_at<now()-interval '60 minutes'
             )
           )
         ORDER BY
           CASE t.status WHEN 'BLOCKED' THEN 0 WHEN 'FAILED' THEN 1 ELSE 2 END,
           COALESCE(e.reported_at,t.claimed_at,t.created_at)
         LIMIT 100`,
        [context.tenantId,warehouseId]
      );

      return {
        warehouseId,
        backlog:backlog.rows[0]??{
          open:0,
          claimed:0,
          unplanned_pick:0,
          oldest_open_at:null
        },
        waves:waves.rows,
        taskFlow:taskFlow.rows,
        exceptions:exceptions.rows
      };
    });
  }

  async exceptions(
    context:TenantContext,
    warehouseId:string
  ):Promise<Array<Record<string,unknown>>>{
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertProfile(client,context.tenantId,warehouseId);

      const result=await client.query(
        `SELECT
           e.id,e.task_id,e.exception_type,e.message,e.status,
           e.reported_at,e.resolved_at,
           t.task_type,t.status AS task_status,t.last_error,
           t.wave_id,t.cluster_slot,
           s.code AS sku_code,p.name AS product_name,
           fl.full_code AS from_code,tl.full_code AS to_code
         FROM wms_task_exception e
         JOIN warehouse_task t
           ON t.tenant_id=e.tenant_id AND t.id=e.task_id
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
         WHERE e.tenant_id=$1
           AND t.warehouse_id=$2
         ORDER BY
           CASE e.status WHEN 'OPEN' THEN 0 ELSE 1 END,
           e.reported_at DESC
         LIMIT 200`,
        [context.tenantId,warehouseId]
      );
      return result.rows;
    });
  }

  async resolveException(
    context:TenantContext,
    exceptionId:string,
    input:{action:"REQUEUE"|"CANCEL"}
  ):Promise<{taskId:string;taskStatus:"OPEN"|"CANCELLED"}>{
    const action=String(input.action??"").toUpperCase();
    if(!["REQUEUE","CANCEL"].includes(action)){
      throw new BadRequestException("Неизвестное действие диспетчера");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const exception=await client.query<{
        task_id:string;
        exception_status:string;
        task_status:string;
        task_type:string;
      }>(
        `SELECT
           e.task_id,e.status AS exception_status,
           t.status AS task_status,t.task_type
         FROM wms_task_exception e
         JOIN warehouse_task t
           ON t.tenant_id=e.tenant_id AND t.id=e.task_id
         WHERE e.tenant_id=$1 AND e.id=$2
         FOR UPDATE OF e,t`,
        [context.tenantId,exceptionId]
      );
      const row=exception.rows[0];
      if(!row) throw new NotFoundException("Исключение WMS не найдено");

      if(row.exception_status!=="OPEN"){
        throw new ConflictException("Исключение уже закрыто");
      }
      if(!["BLOCKED","FAILED"].includes(row.task_status)){
        throw new ConflictException(
          "Задача уже не находится в состоянии исключения"
        );
      }

      if(action==="CANCEL"){
        if(["PICK","PACK","SHIP"].includes(row.task_type)){
          throw new ConflictException(
            "Outbound-задачу нельзя отменить из диспетчера: верните её в очередь или отмените бизнес-процесс заказа"
          );
        }

        await client.query(
          `UPDATE warehouse_task
           SET status='CANCELLED',
               claimed_by_membership_id=NULL,
               claimed_at=NULL,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.task_id]
        );
      }else{
        await client.query(
          `UPDATE warehouse_task
           SET status='OPEN',
               claimed_by_membership_id=NULL,
               claimed_at=NULL,
               last_error=NULL,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.task_id]
        );
      }

      await client.query(
        `UPDATE wms_task_exception
         SET status='RESOLVED',
             resolved_at=now(),
             resolved_by_membership_id=$3
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,exceptionId,context.membershipId]
      );

      await this.audit(
        client,context,"wms.exception_resolved","warehouse_task",row.task_id,{
          exceptionId,
          action
        }
      );

      return {
        taskId:row.task_id,
        taskStatus:action==="REQUEUE"?"OPEN":"CANCELLED"
      };
    });
  }

  async laborMetrics(
    context:TenantContext,
    warehouseId:string,
    hoursInput=24
  ):Promise<Record<string,unknown>>{
    const hours=this.integer(hoursInput,1,168,"Окно labor metrics");

    return this.database.withTenantTransaction(context,async client=>{
      await this.assertProfile(client,context.tenantId,warehouseId);

      const summary=await client.query(
        `SELECT
           count(*) FILTER (
             WHERE status='COMPLETED'
               AND completed_at>=now()-($3::text||' hours')::interval
           )::int AS completed,
           count(*) FILTER (WHERE status='CLAIMED')::int AS active_tasks,
           count(DISTINCT claimed_by_membership_id) FILTER (
             WHERE status='CLAIMED'
           )::int AS active_operators,
           round(
             count(*) FILTER (
               WHERE status='COMPLETED'
                 AND completed_at>=now()-($3::text||' hours')::interval
             )::numeric / $3::numeric,
             2
           ) AS tasks_per_hour,
           round(
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM (completed_at-claimed_at))/60.0
             ) FILTER (
               WHERE status='COMPLETED'
                 AND claimed_at IS NOT NULL
                 AND completed_at IS NOT NULL
                 AND completed_at>=now()-($3::text||' hours')::interval
             )::numeric,
             1
           ) AS median_cycle_minutes
         FROM warehouse_task
         WHERE tenant_id=$1 AND warehouse_id=$2`,
        [context.tenantId,warehouseId,hours]
      );

      const operators=await client.query(
        `SELECT
           m.id AS membership_id,
           u.email,
           count(t.id) FILTER (
             WHERE t.status='COMPLETED'
               AND t.completed_at>=now()-($3::text||' hours')::interval
           )::int AS completed,
           count(t.id) FILTER (WHERE t.status='CLAIMED')::int AS active,
           round(
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM (t.completed_at-t.claimed_at))/60.0
             ) FILTER (
               WHERE t.status='COMPLETED'
                 AND t.claimed_at IS NOT NULL
                 AND t.completed_at IS NOT NULL
                 AND t.completed_at>=now()-($3::text||' hours')::interval
             )::numeric,
             1
           ) AS median_cycle_minutes,
           max(t.completed_at) AS last_completed_at
         FROM tenant_membership m
         JOIN app_user u ON u.id=m.user_id
         LEFT JOIN warehouse_task t
           ON t.tenant_id=m.tenant_id
          AND t.claimed_by_membership_id=m.id
          AND t.warehouse_id=$2
         WHERE m.tenant_id=$1
           AND m.status='ACTIVE'
         GROUP BY m.id,u.email
         HAVING
           count(t.id) FILTER (
             WHERE t.status='COMPLETED'
               AND t.completed_at>=now()-($3::text||' hours')::interval
           )>0
           OR count(t.id) FILTER (WHERE t.status='CLAIMED')>0
         ORDER BY completed DESC,active DESC,u.email
         LIMIT 100`,
        [context.tenantId,warehouseId,hours]
      );

      const throughput=await client.query(
        `SELECT
           task_type,
           count(*)::int AS completed,
           round(
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM (completed_at-claimed_at))/60.0
             ) FILTER (
               WHERE claimed_at IS NOT NULL
             )::numeric,
             1
           ) AS median_cycle_minutes
         FROM warehouse_task
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND status='COMPLETED'
           AND completed_at>=now()-($3::text||' hours')::interval
         GROUP BY task_type
         ORDER BY completed DESC,task_type`,
        [context.tenantId,warehouseId,hours]
      );

      const risk=await client.query(
        `SELECT
           count(*) FILTER (
             WHERE status='OPEN'
               AND created_at>now()-interval '15 minutes'
           )::int AS fresh,
           count(*) FILTER (
             WHERE status='OPEN'
               AND created_at<=now()-interval '15 minutes'
               AND created_at>now()-interval '30 minutes'
           )::int AS watch,
           count(*) FILTER (
             WHERE status='OPEN'
               AND created_at<=now()-interval '30 minutes'
               AND created_at>now()-interval '60 minutes'
           )::int AS risk,
           count(*) FILTER (
             WHERE status='OPEN'
               AND created_at<=now()-interval '60 minutes'
           )::int AS critical,
           count(*) FILTER (
             WHERE status IN ('BLOCKED','FAILED')
           )::int AS exceptions
         FROM warehouse_task
         WHERE tenant_id=$1 AND warehouse_id=$2`,
        [context.tenantId,warehouseId]
      );

      const workload=await client.query(
        `SELECT
           COALESCE(z.name,'Без зоны') AS zone_name,
           t.task_type,
           t.status,
           count(*)::int AS tasks
         FROM warehouse_task t
         LEFT JOIN warehouse_location l
           ON l.tenant_id=t.tenant_id
          AND l.id=COALESCE(t.from_location_id,t.to_location_id)
         LEFT JOIN warehouse_zone z
           ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
         WHERE t.tenant_id=$1
           AND t.warehouse_id=$2
           AND t.status IN ('OPEN','CLAIMED','BLOCKED','FAILED')
         GROUP BY z.name,t.task_type,t.status
         ORDER BY zone_name,t.task_type,t.status`,
        [context.tenantId,warehouseId]
      );

      return {
        warehouseId,
        windowHours:hours,
        summary:summary.rows[0]??{},
        operators:operators.rows,
        throughput:throughput.rows,
        backlogRisk:risk.rows[0]??{},
        workload:workload.rows
      };
    });
  }

  async slottingRecommendations(
    context:TenantContext,
    warehouseId:string,
    daysInput=30
  ):Promise<Array<Record<string,unknown>>>{
    const days=this.integer(daysInput,7,90,"Период slotting");

    return this.database.withTenantTransaction(context,async client=>{
      await this.assertProfile(client,context.tenantId,warehouseId);

      const result=await client.query(
        `WITH velocity AS (
           SELECT
             m.sku_id,
             count(*)::int AS pick_events,
             sum(m.quantity_milli)::bigint AS picked_milli,
             ceil(sum(m.quantity_milli)::numeric / $3::numeric)::bigint
               AS avg_daily_milli
           FROM wms_location_movement m
           WHERE m.tenant_id=$1
             AND m.warehouse_id=$2
             AND m.movement_type='PICK'
             AND m.created_at>=now()-($3::text||' days')::interval
           GROUP BY m.sku_id
         ),
         storage AS (
           SELECT
             b.sku_id,
             sum(b.physical_milli)::bigint AS storage_milli
           FROM warehouse_location_balance b
           JOIN warehouse_location l
             ON l.tenant_id=b.tenant_id AND l.id=b.location_id
           JOIN warehouse_zone z
             ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
           WHERE b.tenant_id=$1
             AND b.warehouse_id=$2
             AND b.physical_milli>0
             AND l.status='ACTIVE'
             AND l.is_system=false
             AND z.status='ACTIVE'
             AND z.zone_type='STORAGE'
           GROUP BY b.sku_id
         )
         SELECT
           v.sku_id,
           s.code AS sku_code,
           p.name AS product_name,
           v.pick_events,
           v.picked_milli::text,
           v.avg_daily_milli::text,
           COALESCE(st.storage_milli,0)::text AS storage_milli,
           r.location_id AS current_pick_location_id,
           current_location.full_code AS current_pick_location_code,
           r.min_quantity_milli::text AS current_min_milli,
           r.max_quantity_milli::text AS current_max_milli,
           suggested.location_id AS suggested_location_id,
           suggested.full_code AS suggested_location_code,
           GREATEST(v.avg_daily_milli,1000)::text AS suggested_min_milli,
           GREATEST(v.avg_daily_milli*3,3000)::text AS suggested_max_milli,
           CASE
             WHEN r.id IS NULL THEN 'CREATE_PICK_FACE'
             WHEN r.min_quantity_milli IS NULL OR r.max_quantity_milli IS NULL
               THEN 'SET_THRESHOLDS'
             WHEN r.min_quantity_milli <
                    GREATEST(v.avg_daily_milli,1000)*0.5
               OR r.max_quantity_milli <
                    GREATEST(v.avg_daily_milli*3,3000)*0.5
               THEN 'INCREASE_CAPACITY'
             WHEN r.min_quantity_milli >
                    GREATEST(v.avg_daily_milli,1000)*2
               AND r.max_quantity_milli >
                    GREATEST(v.avg_daily_milli*3,3000)*2
               THEN 'REDUCE_CAPACITY'
             ELSE 'OK'
           END AS recommendation,
           CASE
             WHEN COALESCE(st.storage_milli,0)=0
               THEN 'Нет запаса в STORAGE'
             WHEN r.id IS NULL
               THEN 'SKU активно отбирается, но не имеет FIXED_PICK'
             ELSE 'Порог рассчитан из средней скорости отбора'
           END AS reason
         FROM velocity v
         JOIN sku s
           ON s.tenant_id=$1 AND s.id=v.sku_id AND s.status='ACTIVE'
         JOIN product_variant pv
           ON pv.tenant_id=s.tenant_id AND pv.id=s.variant_id
         JOIN product p
           ON p.tenant_id=pv.tenant_id AND p.id=pv.product_id
         LEFT JOIN storage st ON st.sku_id=v.sku_id
         LEFT JOIN warehouse_location_sku_rule r
           ON r.tenant_id=$1
          AND r.warehouse_id=$2
          AND r.sku_id=v.sku_id
          AND r.rule_type='FIXED_PICK'
         LEFT JOIN warehouse_location current_location
           ON current_location.tenant_id=r.tenant_id
          AND current_location.id=r.location_id
         LEFT JOIN LATERAL (
           SELECT l.id AS location_id,l.full_code
           FROM warehouse_location l
           JOIN warehouse_zone z
             ON z.tenant_id=l.tenant_id AND z.id=l.zone_id
           WHERE l.tenant_id=$1
             AND l.warehouse_id=$2
             AND l.status='ACTIVE'
             AND l.is_system=false
             AND z.status='ACTIVE'
             AND z.zone_type='PICKING'
             AND (
               l.allow_mixed_sku=true OR
               NOT EXISTS (
                 SELECT 1
                 FROM warehouse_location_balance bx
                 WHERE bx.tenant_id=l.tenant_id
                   AND bx.warehouse_id=l.warehouse_id
                   AND bx.location_id=l.id
                   AND bx.physical_milli>0
                   AND bx.sku_id<>v.sku_id
               )
             )
           ORDER BY
             CASE WHEN l.id=r.location_id THEN 0 ELSE 1 END,
             l.pick_sequence,l.full_code
           LIMIT 1
         ) suggested ON true
         ORDER BY
           CASE
             WHEN r.id IS NULL THEN 0
             ELSE 1
           END,
           v.picked_milli DESC,
           s.code
         LIMIT 100`,
        [context.tenantId,warehouseId,days]
      );

      return result.rows;
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
