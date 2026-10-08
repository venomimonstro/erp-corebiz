import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class WmsInboundService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    context: TenantContext,
    warehouseId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async client => {
      const result=await client.query(
        "SELECT a.id,a.warehouse_id,w.name AS warehouse_name,a.owner_id,o.name AS owner_name,"+
        "a.purchase_order_id,po.business_number AS purchase_order_number,a.external_reference,"+
        "a.status,a.expected_from,a.expected_to,a.vehicle_plate,a.carrier_name,a.created_at,"+
        "count(l.id)::int AS lines,"+
        "COALESCE(sum(l.expected_quantity_milli),0)::text AS expected_quantity_milli,"+
        "COALESCE(sum(l.received_quantity_milli),0)::text AS received_quantity_milli "+
        "FROM wms_inbound_asn a "+
        "JOIN warehouse w ON w.tenant_id=a.tenant_id AND w.id=a.warehouse_id "+
        "JOIN inventory_owner o ON o.tenant_id=a.tenant_id AND o.id=a.owner_id "+
        "LEFT JOIN purchase_order po ON po.tenant_id=a.tenant_id AND po.id=a.purchase_order_id "+
        "LEFT JOIN wms_inbound_asn_line l ON l.tenant_id=a.tenant_id AND l.asn_id=a.id "+
        "WHERE a.tenant_id=$1 AND ($2::uuid IS NULL OR a.warehouse_id=$2) "+
        "GROUP BY a.id,w.name,o.name,po.business_number "+
        "ORDER BY a.expected_from NULLS LAST,a.created_at DESC LIMIT 1000",
        [context.tenantId,warehouseId??null]
      );
      return result.rows;
    });
  }

  async details(
    context: TenantContext,
    asnId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async client => {
      const head=await client.query(
        "SELECT a.*,w.name AS warehouse_name,o.name AS owner_name,"+
        "po.business_number AS purchase_order_number,p.display_name AS supplier_name "+
        "FROM wms_inbound_asn a "+
        "JOIN warehouse w ON w.tenant_id=a.tenant_id AND w.id=a.warehouse_id "+
        "JOIN inventory_owner o ON o.tenant_id=a.tenant_id AND o.id=a.owner_id "+
        "LEFT JOIN purchase_order po ON po.tenant_id=a.tenant_id AND po.id=a.purchase_order_id "+
        "LEFT JOIN party p ON p.tenant_id=a.tenant_id AND p.id=a.supplier_party_id "+
        "WHERE a.tenant_id=$1 AND a.id=$2",
        [context.tenantId,asnId]
      );
      if(!head.rows[0]) throw new NotFoundException("ASN не найден");

      const lines=await client.query(
        "SELECT l.id,l.sku_id,s.code AS sku_code,p.name AS product_name,"+
        "l.expected_quantity_milli::text,l.received_quantity_milli::text "+
        "FROM wms_inbound_asn_line l "+
        "JOIN sku s ON s.tenant_id=l.tenant_id AND s.id=l.sku_id "+
        "JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id "+
        "JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id "+
        "WHERE l.tenant_id=$1 AND l.asn_id=$2 ORDER BY p.name,s.code",
        [context.tenantId,asnId]
      );

      const appointments=await client.query(
        "SELECT d.id,d.dock_location_id,l.full_code AS dock_code,d.scheduled_from,d.scheduled_to,"+
        "d.status,d.driver_name,d.driver_phone,d.vehicle_plate,d.checked_in_at,"+
        "d.service_started_at,d.completed_at "+
        "FROM wms_dock_appointment d "+
        "JOIN warehouse_location l ON l.tenant_id=d.tenant_id AND l.id=d.dock_location_id "+
        "WHERE d.tenant_id=$1 AND d.asn_id=$2 ORDER BY d.scheduled_from",
        [context.tenantId,asnId]
      );

      return {asn:head.rows[0],lines:lines.rows,appointments:appointments.rows};
    });
  }

  async create(
    context: TenantContext,
    input: {
      warehouseId:string;
      ownerId:string;
      purchaseOrderId?:string;
      supplierPartyId?:string;
      externalReference?:string;
      expectedFrom?:string;
      expectedTo?:string;
      vehiclePlate?:string;
      carrierName?:string;
      notes?:string;
      lines?:Array<{skuId:string;expectedQuantityMilli:string}>;
    }
  ): Promise<{id:string}> {
    const expectedFrom=input.expectedFrom?new Date(input.expectedFrom):null;
    const expectedTo=input.expectedTo?new Date(input.expectedTo):null;

    if(
      (expectedFrom&&Number.isNaN(expectedFrom.getTime()))||
      (expectedTo&&Number.isNaN(expectedTo.getTime()))||
      (expectedFrom&&expectedTo&&expectedTo<=expectedFrom)
    ){
      throw new BadRequestException("Некорректное ожидаемое окно ASN");
    }

    return this.database.withTenantTransaction(context,async client=>{
      let supplierPartyId=input.supplierPartyId??null;
      const prepared:Array<{skuId:string;quantity:string}>=[];

      if(input.purchaseOrderId){
        const po=await client.query<{
          supplier_party_id:string;
          inventory_owner_id:string;
          status:string;
        }>(
          "SELECT supplier_party_id,inventory_owner_id,status FROM purchase_order "+
          "WHERE tenant_id=$1 AND id=$2",
          [context.tenantId,input.purchaseOrderId]
        );
        const row=po.rows[0];
        if(!row)throw new NotFoundException("Purchase Order не найден");
        if(["DRAFT","CANCELLED"].includes(row.status)){
          throw new BadRequestException("ASN требует подтверждённый Purchase Order");
        }
        if(row.inventory_owner_id!==input.ownerId){
          throw new ConflictException("Owner ASN не совпадает с Purchase Order");
        }
        supplierPartyId=row.supplier_party_id;

        const poLines=await client.query<{
          sku_id:string;
          remaining:string;
        }>(
          "SELECT sku_id,(ordered_quantity_milli-received_quantity_milli)::text AS remaining "+
          "FROM purchase_order_line WHERE tenant_id=$1 AND purchase_order_id=$2 "+
          "AND ordered_quantity_milli>received_quantity_milli",
          [context.tenantId,input.purchaseOrderId]
        );
        for(const line of poLines.rows){
          prepared.push({skuId:line.sku_id,quantity:line.remaining});
        }
      }else{
        for(const line of input.lines??[]){
          if(!/^\d+$/.test(line.expectedQuantityMilli)||BigInt(line.expectedQuantityMilli)<=0n){
            throw new BadRequestException("Некорректное количество ASN");
          }
          prepared.push({skuId:line.skuId,quantity:line.expectedQuantityMilli});
        }
      }

      if(!prepared.length){
        throw new BadRequestException("ASN должен содержать ожидаемые позиции");
      }

      const asn=await client.query<{id:string}>(
        "INSERT INTO wms_inbound_asn("+
        "tenant_id,warehouse_id,owner_id,purchase_order_id,supplier_party_id,"+
        "external_reference,expected_from,expected_to,vehicle_plate,carrier_name,notes,"+
        "created_by_membership_id"+
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id",
        [
          context.tenantId,input.warehouseId,input.ownerId,input.purchaseOrderId??null,
          supplierPartyId,input.externalReference?.trim()||null,
          expectedFrom,expectedTo,input.vehiclePlate?.trim()||null,
          input.carrierName?.trim()||null,input.notes?.trim()||null,context.membershipId
        ]
      );
      const id=asn.rows[0]!.id;

      for(const line of prepared){
        await client.query(
          "INSERT INTO wms_inbound_asn_line("+
          "tenant_id,asn_id,sku_id,expected_quantity_milli"+
          ") VALUES ($1,$2,$3,$4) "+
          "ON CONFLICT (asn_id,sku_id) DO UPDATE SET "+
          "expected_quantity_milli=wms_inbound_asn_line.expected_quantity_milli+EXCLUDED.expected_quantity_milli",
          [context.tenantId,id,line.skuId,line.quantity]
        );
      }

      return {id};
    });
  }

  async schedule(
    context: TenantContext,
    asnId:string,
    input:{
      dockLocationId:string;
      scheduledFrom:string;
      scheduledTo:string;
      driverName?:string;
      driverPhone?:string;
      vehiclePlate?:string;
    }
  ):Promise<{id:string}>{
    const from=new Date(input.scheduledFrom);
    const to=new Date(input.scheduledTo);
    if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<=from){
      throw new BadRequestException("Некорректное окно дока");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const asn=await client.query<{warehouse_id:string;status:string}>(
        "SELECT warehouse_id,status FROM wms_inbound_asn "+
        "WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId,asnId]
      );
      const row=asn.rows[0];
      if(!row)throw new NotFoundException("ASN не найден");
      if(["RECEIVED","CANCELLED"].includes(row.status)){
        throw new BadRequestException("ASN закрыт для планирования");
      }

      try{
        const result=await client.query<{id:string}>(
          "INSERT INTO wms_dock_appointment("+
          "tenant_id,warehouse_id,asn_id,dock_location_id,scheduled_from,scheduled_to,"+
          "driver_name,driver_phone,vehicle_plate,created_by_membership_id"+
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
          [
            context.tenantId,row.warehouse_id,asnId,input.dockLocationId,from,to,
            input.driverName?.trim()||null,input.driverPhone?.trim()||null,
            input.vehiclePlate?.trim()||null,context.membershipId
          ]
        );

        await client.query(
          "UPDATE wms_inbound_asn SET status='SCHEDULED',expected_from=$3,expected_to=$4,"+
          "updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [context.tenantId,asnId,from,to]
        );

        return result.rows[0]!;
      }catch(error){
        if(error&&typeof error==="object"&&"code" in error&&error.code==="23514"){
          throw new ConflictException(
            "Док занят в это время или параметры окна не соответствуют ASN"
          );
        }
        throw error;
      }
    });
  }

  async transitionAppointment(
    context:TenantContext,
    appointmentId:string,
    action:"CHECK_IN"|"START"|"COMPLETE"|"NO_SHOW"|"CANCEL"
  ):Promise<void>{
    await this.database.withTenantTransaction(context,async client=>{
      const result=await client.query<{
        asn_id:string;
        status:string;
      }>(
        "SELECT asn_id,status FROM wms_dock_appointment "+
        "WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId,appointmentId]
      );
      const row=result.rows[0];
      if(!row)throw new NotFoundException("Dock appointment не найден");

      const allowed:Record<string,string[]>={
        CHECK_IN:["SCHEDULED"],
        START:["CHECKED_IN"],
        COMPLETE:["IN_SERVICE"],
        NO_SHOW:["SCHEDULED"],
        CANCEL:["SCHEDULED","CHECKED_IN"]
      };
      if(!allowed[action].includes(row.status)){
        throw new ConflictException("Недопустимый переход dock appointment");
      }

      const next=
        action==="CHECK_IN"?"CHECKED_IN":
        action==="START"?"IN_SERVICE":
        action==="COMPLETE"?"COMPLETED":
        action==="NO_SHOW"?"NO_SHOW":"CANCELLED";

      await client.query(
        "UPDATE wms_dock_appointment SET status=$3,"+
        "checked_in_at=CASE WHEN $3='CHECKED_IN' THEN now() ELSE checked_in_at END,"+
        "service_started_at=CASE WHEN $3='IN_SERVICE' THEN now() ELSE service_started_at END,"+
        "completed_at=CASE WHEN $3='COMPLETED' THEN now() ELSE completed_at END,"+
        "updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,appointmentId,next]
      );

      const asnState=
        next==="CHECKED_IN"?"ARRIVED":
        next==="IN_SERVICE"?"RECEIVING":
        null;
      if(asnState){
        await client.query(
          "UPDATE wms_inbound_asn SET status=$3,updated_at=now() "+
          "WHERE tenant_id=$1 AND id=$2 AND status<>'RECEIVED'",
          [context.tenantId,row.asn_id,asnState]
        );
      }
    });
  }

  async dockSchedule(
    context:TenantContext,
    warehouseId:string,
    from?:string,
    to?:string
  ):Promise<Array<Record<string,unknown>>>{
    const start=from?new Date(from):new Date();
    const end=to?new Date(to):new Date(start.getTime()+7*86400000);
    if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start){
      throw new BadRequestException("Некорректный период");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        "SELECT d.id,d.asn_id,d.dock_location_id,l.full_code AS dock_code,"+
        "d.scheduled_from,d.scheduled_to,d.status,d.driver_name,d.vehicle_plate,"+
        "a.external_reference,a.owner_id,o.name AS owner_name,a.purchase_order_id "+
        "FROM wms_dock_appointment d "+
        "JOIN wms_inbound_asn a ON a.tenant_id=d.tenant_id AND a.id=d.asn_id "+
        "JOIN warehouse_location l ON l.tenant_id=d.tenant_id AND l.id=d.dock_location_id "+
        "JOIN inventory_owner o ON o.tenant_id=a.tenant_id AND o.id=a.owner_id "+
        "WHERE d.tenant_id=$1 AND d.warehouse_id=$2 "+
        "AND d.scheduled_from<$4 AND d.scheduled_to>$3 "+
        "ORDER BY d.scheduled_from,l.full_code",
        [context.tenantId,warehouseId,start,end]
      );
      return result.rows;
    });
  }
}
