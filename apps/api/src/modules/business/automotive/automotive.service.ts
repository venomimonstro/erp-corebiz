import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { InventoryService } from "../inventory/inventory.service";

@Injectable()
export class AutomotiveService {
  constructor(
    private readonly database:DatabaseService,
    private readonly inventory:InventoryService
  ) {}

  async dashboard(context:TenantContext) {
    return this.database.withTenantTransaction(context,async client=>{
      const [orders,donors,parts]=await Promise.all([
        client.query(
          `SELECT
             count(*) FILTER(WHERE status NOT IN ('DELIVERED','CANCELLED'))::integer AS open_orders,
             count(*) FILTER(WHERE status='WAITING_PARTS')::integer AS waiting_parts,
             count(*) FILTER(WHERE promised_at<now() AND status NOT IN ('DELIVERED','CANCELLED'))::integer AS overdue,
             coalesce(sum(actual_total_minor) FILTER(WHERE status='DELIVERED'),0)::text AS delivered_revenue_minor
           FROM automotive_work_order WHERE tenant_id=$1`,
          [context.tenantId]
        ),
        client.query(
          `SELECT
             count(*) FILTER(WHERE status IN ('RECEIVED','DISMANTLING'))::integer AS active_donors,
             coalesce(sum(purchase_price_minor+dismantling_cost_minor),0)::text AS invested_minor
           FROM automotive_donor_vehicle WHERE tenant_id=$1 AND status<>'ARCHIVED'`,
          [context.tenantId]
        ),
        client.query(
          `SELECT
             count(*) FILTER(WHERE status='AVAILABLE')::integer AS available_parts,
             count(*) FILTER(WHERE status='RESERVED')::integer AS reserved_parts,
             coalesce(sum(allocated_cost_minor) FILTER(WHERE status IN ('AVAILABLE','RESERVED')),0)::text AS stock_cost_minor,
             coalesce(sum(asking_price_minor) FILTER(WHERE status IN ('AVAILABLE','RESERVED')),0)::text AS stock_asking_minor
           FROM automotive_dismantled_part WHERE tenant_id=$1`,
          [context.tenantId]
        )
      ]);
      return {
        orders:orders.rows[0]??{},
        donors:donors.rows[0]??{},
        parts:parts.rows[0]??{}
      };
    });
  }

  async vehicles(context:TenantContext,search?:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           v.*,p.display_name AS owner_name,
           (
             SELECT max(o.created_at)
             FROM automotive_work_order o
             WHERE o.tenant_id=v.tenant_id AND o.vehicle_id=v.id
           ) AS last_visit_at
         FROM automotive_vehicle v
         LEFT JOIN party p
           ON p.tenant_id=v.tenant_id AND p.id=v.party_id
         WHERE v.tenant_id=$1 AND v.status<>'ARCHIVED'
           AND (
             $2::text IS NULL
             OR v.vin ILIKE '%'||$2||'%'
             OR v.plate_number ILIKE '%'||$2||'%'
             OR v.make ILIKE '%'||$2||'%'
             OR v.model ILIKE '%'||$2||'%'
             OR p.display_name ILIKE '%'||$2||'%'
           )
         ORDER BY v.updated_at DESC
         LIMIT 500`,
        [context.tenantId,search?.trim()||null]
      );
      return result.rows;
    });
  }

  async createVehicle(context:TenantContext,input:any) {
    const make=String(input.make??"").trim();
    const model=String(input.model??"").trim();
    const vin=String(input.vin??"").trim().toUpperCase()||null;
    if(!make||!model) throw new BadRequestException("Укажите марку и модель");
    if(vin&&!/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) {
      throw new BadRequestException("Некорректный VIN");
    }
    return this.database.withTenantTransaction(context,async client=>{
      if(input.partyId){
        const party=await client.query(
          "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
          [context.tenantId,input.partyId]
        );
        if(!party.rowCount) throw new NotFoundException("Клиент не найден");
      }
      const result=await client.query(
        `INSERT INTO automotive_vehicle(
           tenant_id,party_id,vin,plate_number,make,model,generation,
           production_year,engine_code,engine_volume_cc,fuel_type,
           transmission,drivetrain,mileage_km,metadata
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
         ) RETURNING *`,
        [
          context.tenantId,input.partyId??null,vin,
          String(input.plateNumber??"").trim().toUpperCase()||null,
          make,model,String(input.generation??"").trim()||null,
          input.productionYear??null,String(input.engineCode??"").trim()||null,
          input.engineVolumeCc??null,String(input.fuelType??"").trim()||null,
          String(input.transmission??"").trim()||null,
          String(input.drivetrain??"").trim()||null,input.mileageKm??null,
          JSON.stringify(input.metadata??{})
        ]
      );
      return result.rows[0];
    });
  }

  async workOrders(context:TenantContext) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           o.*,v.vin,v.plate_number,v.make,v.model,p.display_name AS customer_name,
           coalesce((
             SELECT count(*) FROM automotive_work_order_line l
             WHERE l.tenant_id=o.tenant_id AND l.work_order_id=o.id
           ),0)::integer AS line_count
         FROM automotive_work_order o
         JOIN automotive_vehicle v
           ON v.tenant_id=o.tenant_id AND v.id=o.vehicle_id
         LEFT JOIN party p
           ON p.tenant_id=o.tenant_id AND p.id=o.party_id
         WHERE o.tenant_id=$1
         ORDER BY
           CASE WHEN o.status IN ('DELIVERED','CANCELLED') THEN 1 ELSE 0 END,
           o.promised_at NULLS LAST,o.created_at DESC
         LIMIT 500`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createWorkOrder(context:TenantContext,input:any) {
    if(!input.vehicleId) throw new BadRequestException("Выберите автомобиль");
    if(input.authorizationLimitMinor!==undefined&&input.authorizationLimitMinor!==null){
      const value=String(input.authorizationLimitMinor);
      if(!/^\\d{1,15}$/.test(value)||BigInt(value)<=0n)
        throw new BadRequestException("Согласованный лимит должен быть положительной суммой в копейках");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const vehicle=await client.query<{party_id:string|null}>(
        "SELECT party_id FROM automotive_vehicle WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE",
        [context.tenantId,input.vehicleId]
      );
      if(!vehicle.rows[0]) throw new NotFoundException("Автомобиль не найден");
      const number=await this.nextNumber(client,context.tenantId,"automotive_work_order","WO");
      const result=await client.query(
        `INSERT INTO automotive_work_order(
           tenant_id,vehicle_id,party_id,business_number,complaint,
           authorization_limit_minor,mileage_in_km,promised_at,
           created_by_membership_id,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          context.tenantId,input.vehicleId,
          input.partyId??vehicle.rows[0].party_id,number,
          String(input.complaint??"").trim()||null,
          input.authorizationLimitMinor??null,input.mileageInKm??null,
          input.promisedAt??null,context.membershipId,
          JSON.stringify(input.metadata??{})
        ]
      );
      return result.rows[0];
    });
  }

  async addWorkOrderLine(context:TenantContext,workOrderId:string,input:any) {
    const lineType=String(input.lineType??"").toUpperCase();
    if(!["LABOR","PART","MATERIAL","OTHER"].includes(lineType)) {
      throw new BadRequestException("Некорректный тип строки");
    }
    const description=String(input.description??"").trim();
    if(!description) throw new BadRequestException("Укажите работу или деталь");
    const quantity=BigInt(String(input.quantityMilli??"1000"));
    if(quantity<=0n) throw new BadRequestException("Количество должно быть больше нуля");
    return this.database.withTenantTransaction(context,async client=>{
      const order=await client.query(
        `SELECT 1 FROM automotive_work_order
         WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('DELIVERED','CANCELLED')
         FOR UPDATE`,
        [context.tenantId,workOrderId]
      );
      if(!order.rowCount) throw new NotFoundException("Активный заказ-наряд не найден");
      const result=await client.query(
        `INSERT INTO automotive_work_order_line(
           tenant_id,work_order_id,line_type,service_id,sku_id,
           employee_resource_id,description,quantity_milli,
           unit_price_minor,unit_cost_minor,approved,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          context.tenantId,workOrderId,lineType,input.serviceId??null,
          input.skuId??null,input.employeeResourceId??null,description,
          quantity.toString(),input.unitPriceMinor??0,input.unitCostMinor??0,
          Boolean(input.approved),JSON.stringify(input.metadata??{})
        ]
      );
      return result.rows[0];
    });
  }

  async workOrder(context:TenantContext,workOrderId:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const order=await client.query(
        `SELECT
           o.*,v.vin,v.plate_number,v.make,v.model,v.generation,
           v.production_year,v.mileage_km,p.display_name AS customer_name,
           (SELECT coalesce(sum(ceil(l.quantity_milli::numeric * l.unit_price_minor::numeric / 1000)),0)::text
            FROM automotive_work_order_line l WHERE l.tenant_id=o.tenant_id
              AND l.work_order_id=o.id AND l.approved) AS approved_total_minor,
           coalesce((
             SELECT json_agg(json_build_object(
               'id',l.id,'lineType',l.line_type,'description',l.description,
               'quantityMilli',l.quantity_milli::text,
               'unitPriceMinor',l.unit_price_minor::text,
               'unitCostMinor',l.unit_cost_minor::text,
               'approved',l.approved,'completed',l.completed,
               'serviceId',l.service_id,'skuId',l.sku_id,
               'employeeResourceId',l.employee_resource_id
             ) ORDER BY l.created_at,l.id)
             FROM automotive_work_order_line l
             WHERE l.tenant_id=o.tenant_id AND l.work_order_id=o.id
           ),'[]'::json) AS lines
         FROM automotive_work_order o
         JOIN automotive_vehicle v
           ON v.tenant_id=o.tenant_id AND v.id=o.vehicle_id
         LEFT JOIN party p
           ON p.tenant_id=o.tenant_id AND p.id=o.party_id
         WHERE o.tenant_id=$1 AND o.id=$2`,
        [context.tenantId,workOrderId]
      );
      const row=order.rows[0];
      if(!row) throw new NotFoundException("Заказ-наряд не найден");
      return row;
    });
  }

  async updateWorkOrder(
    context:TenantContext,
    workOrderId:string,
    input:{
      status?:string;
      diagnosis?:string;
      complaint?:string;
      promisedAt?:string|null;
      mileageOutKm?:number|null;
    }
  ) {
    const requestedStatus=input.status?.trim().toUpperCase()||null;
    const transitions:Record<string,string[]>={
      DRAFT:["DIAGNOSIS","CANCELLED"],
      DIAGNOSIS:["WAITING_APPROVAL","WAITING_PARTS","IN_PROGRESS","CANCELLED"],
      WAITING_APPROVAL:["WAITING_PARTS","IN_PROGRESS","CANCELLED"],
      WAITING_PARTS:["IN_PROGRESS","CANCELLED"],
      IN_PROGRESS:["QUALITY_CHECK","WAITING_PARTS","CANCELLED"],
      QUALITY_CHECK:["READY","IN_PROGRESS"],
      READY:["DELIVERED","IN_PROGRESS"],
      DELIVERED:[],
      CANCELLED:[]
    };
    if(requestedStatus&&!Object.prototype.hasOwnProperty.call(transitions,requestedStatus)){
      throw new BadRequestException("Некорректный статус заказ-наряда");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const current=await client.query<any>(
        `SELECT o.*,v.mileage_km
         FROM automotive_work_order o
         JOIN automotive_vehicle v
           ON v.tenant_id=o.tenant_id AND v.id=o.vehicle_id
         WHERE o.tenant_id=$1 AND o.id=$2
         FOR UPDATE OF o,v`,
        [context.tenantId,workOrderId]
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException("Заказ-наряд не найден");

      if(
        requestedStatus &&
        requestedStatus!==row.status &&
        !transitions[row.status]?.includes(requestedStatus)
      ){
        throw new BadRequestException(
          "Недоступный переход: "+row.status+" → "+requestedStatus
        );
      }

      if(requestedStatus==="DELIVERED"){
        const unresolved=await client.query<{count:number}>(
          `SELECT count(*)::integer AS count
           FROM automotive_work_order_line
           WHERE tenant_id=$1 AND work_order_id=$2
             AND approved=true AND completed=false`,
          [context.tenantId,workOrderId]
        );
        if((unresolved.rows[0]?.count??0)>0){
          throw new BadRequestException(
            "Нельзя выдать автомобиль: есть подтверждённые, но незавершённые работы или детали"
          );
        }
      }

      const mileageOut=
        input.mileageOutKm===undefined||input.mileageOutKm===null
          ?row.mileage_out_km
          :Math.floor(input.mileageOutKm);
      if(
        mileageOut!==null &&
        (
          mileageOut<0 ||
          (row.mileage_in_km!==null&&mileageOut<row.mileage_in_km)
        )
      ){
        throw new BadRequestException("Пробег при выдаче меньше пробега при приёмке");
      }

      const result=await client.query(
        `UPDATE automotive_work_order
         SET
           status=coalesce($3,status),
           diagnosis=CASE WHEN $4::text IS NULL THEN diagnosis ELSE $4 END,
           complaint=CASE WHEN $5::text IS NULL THEN complaint ELSE $5 END,
           promised_at=CASE
             WHEN $6::boolean THEN $7::timestamptz
             ELSE promised_at
           END,
           mileage_out_km=$8,
           completed_at=CASE
             WHEN coalesce($3,status)='DELIVERED' THEN coalesce(completed_at,now())
             ELSE completed_at
           END,
           updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [
          context.tenantId,workOrderId,requestedStatus,
          input.diagnosis===undefined?null:input.diagnosis.trim(),
          input.complaint===undefined?null:input.complaint.trim(),
          input.promisedAt!==undefined,input.promisedAt??null,mileageOut
        ]
      );

      if(requestedStatus==="DELIVERED"&&mileageOut!==null){
        await client.query(
          `UPDATE automotive_vehicle
           SET mileage_km=greatest(coalesce(mileage_km,0),$3),updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,row.vehicle_id,mileageOut]
        );
      }

      return result.rows[0];
    });
  }

  async updateWorkOrderLine(
    context:TenantContext,
    workOrderId:string,
    lineId:string,
    input:{approved?:boolean;completed?:boolean;unitPriceMinor?:number;unitCostMinor?:number}
  ) {
    return this.database.withTenantTransaction(context,async client=>{
      const line=await client.query<any>(
        `SELECT l.*,o.status AS order_status
         FROM automotive_work_order_line l
         JOIN automotive_work_order o
           ON o.tenant_id=l.tenant_id AND o.id=l.work_order_id
         WHERE l.tenant_id=$1 AND l.work_order_id=$2 AND l.id=$3
         FOR UPDATE OF l,o`,
        [context.tenantId,workOrderId,lineId]
      );
      const row=line.rows[0];
      if(!row) throw new NotFoundException("Строка заказ-наряда не найдена");
      if(["DELIVERED","CANCELLED"].includes(row.order_status)){
        throw new BadRequestException("Закрытый заказ-наряд изменять нельзя");
      }
      const effectiveApproved=input.approved??Boolean(row.approved);
      if(input.completed===true&&!effectiveApproved){
        throw new BadRequestException("Сначала согласуйте позицию с клиентом");
      }
      const result=await client.query(
        `UPDATE automotive_work_order_line
         SET
           approved=coalesce($4,approved),
           completed=CASE
             WHEN $5::boolean IS NULL THEN completed
             WHEN $5::boolean=true THEN true
             ELSE false
           END,
           unit_price_minor=coalesce($6,unit_price_minor),
           unit_cost_minor=coalesce($7,unit_cost_minor),
           updated_at=now()
         WHERE tenant_id=$1 AND work_order_id=$2 AND id=$3
         RETURNING *`,
        [
          context.tenantId,workOrderId,lineId,
          input.approved??null,input.completed??null,
          input.unitPriceMinor??null,input.unitCostMinor??null
        ]
      );
      return result.rows[0];
    });
  }

  async donors(context:TenantContext) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           d.*,
           count(p.id)::integer AS parts_total,
           count(p.id) FILTER(WHERE p.status='AVAILABLE')::integer AS parts_available,
           coalesce(sum(p.allocated_cost_minor),0)::text AS allocated_cost_minor,
           coalesce(sum(p.asking_price_minor) FILTER(WHERE p.status IN ('AVAILABLE','RESERVED')),0)::text AS remaining_asking_minor
         FROM automotive_donor_vehicle d
         LEFT JOIN automotive_dismantled_part p
           ON p.tenant_id=d.tenant_id AND p.donor_vehicle_id=d.id
         WHERE d.tenant_id=$1 AND d.status<>'ARCHIVED'
         GROUP BY d.id
         ORDER BY d.received_at DESC
         LIMIT 500`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createDonor(context:TenantContext,input:any) {
    const make=String(input.make??"").trim();
    const model=String(input.model??"").trim();
    if(!make||!model) throw new BadRequestException("Укажите марку и модель донора");
    return this.database.withTenantTransaction(context,async client=>{
      const stockNumber=String(input.stockNumber??"").trim()||
        await this.nextNumber(client,context.tenantId,"automotive_donor","DONOR");
      const result=await client.query(
        `INSERT INTO automotive_donor_vehicle(
           tenant_id,vin,stock_number,make,model,generation,production_year,
           engine_code,purchase_price_minor,dismantling_cost_minor,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          context.tenantId,String(input.vin??"").trim().toUpperCase()||null,
          stockNumber,make,model,String(input.generation??"").trim()||null,
          input.productionYear??null,String(input.engineCode??"").trim()||null,
          input.purchasePriceMinor??0,input.dismantlingCostMinor??0,
          JSON.stringify(input.metadata??{})
        ]
      );
      return result.rows[0];
    });
  }

  async parts(context:TenantContext,search?:string) {
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.*,d.stock_number,d.make AS donor_make,d.model AS donor_model,
           s.code AS sku_code
         FROM automotive_dismantled_part p
         JOIN automotive_donor_vehicle d
           ON d.tenant_id=p.tenant_id AND d.id=p.donor_vehicle_id
         LEFT JOIN sku s
           ON s.tenant_id=p.tenant_id AND s.id=p.sku_id
         WHERE p.tenant_id=$1
           AND p.status<>'ARCHIVED'
           AND (
             $2::text IS NULL
             OR p.part_name ILIKE '%'||$2||'%'
             OR p.oem_number ILIKE '%'||$2||'%'
             OR d.stock_number ILIKE '%'||$2||'%'
           )
         ORDER BY
           CASE p.status WHEN 'AVAILABLE' THEN 0 WHEN 'RESERVED' THEN 1 ELSE 2 END,
           p.updated_at DESC
         LIMIT 1000`,
        [context.tenantId,search?.trim()||null]
      );
      return result.rows;
    });
  }

  async fitments(
    context:TenantContext,
    input:{skuId?:string;vehicleId?:string}
  ){
    return this.database.withTenantTransaction(context,async client=>{
      let vehicle:any=null;
      if(input.vehicleId){
        const vehicleResult=await client.query(
          `SELECT make,model,generation,production_year,engine_code
           FROM automotive_vehicle
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.vehicleId]
        );
        vehicle=vehicleResult.rows[0]??null;
        if(!vehicle) throw new NotFoundException("Автомобиль не найден");
      }

      const result=await client.query(
        `SELECT
           f.id,f.sku_id,s.code AS sku_code,
           f.make,f.model,f.generation,f.year_from,f.year_to,
           f.engine_code,f.oem_number,f.fitment_source,
           f.confidence_bps,f.metadata
         FROM automotive_part_fitment f
         JOIN sku s
           ON s.tenant_id=f.tenant_id AND s.id=f.sku_id
         WHERE f.tenant_id=$1
           AND ($2::uuid IS NULL OR f.sku_id=$2)
           AND (
             $3::text IS NULL
             OR (
               lower(f.make)=lower($3)
               AND lower(f.model)=lower($4)
               AND (f.generation IS NULL OR $5::text IS NULL OR lower(f.generation)=lower($5))
               AND (f.year_from IS NULL OR $6::integer IS NULL OR f.year_from<=$6)
               AND (f.year_to IS NULL OR $6::integer IS NULL OR f.year_to>=$6)
               AND (f.engine_code IS NULL OR $7::text IS NULL OR lower(f.engine_code)=lower($7))
             )
           )
         ORDER BY f.confidence_bps DESC,f.make,f.model,f.year_from NULLS FIRST`,
        [
          context.tenantId,input.skuId??null,
          vehicle?.make??null,vehicle?.model??null,vehicle?.generation??null,
          vehicle?.production_year??null,vehicle?.engine_code??null
        ]
      );
      return result.rows;
    });
  }

  async createFitment(
    context:TenantContext,
    input:{
      skuId:string;
      make:string;
      model:string;
      generation?:string;
      yearFrom?:number;
      yearTo?:number;
      engineCode?:string;
      oemNumber?:string;
      fitmentSource?:"MANUAL"|"OEM_CATALOG"|"SUPPLIER"|"IMPORT";
      confidenceBps?:number;
      metadata?:Record<string,unknown>;
    }
  ){
    const make=input.make?.trim();
    const model=input.model?.trim();
    if(!input.skuId||!make||!model){
      throw new BadRequestException("Нужны SKU, марка и модель");
    }
    const yearFrom=input.yearFrom===undefined?null:Math.floor(input.yearFrom);
    const yearTo=input.yearTo===undefined?null:Math.floor(input.yearTo);
    if(yearFrom!==null&&(yearFrom<1900||yearFrom>2100)){
      throw new BadRequestException("Некорректный год начала применимости");
    }
    if(yearTo!==null&&(yearTo<1900||yearTo>2100)){
      throw new BadRequestException("Некорректный год окончания применимости");
    }
    if(yearFrom!==null&&yearTo!==null&&yearTo<yearFrom){
      throw new BadRequestException("Год окончания меньше года начала");
    }
    const confidence=Math.floor(input.confidenceBps??10000);
    if(confidence<0||confidence>10000){
      throw new BadRequestException("Некорректная уверенность совместимости");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const sku=await client.query(
        `SELECT 1 FROM sku
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,input.skuId]
      );
      if(!sku.rowCount) throw new NotFoundException("SKU не найден");

      const result=await client.query(
        `INSERT INTO automotive_part_fitment(
           tenant_id,sku_id,make,model,generation,year_from,year_to,
           engine_code,oem_number,fitment_source,confidence_bps,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          context.tenantId,input.skuId,make,model,
          input.generation?.trim()||null,yearFrom,yearTo,
          input.engineCode?.trim()||null,input.oemNumber?.trim()||null,
          input.fitmentSource??"MANUAL",confidence,
          JSON.stringify(input.metadata??{})
        ]
      );
      return result.rows[0];
    });
  }

  async compatibleParts(
    context:TenantContext,
    vehicleId:string,
    search?:string
  ){
    return this.database.withTenantTransaction(context,async client=>{
      const vehicleResult=await client.query<any>(
        `SELECT make,model,generation,production_year,engine_code
         FROM automotive_vehicle
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,vehicleId]
      );
      const vehicle=vehicleResult.rows[0];
      if(!vehicle) throw new NotFoundException("Автомобиль не найден");

      const result=await client.query(
        `SELECT DISTINCT ON (p.id)
           p.id,p.part_name,p.oem_number,p.condition_grade,p.status,
           p.asking_price_minor::text,p.allocated_cost_minor::text,
           p.sku_id,s.code AS sku_code,d.stock_number,
           f.confidence_bps,f.fitment_source
         FROM automotive_dismantled_part p
         JOIN automotive_donor_vehicle d
           ON d.tenant_id=p.tenant_id AND d.id=p.donor_vehicle_id
         JOIN automotive_part_fitment f
           ON f.tenant_id=p.tenant_id AND f.sku_id=p.sku_id
         JOIN sku s
           ON s.tenant_id=p.tenant_id AND s.id=p.sku_id
         WHERE p.tenant_id=$1
           AND p.status IN ('AVAILABLE','RESERVED')
           AND lower(f.make)=lower($2)
           AND lower(f.model)=lower($3)
           AND (
             f.generation IS NULL OR $4::text IS NULL OR
             lower(f.generation)=lower($4)
           )
           AND (
             f.year_from IS NULL OR $5::integer IS NULL OR f.year_from<=$5
           )
           AND (
             f.year_to IS NULL OR $5::integer IS NULL OR f.year_to>=$5
           )
           AND (
             f.engine_code IS NULL OR $6::text IS NULL OR
             lower(f.engine_code)=lower($6)
           )
           AND (
             $7::text IS NULL
             OR p.part_name ILIKE '%'||$7||'%'
             OR p.oem_number ILIKE '%'||$7||'%'
             OR s.code ILIKE '%'||$7||'%'
           )
         ORDER BY p.id,f.confidence_bps DESC
         LIMIT 500`,
        [
          context.tenantId,vehicle.make,vehicle.model,vehicle.generation,
          vehicle.production_year,vehicle.engine_code,search?.trim()||null
        ]
      );
      return result.rows;
    });
  }

  async linkPartToInventory(
    context:TenantContext,
    partId:string,
    input:{skuId:string;warehouseId:string}
  ){
    if(!input.skuId||!input.warehouseId){
      throw new BadRequestException("Укажите SKU и склад");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const partResult=await client.query<any>(
        `SELECT *
         FROM automotive_dismantled_part
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId,partId]
      );
      const part=partResult.rows[0];
      if(!part) throw new NotFoundException("Деталь не найдена");
      if(part.sku_id||part.warehouse_id){
        if(part.sku_id===input.skuId&&part.warehouse_id===input.warehouseId){
          return part;
        }
        throw new BadRequestException(
          "Деталь уже привязана к другому SKU или складу"
        );
      }

      await this.inventory.receiveForAutomotive(client,context,{
        partId,
        warehouseId:input.warehouseId,
        skuId:input.skuId,
        quantityMilli:BigInt(part.quantity_milli),
        unitCostMinor:
          BigInt(part.quantity_milli)>0n
            ?(
              BigInt(part.allocated_cost_minor)*1000n+
              BigInt(part.quantity_milli)-1n
            )/BigInt(part.quantity_milli)
            :0n
      });

      const updated=await client.query(
        `UPDATE automotive_dismantled_part
         SET sku_id=$3,warehouse_id=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [context.tenantId,partId,input.skuId,input.warehouseId]
      );
      return updated.rows[0];
    });
  }

  async addDismantledPart(context:TenantContext,donorId:string,input:any) {
    const name=String(input.partName??"").trim();
    if(!name) throw new BadRequestException("Укажите название детали");
    return this.database.withTenantTransaction(context,async client=>{
      const donor=await client.query(
        `SELECT 1 FROM automotive_donor_vehicle
         WHERE tenant_id=$1 AND id=$2 AND status IN ('RECEIVED','DISMANTLING','DISMANTLED')
         FOR UPDATE`,
        [context.tenantId,donorId]
      );
      if(!donor.rowCount) throw new NotFoundException("Донор не найден");
      if(Boolean(input.skuId)!==Boolean(input.warehouseId)){
        throw new BadRequestException(
          "Для складского прихода укажите одновременно SKU и склад"
        );
      }
      const quantity=BigInt(String(input.quantityMilli??1000));
      const allocatedCost=BigInt(String(input.allocatedCostMinor??0));
      if(quantity<=0n||allocatedCost<0n){
        throw new BadRequestException("Некорректное количество или себестоимость детали");
      }

      const result=await client.query(
        `INSERT INTO automotive_dismantled_part(
           tenant_id,donor_vehicle_id,sku_id,part_name,oem_number,
           condition_grade,serial_number,warehouse_id,quantity_milli,
           allocated_cost_minor,asking_price_minor,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          context.tenantId,donorId,input.skuId??null,name,
          String(input.oemNumber??"").trim()||null,
          input.conditionGrade??"USED_B",
          String(input.serialNumber??"").trim()||null,input.warehouseId??null,
          quantity.toString(),allocatedCost.toString(),
          input.askingPriceMinor??0,JSON.stringify(input.metadata??{})
        ]
      );
      const part=result.rows[0];
      if(!part) throw new Error("AUTOMOTIVE_DISMANTLED_PART_CREATE_FAILED");

      if(input.skuId&&input.warehouseId){
        const perUnitCost=
          quantity>0n ? (allocatedCost*1000n+quantity-1n)/quantity : 0n;
        await this.inventory.receiveForAutomotive(client,context,{
          partId:part.id,
          warehouseId:input.warehouseId,
          skuId:input.skuId,
          quantityMilli:quantity,
          unitCostMinor:perUnitCost
        });
      }

      await client.query(
        `UPDATE automotive_donor_vehicle
         SET status=CASE WHEN status='RECEIVED' THEN 'DISMANTLING' ELSE status END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,donorId]
      );
      return part;
    });
  }

  private async nextNumber(client:PoolClient,tenantId:string,key:string,prefix:string) {
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
}
