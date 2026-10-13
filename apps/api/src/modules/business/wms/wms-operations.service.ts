import {BadRequestException,Injectable,NotFoundException} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";
import {
  warehouseStockIndicators,orderPickRoute,type PickRouteTask,
  encodeStockCursor,decodeStockCursor
} from "./wms-operations.logic";

const isUuid=(x:string)=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x);

/** Read models only. The inventory ledger and shipment workflow remain
 * authoritative. No movement, reservation or payment is made here.
 */
@Injectable()
export class WmsOperationsService{
  constructor(private readonly database:DatabaseService){}

  async stock(context:TenantContext,warehouseId:string){
    if(!isUuid(warehouseId))throw new BadRequestException("Некорректный склад");
    return this.database.withTenantTransaction(context,async client=>{
      const warehouse=await client.query<{name:string;branch_id:string|null}>(
        `SELECT name,branch_id FROM warehouse
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,warehouseId]
      );
      if(!warehouse.rows[0])throw new NotFoundException("Склад не найден");

      // Purchase orders are linked to branches, not bins or warehouses.
      // Count expected stock for this warehouse ONLY if it is the branch's
      // sole active warehouse. All ambiguous inbound remains unallocated.
      const rows=await client.query<{
        sku_id:string;sku_code:string;product_name:string;
        physical_milli:string;reserved_milli:string;
        expected_milli:string;safety_milli:string;
        sourcing_enabled:boolean;
      }>(
        `WITH unique_branch_warehouse AS (
           SELECT branch_id,min(id) AS warehouse_id
           FROM warehouse
           WHERE tenant_id=$1 AND status='ACTIVE'
             AND branch_id IS NOT NULL
           GROUP BY branch_id HAVING count(*)=1
         ),
         expected AS (
           SELECT l.sku_id,
             coalesce(po.destination_warehouse_id,ub.warehouse_id) AS warehouse_id,
             sum(greatest(l.ordered_quantity_milli -
                          l.received_quantity_milli,0)) AS inbound_milli
           FROM purchase_order_line l
           JOIN purchase_order po
             ON po.tenant_id=l.tenant_id AND po.id=l.purchase_order_id
           LEFT JOIN unique_branch_warehouse ub
             ON ub.branch_id=po.destination_branch_id
           WHERE l.tenant_id=$1 AND
             po.status IN ('CONFIRMED','PARTIALLY_RECEIVED')
           GROUP BY l.sku_id,coalesce(po.destination_warehouse_id,ub.warehouse_id)
         )
         ,all_skus AS (
           SELECT sku_id FROM inventory_balance
           WHERE tenant_id=$1 AND warehouse_id=$2
           UNION
           SELECT sku_id FROM expected WHERE warehouse_id=$2
         )
         SELECT sku_set.sku_id,s.code AS sku_code,p.name AS product_name,
           coalesce(b.physical_milli,0)::text AS physical_milli,
           coalesce(b.reserved_milli,0)::text AS reserved_milli,
           coalesce(e.inbound_milli,0)::text AS expected_milli,
           coalesce(ip.safety_stock_milli,0)::text AS safety_milli,
           coalesce(ip.enabled,true) AS sourcing_enabled
         FROM all_skus sku_set
         JOIN sku s ON s.id=sku_set.sku_id AND s.tenant_id=$1
         JOIN product_variant v ON v.id=s.variant_id AND v.tenant_id=s.tenant_id
         JOIN product p ON p.id=v.product_id AND p.tenant_id=v.tenant_id
         LEFT JOIN inventory_balance b ON b.tenant_id=$1
           AND b.warehouse_id=$2 AND b.sku_id=sku_set.sku_id
         LEFT JOIN inventory_policy ip ON ip.tenant_id=$1
           AND ip.warehouse_id=$2 AND ip.sku_id=sku_set.sku_id
         LEFT JOIN expected e ON e.warehouse_id=$2
           AND e.sku_id=sku_set.sku_id
         WHERE 1=1
         ORDER BY p.name,s.code LIMIT 501`,
        [context.tenantId,warehouseId]
      );
      const items=rows.rows.slice(0,500).map(row=>({
        skuId:row.sku_id,sku:row.sku_code,productName:row.product_name,
        ...warehouseStockIndicators({
          physicalMilli:row.physical_milli,
          reservedMilli:row.reserved_milli,
          expectedMilli:row.expected_milli,
          safetyMilli:row.safety_milli,
          sourcingEnabled:row.sourcing_enabled
        })
      }));
      const issues=items.filter(x=>x.state!=="OK"&&
        x.state!=="INCOMING_CONFIRMED");
      return {
        warehouseId,warehouseName:warehouse.rows[0].name,
        stockSource:"INVENTORY_LEDGER",
        inboundSource:"CONFIRMED_PURCHASE_ORDERS_UNIQUE_BRANCH_ONLY",
        planningExpectedIsNotPhysical:true,
        requiresPagination:rows.rows.length>500,
        totalShown:items.length,
        shortages:issues.length,
        items
      };
    });
  }

  /** Live ledger report, filter/paginate on the server, never client-only.
   * A confirmed purchase order is NOT physical stock or reserved supply.
   */
  async stockPage(context:TenantContext,warehouseId:string,input:{
    query?:string;onlyProblems?:boolean;cursor?:string;limit?:number;
  }){
    if(!isUuid(warehouseId))throw new BadRequestException("Некорректный склад");
    const query=(input.query??"").trim();
    if(query.length>80)throw new BadRequestException("Поиск: до 80 символов");
    const onlyProblems=input.onlyProblems===true;
    const limit=input.limit??100;
    if(!Number.isInteger(limit)||limit<10||limit>100)
      throw new BadRequestException("Размер страницы: 10–100");
    let after:{name:string;sku:string;skuId:string}|null=null;
    if(input.cursor){
      let decoded:ReturnType<typeof decodeStockCursor>;
      try{decoded=decodeStockCursor(input.cursor);}
      catch{throw new BadRequestException("Неверный курсор страницы");}
      if(decoded.warehouseId!==warehouseId||
         decoded.query!==query||decoded.onlyProblems!==onlyProblems)
        throw new BadRequestException("Курсор другого склада или фильтра");
      after={name:decoded.name,sku:decoded.sku,skuId:decoded.skuId};
    }
    return this.database.withTenantTransaction(context,async client=>{
      const warehouse=await client.query<{name:string}>(
        "SELECT name FROM warehouse WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,warehouseId]
      );
      if(!warehouse.rows[0])throw new NotFoundException("Склад не найден");
      const rows=await client.query<{
        sku_id:string;sku_code:string;product_name:string;
        physical_milli:string;reserved_milli:string;
        expected_milli:string;safety_milli:string;sourcing_enabled:boolean;
      }>(
        `WITH unique_branch_warehouse AS (
           SELECT branch_id,min(id) AS warehouse_id
           FROM warehouse
           WHERE tenant_id=$1 AND status='ACTIVE'
             AND branch_id IS NOT NULL
           GROUP BY branch_id HAVING count(*)=1
         ),expected AS (
           SELECT l.sku_id,
             coalesce(po.destination_warehouse_id,ub.warehouse_id) AS warehouse_id,
             sum(greatest(l.ordered_quantity_milli-l.received_quantity_milli,0)) AS inbound_milli
           FROM purchase_order_line l
           JOIN purchase_order po
             ON po.tenant_id=l.tenant_id AND po.id=l.purchase_order_id
           LEFT JOIN unique_branch_warehouse ub
             ON ub.branch_id=po.destination_branch_id
           WHERE l.tenant_id=$1
             AND po.status IN ('CONFIRMED','PARTIALLY_RECEIVED')
           GROUP BY l.sku_id,coalesce(po.destination_warehouse_id,ub.warehouse_id)
         ),all_skus AS (
           SELECT sku_id FROM inventory_balance
           WHERE tenant_id=$1 AND warehouse_id=$2
           UNION
           SELECT sku_id FROM expected WHERE warehouse_id=$2
         )
         SELECT sku_set.sku_id,s.code AS sku_code,p.name AS product_name,
           coalesce(b.physical_milli,0)::text AS physical_milli,
           coalesce(b.reserved_milli,0)::text AS reserved_milli,
           coalesce(e.inbound_milli,0)::text AS expected_milli,
           coalesce(ip.safety_stock_milli,0)::text AS safety_milli,
           coalesce(ip.enabled,true) AS sourcing_enabled
         FROM all_skus sku_set
         JOIN sku s ON s.tenant_id=$1 AND s.id=sku_set.sku_id
         JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         LEFT JOIN inventory_balance b ON b.tenant_id=$1 AND b.warehouse_id=$2
           AND b.sku_id=sku_set.sku_id
         LEFT JOIN inventory_policy ip ON ip.tenant_id=$1 AND ip.warehouse_id=$2
           AND ip.sku_id=sku_set.sku_id
         LEFT JOIN expected e ON e.warehouse_id=$2 AND e.sku_id=sku_set.sku_id
         WHERE ($3::text='' OR p.name ILIKE '%'||$3||'%'
            OR s.code ILIKE '%'||$3||'%')
           AND (NOT $4::boolean OR (
             coalesce(b.physical_milli,0)-coalesce(b.reserved_milli,0)
               < coalesce(ip.safety_stock_milli,0)))
           AND ($5::text IS NULL OR
             (p.name,s.code,sku_set.sku_id)>($5::text,$6::text,$7::uuid))
         ORDER BY p.name,s.code,sku_set.sku_id LIMIT $8`,
        [context.tenantId,warehouseId,query,onlyProblems,
         after?.name??null,after?.sku??null,after?.skuId??null,limit+1]
      );
      const hasMore=rows.rows.length>limit;
      const selected=rows.rows.slice(0,limit);
      const items=selected.map(row=>({
        skuId:row.sku_id,sku:row.sku_code,productName:row.product_name,
        ...warehouseStockIndicators({
          physicalMilli:row.physical_milli,reservedMilli:row.reserved_milli,
          expectedMilli:row.expected_milli,safetyMilli:row.safety_milli,
          sourcingEnabled:row.sourcing_enabled
        })
      }));
      const last=selected.at(-1);
      return{
        warehouseId,warehouseName:warehouse.rows[0].name,items,
        stockSource:"INVENTORY_LEDGER",
        inboundSource:"CONFIRMED_PURCHASE_ORDERS",
        planningExpectedIsNotPhysical:true,
        hasMore,onlyProblems,query,
        nextCursor:hasMore&&last?encodeStockCursor({
          warehouseId,name:last.product_name,sku:last.sku_code,
          skuId:last.sku_id,query,onlyProblems
        }):null,
        stableSnapshot:false
      };
    });
  }

  async pickRoute(context:TenantContext,warehouseId:string,waveId?:string){
    if(!isUuid(warehouseId)||(waveId&&!isUuid(waveId)))
      throw new BadRequestException("Некорректный склад или волна");
    return this.database.withTenantTransaction(context,async client=>{
      const warehouse=await client.query(
        "SELECT 1 FROM warehouse WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
        [context.tenantId,warehouseId]
      );
      if(!warehouse.rowCount)throw new NotFoundException("Склад не найден");
      if(waveId){
        const wave=await client.query(
          `SELECT 1 FROM wms_wave
           WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3`,
          [context.tenantId,warehouseId,waveId]
        );
        if(!wave.rowCount)throw new NotFoundException("Волна не найдена");
      }
      const response=await client.query<{
        id:string;zone_priority:number;pick_sequence:number;priority:number;
        location_code:string;sku_code:string;quantity_milli:string;
        order_id:string|null;status:string;
      }>(
        `SELECT t.id,t.priority,t.status,
           z.priority AS zone_priority,
           l.pick_sequence,l.full_code AS location_code,
           s.code AS sku_code,t.quantity_milli::text,
           t.source_id AS order_id
         FROM warehouse_task t
         JOIN warehouse_location l
           ON l.id=t.from_location_id AND l.tenant_id=t.tenant_id
           AND l.warehouse_id=t.warehouse_id
         JOIN warehouse_zone z
           ON z.id=l.zone_id AND z.tenant_id=t.tenant_id
           AND z.warehouse_id=t.warehouse_id
         JOIN sku s ON s.id=t.sku_id AND s.tenant_id=t.tenant_id
         WHERE t.tenant_id=$1 AND t.warehouse_id=$2
           AND t.task_type='PICK'
           AND t.status IN ('OPEN','CLAIMED')
           AND ($3::uuid IS NULL OR t.wave_id=$3)
         ORDER BY z.priority,l.pick_sequence,t.priority,t.created_at,t.id
         LIMIT 501`,
        [context.tenantId,warehouseId,waveId??null]
      );
      const route:PickRouteTask[]=response.rows.slice(0,500).map(x=>({
        taskId:x.id,zonePriority:x.zone_priority,
        pickSequence:x.pick_sequence,priority:x.priority,
        locationCode:x.location_code,skuCode:x.sku_code,
        quantityMilli:x.quantity_milli,orderId:x.order_id,status:x.status
      }));
      return {
        warehouseId,waveId:waveId??null,
        ordering:"ZONE_PRIORITY_THEN_PICK_SEQUENCE",
        globallyOptimal:false,
        truncated:response.rows.length>500,
        tasks:orderPickRoute(route)
      };
    });
  }
}
