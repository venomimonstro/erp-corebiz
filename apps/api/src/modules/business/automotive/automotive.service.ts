import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class AutomotiveService {
  constructor(private readonly database:DatabaseService) {}

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
      await client.query(
        `UPDATE automotive_work_order o
         SET estimated_total_minor=coalesce((
           SELECT sum((l.unit_price_minor*l.quantity_milli+999)/1000)
           FROM automotive_work_order_line l
           WHERE l.tenant_id=o.tenant_id AND l.work_order_id=o.id
         ),0),updated_at=now()
         WHERE o.tenant_id=$1 AND o.id=$2`,
        [context.tenantId,workOrderId]
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
          input.quantityMilli??1000,input.allocatedCostMinor??0,
          input.askingPriceMinor??0,JSON.stringify(input.metadata??{})
        ]
      );
      await client.query(
        `UPDATE automotive_donor_vehicle
         SET status=CASE WHEN status='RECEIVED' THEN 'DISMANTLING' ELSE status END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,donorId]
      );
      return result.rows[0];
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
