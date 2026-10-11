import {BadRequestException,ConflictException,Injectable,NotFoundException} from "@nestjs/common";
import type {TenantContext} from "@corebiz/contracts";
import {DatabaseService} from "../../../infrastructure/database/database.service";

@Injectable()
export class MarketplaceHubService {
  constructor(private readonly database:DatabaseService){}

  async overview(context:TenantContext) {
    return this.database.withTenantTransaction(context,async client=>{
      const [warehouses,listings,dirty]=await Promise.all([
        client.query(`SELECT w.id,w.name,w.code,w.is_default,
          count(DISTINCT b.sku_id)::integer AS tracked_skus
          FROM warehouse w LEFT JOIN inventory_balance b
          ON b.tenant_id=w.tenant_id AND b.warehouse_id=w.id
          WHERE w.tenant_id=$1 AND w.status='ACTIVE'
          GROUP BY w.id ORDER BY w.is_default DESC,w.name`,[context.tenantId]),
        client.query(`SELECT l.id,l.connection_id,c.provider,c.name AS connection_name,
            l.warehouse_id,w.name AS warehouse_name,l.sku_id,s.code AS sku,
            l.mapping_id,m.external_offer_id,l.external_warehouse_id,
            l.priority,l.enabled,l.publish_enabled,l.status,
            coalesce(b.physical_milli,0)::text AS physical_milli,
            coalesce(b.reserved_milli,0)::text AS reserved_milli,
            coalesce(ip.safety_stock_milli,0)::text AS safety_stock_milli,
            coalesce(t.target_units,0)::integer AS target_units,
            t.published_units,t.status AS sync_status,t.last_error,t.last_published_at,
            t.updated_at AS sync_updated_at
          FROM channel_stock_listing l
          JOIN channel_connection c ON c.tenant_id=l.tenant_id AND c.id=l.connection_id
          JOIN channel_product_mapping m ON m.tenant_id=l.tenant_id AND m.id=l.mapping_id
          JOIN warehouse w ON w.tenant_id=l.tenant_id AND w.id=l.warehouse_id
          JOIN sku s ON s.tenant_id=l.tenant_id AND s.id=l.sku_id
          LEFT JOIN inventory_balance b ON b.tenant_id=l.tenant_id
            AND b.warehouse_id=l.warehouse_id AND b.sku_id=l.sku_id
          LEFT JOIN inventory_policy ip ON ip.tenant_id=l.tenant_id
            AND ip.warehouse_id=l.warehouse_id AND ip.sku_id=l.sku_id
          LEFT JOIN channel_stock_target t ON t.tenant_id=l.tenant_id AND t.listing_id=l.id
          WHERE l.tenant_id=$1 ORDER BY w.name,s.code,l.priority,c.name LIMIT 2000`,[context.tenantId]),
        client.query(`SELECT count(*)::integer AS count FROM channel_stock_dirty WHERE tenant_id=$1`,[context.tenantId])
      ]);
      return {warehouses:warehouses.rows,listings:listings.rows,
        queuedPools:dirty.rows[0]?.count??0,
        safetyNote:"Общий остаток распределяется по площадкам без дублирования доступных единиц. FBO/FBW не входит в этот пул."};
    });
  }

  async upsertListing(context:TenantContext,input:{
    connectionId?:string;mappingId?:string;warehouseId?:string;
    externalWarehouseId?:string;priority?:number;enabled?:boolean;publishEnabled?:boolean;
  }){
    const {connectionId,mappingId,warehouseId}=input??{};
    if(!connectionId||!mappingId||!warehouseId)
      throw new BadRequestException("Укажите канал, сопоставление SKU и свой склад");
    const priority=input.priority??100;
    if(!Number.isInteger(priority)||priority<1||priority>10000)
      throw new BadRequestException("Приоритет должен быть от 1 до 10000");
    const external=input.externalWarehouseId?.trim()||null;
    if(external!==null&&!/^[1-9][0-9]{0,17}$/.test(external))
      throw new BadRequestException("ID склада маркетплейса должен быть целым положительным числом");
    if(input.publishEnabled&&!external)
      throw new BadRequestException("Перед публикацией укажите внешний ID склада");
    return this.database.withTenantTransaction(context,async client=>{
      const mapped=await client.query<{sku_id:string;provider:string;credential_ready:boolean}>(
        `SELECT m.sku_id,c.provider,c.credentials_ciphertext IS NOT NULL AS credential_ready
         FROM channel_product_mapping m
         JOIN channel_connection c ON c.tenant_id=m.tenant_id AND c.id=m.connection_id
         JOIN warehouse w ON w.tenant_id=m.tenant_id AND w.id=$4 AND w.status='ACTIVE'
         WHERE m.tenant_id=$1 AND m.id=$2 AND c.id=$3 AND c.status<>'DISABLED'
           AND m.status='ACTIVE'`,[context.tenantId,mappingId,connectionId,warehouseId]);
      const row=mapped.rows[0];
      if(!row)throw new NotFoundException("Не найдено активное сопоставление товара и склада");
      if(!["OZON","WILDBERRIES","YANDEX_MARKET"].includes(row.provider))
        throw new BadRequestException("Автопубликация разрешена только для поддерживаемых маркетплейсов");
      if(input.publishEnabled&&!row.credential_ready)
        throw new ConflictException("У подключения нет безопасно сохранённого API-ключа");
      const existing=await client.query<{id:string}>(
        `SELECT id FROM channel_stock_listing
         WHERE tenant_id=$1 AND connection_id=$2 AND mapping_id=$3 AND warehouse_id=$4 FOR UPDATE`,
        [context.tenantId,connectionId,mappingId,warehouseId]);
      const listing=existing.rows[0]
        ?await client.query<{id:string}>(`UPDATE channel_stock_listing
          SET external_warehouse_id=$5,priority=$6,enabled=$7,publish_enabled=$8,
              status=CASE WHEN $8 THEN 'ACTIVE' ELSE 'PAUSED' END,updated_at=now()
          WHERE tenant_id=$1 AND connection_id=$2 AND mapping_id=$3 AND warehouse_id=$4 RETURNING id`,
          [context.tenantId,connectionId,mappingId,warehouseId,external,priority,
            input.enabled!==false,input.publishEnabled===true])
        :await client.query<{id:string}>(`INSERT INTO channel_stock_listing(
          tenant_id,connection_id,mapping_id,warehouse_id,sku_id,
          external_warehouse_id,priority,enabled,publish_enabled,status,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [context.tenantId,connectionId,mappingId,warehouseId,row.sku_id,external,priority,
            input.enabled!==false,input.publishEnabled===true,
            input.publishEnabled===true?"ACTIVE":"SETUP",context.membershipId]);
      await client.query(`INSERT INTO channel_stock_target(tenant_id,listing_id,status)
        VALUES($1,$2,'PAUSED') ON CONFLICT(tenant_id,listing_id) DO NOTHING`,
        [context.tenantId,listing.rows[0]!.id]);
      await client.query(`INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
        VALUES($1,$2,$3) ON CONFLICT(tenant_id,warehouse_id,sku_id)
        DO UPDATE SET queued_at=now()`,[context.tenantId,warehouseId,row.sku_id]);
      return {listingId:listing.rows[0]!.id,publishEnabled:input.publishEnabled===true,
        warning:"После публикации проверьте фактические остатки в кабинете площадки. API может применять изменения с задержкой."};
    });
  }

  async queueFullReconcile(context:TenantContext){
    return this.database.withTenantTransaction(context,async client=>{
      const res=await client.query(`INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
        SELECT DISTINCT tenant_id,warehouse_id,sku_id
        FROM channel_stock_listing WHERE tenant_id=$1
        ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now()`,
        [context.tenantId]);
      return {queuedPools:res.rowCount??0};
    });
  }
}
