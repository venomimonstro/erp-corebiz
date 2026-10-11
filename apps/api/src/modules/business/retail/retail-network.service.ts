import {
  BadRequestException, ConflictException, Injectable, NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";
import { SalesService } from "../sales/sales.service";
import {sealMerchantSecret} from "../../platform/payments/yookassa.gateway";

type OrderLine={skuId:string;quantityMilli:string};
type OrderInput={
  locationId:string;partyId?:string;idempotencyKey:string;
  channel:"COUNTER"|"CLICK_COLLECT";lines:OrderLine[];
};

function validUuidLike(value:unknown):value is string{
  return typeof value==="string"&&
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
}
function validImei(value:string):boolean{
  if(!/^\d{15}$/.test(value))return false;
  let sum=0;
  for(let i=0;i<15;i++){
    let digit=Number(value[i]);
    if(i%2===1){digit*=2;if(digit>9)digit-=9;}
    sum+=digit;
  }
  return sum%10===0;
}

@Injectable()
export class RetailNetworkService {
  constructor(
    private readonly db:DatabaseService,
    private readonly auth:AuthorizationService,
    private readonly sales:SalesService
  ){}

  private async permit(ctx:TenantContext,code:string){
    const scope=await this.auth.resolveScope(ctx,code);
    if(!scope)throw new BadRequestException("Недостаточно прав для "+code);
    return scope;
  }

  async locations(ctx:TenantContext){
    await this.permit(ctx,"inventory.read");
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        `SELECT l.id,l.code,l.name,l.address,l.pickup_enabled,
           l.status,l.branch_id,l.warehouse_id,w.name AS warehouse_name,
           (SELECT sh.id FROM retail_cash_shift sh
            WHERE sh.tenant_id=l.tenant_id AND sh.location_id=l.id
              AND sh.status='OPEN' LIMIT 1) AS open_shift_id,
           coalesce(sum(b.physical_milli),0)::text AS physical_milli,
           coalesce(sum(b.reserved_milli),0)::text AS reserved_milli,
           coalesce(sum(b.physical_milli-b.reserved_milli),0)::text AS available_milli
         FROM retail_location l
         JOIN warehouse w ON w.tenant_id=l.tenant_id AND w.id=l.warehouse_id
         LEFT JOIN inventory_balance b
           ON b.tenant_id=w.tenant_id AND b.warehouse_id=w.id
         WHERE l.tenant_id=$1
         GROUP BY l.id,w.name
         ORDER BY l.created_at,l.name`,
        [ctx.tenantId]);
      return r.rows;
    });
  }

  async createLocation(ctx:TenantContext,input:{
    code:string;name:string;address?:string;pickupEnabled?:boolean;
  }){
    await this.permit(ctx,"organization.write");
    await this.permit(ctx,"inventory.write");
    const name=input?.name?.trim();
    const code=input?.code?.trim().toUpperCase();
    if(!name||name.length<2||name.length>160 ||
      !code||!/^[A-Z0-9_-]{2,34}$/.test(code)){
      throw new BadRequestException("Название и код магазина некорректны");
    }
    const address=input.address?.trim()||null;
    if(address&&address.length>500)
      throw new BadRequestException("Адрес слишком длинный");
    if(input.pickupEnabled!==undefined&&typeof input.pickupEnabled!=="boolean")
      throw new BadRequestException("Некорректное значение самовывоза");
    return this.db.withTenantTransaction(ctx,async client=>{
      const existing=await client.query(
        "SELECT 1 FROM retail_location WHERE tenant_id=$1 AND code=$2",
        [ctx.tenantId,code]);
      if(existing.rowCount)throw new ConflictException("Точка с таким кодом уже существует");
      // One transaction: never leave a branch without its stock bucket.
      const branch=await client.query<{id:string}>(
        "INSERT INTO branch(tenant_id,name) VALUES($1,$2) RETURNING id",
        [ctx.tenantId,name]);
      const warehouse=await client.query<{id:string}>(
        `INSERT INTO warehouse(tenant_id,branch_id,name,code)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [ctx.tenantId,branch.rows[0]!.id,name+" · склад",code+"-STOCK"]);
      const result=await client.query(
        `INSERT INTO retail_location(
          tenant_id,branch_id,warehouse_id,code,name,address,pickup_enabled
        ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.tenantId,branch.rows[0]!.id,warehouse.rows[0]!.id,
          code,name,address,input.pickupEnabled??true]);
      await client.query(
        `INSERT INTO audit_event(
          tenant_id,actor_user_id,actor_membership_id,action,resource_type,
          resource_id,after_data
        ) VALUES($1,$2,$3,'retail.location_created','retail_location',$4,$5)`,
        [ctx.tenantId,ctx.userId,ctx.membershipId,result.rows[0].id,
          JSON.stringify({code,warehouseId:warehouse.rows[0]!.id})]);
      return result.rows[0];
    });
  }

  async locationStock(ctx:TenantContext,locationId:string,search=""){
    await this.permit(ctx,"inventory.read");
    this.uuid(locationId);
    if(search.length>100)throw new BadRequestException("Поиск слишком длинный");
    return this.db.withTenantTransaction(ctx,async client=>{
      const result=await client.query(
        `SELECT s.id AS sku_id,s.code AS sku_code,p.name AS product_name,
           b.physical_milli::text,b.reserved_milli::text,
           (b.physical_milli-b.reserved_milli)::text AS available_milli,
           (CASE WHEN coalesce(ip.enabled,true)=false THEN 0
             ELSE greatest(0,b.physical_milli-b.reserved_milli-
               coalesce(ip.safety_stock_milli,0)) END)::text AS sellable_milli
         FROM retail_location l
         JOIN inventory_balance b ON b.tenant_id=l.tenant_id
           AND b.warehouse_id=l.warehouse_id
         LEFT JOIN inventory_policy ip ON ip.tenant_id=b.tenant_id
           AND ip.warehouse_id=b.warehouse_id AND ip.sku_id=b.sku_id
         JOIN sku s ON s.tenant_id=b.tenant_id AND s.id=b.sku_id
         JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE l.tenant_id=$1 AND l.id=$2 AND l.status='ACTIVE'
           AND ($3::text='' OR s.code ILIKE '%'||$3||'%'
                        OR p.name ILIKE '%'||$3||'%')
         ORDER BY p.name,s.code LIMIT 200`,
        [ctx.tenantId,locationId,search.trim()]);
      return result.rows;
    });
  }

  async orders(ctx:TenantContext,locationId:string){
    await this.permit(ctx,"sales.read");
    this.uuid(locationId);
    return this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query(
        `SELECT r.id,r.channel,r.created_at,o.id AS order_id,
           o.business_number,o.order_status,o.fulfillment_status,
           o.payment_status,o.total_minor::text AS total_minor,
           p.display_name AS customer_name
         FROM retail_order_link r
         JOIN sales_order o ON o.tenant_id=r.tenant_id AND o.id=r.sales_order_id
         LEFT JOIN party p ON p.tenant_id=o.tenant_id AND p.id=o.party_id
         WHERE r.tenant_id=$1 AND r.location_id=$2
           AND (
             o.responsible_membership_id=$3 OR EXISTS(
               SELECT 1 FROM membership_role mr JOIN role_permission rp
                 ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
               WHERE mr.tenant_id=$1 AND mr.membership_id=$3
                 AND (rp.permission_code='*' OR
                   (rp.permission_code='sales.read' AND rp.scope='all'))
             )
           )
         ORDER BY r.created_at DESC LIMIT 100`,
        [ctx.tenantId,locationId,ctx.membershipId]);
      return r.rows;
    });
  }

  private uuid(s:string){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s))
      throw new BadRequestException("Некорректный идентификатор");
  }

  async reserve(ctx:TenantContext,input:OrderInput){
    await this.permit(ctx,"sales.write");
    if(!input || typeof input!=="object")
      throw new BadRequestException("Некорректные параметры заказа");
    this.uuid(input.locationId);
    const key=input.idempotencyKey?.trim();
    if(!key||key.length<8||key.length>110)
      throw new BadRequestException("Требуется ключ операции (8–128 символов)");
    if(!["COUNTER","CLICK_COLLECT"].includes(input.channel))
      throw new BadRequestException("Неизвестный канал");
    if(!Array.isArray(input.lines)||input.lines.length<1||input.lines.length>100)
      throw new BadRequestException("Укажите от 1 до 100 товаров");
    for(const l of input.lines){
      if(!l || typeof l!=="object" || typeof l.quantityMilli!=="string")
        throw new BadRequestException("Некорректная позиция заказа");
      this.uuid(l.skuId);
      if(!/^\d+$/.test(l.quantityMilli)||
        BigInt(l.quantityMilli)<=0n||BigInt(l.quantityMilli)>1000000000n)
        throw new BadRequestException("Некорректное количество товара");
    }
    if(input.partyId!==undefined)this.uuid(input.partyId);
    const loc=await this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query<{id:string;warehouse_id:string;pickup_enabled:boolean}>(
        `SELECT l.id,l.warehouse_id,l.pickup_enabled
         FROM retail_location l JOIN warehouse w
           ON w.tenant_id=l.tenant_id AND w.id=l.warehouse_id
         WHERE l.tenant_id=$1 AND l.id=$2 AND l.status='ACTIVE'
           AND w.status='ACTIVE'`,[ctx.tenantId,input.locationId]);
      return r.rows[0];
    });
    if(!loc)throw new NotFoundException("Торговая точка недоступна");
    const validPrices=await this.db.withTenantTransaction(ctx,async client=>
      client.query<{count:number}>(
        `SELECT count(DISTINCT s.id)::integer AS count
         FROM sku s JOIN product_variant v
           ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE s.tenant_id=$1 AND s.id=ANY($2::uuid[])
           AND s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
           AND s.currency='RUB' AND s.sale_price_minor>0
           AND s.track_inventory=true`,
        [ctx.tenantId,Array.from(new Set(input.lines.map(l=>l.skuId)))]
      ));
    if((validPrices.rows[0]?.count??0)!==
       new Set(input.lines.map(l=>l.skuId)).size)
      throw new ConflictException("Для розничного резерва нужны активные SKU с ценой и складским учётом");
    if(input.channel==="CLICK_COLLECT"&&!loc.pickup_enabled)
      throw new ConflictException("Самовывоз из этой точки недоступен");
    if(input.channel==="COUNTER"){
      const shift=await this.db.withTenantTransaction(ctx,async client=>
        client.query(
          `SELECT 1 FROM retail_cash_shift WHERE tenant_id=$1
           AND location_id=$2 AND status='OPEN'`,
          [ctx.tenantId,input.locationId]));
      if(!shift.rowCount)throw new ConflictException(
        "Перед работой на кассе откройте смену в торговой точке"
      );
    }
    const normalized={
      locationId:input.locationId,channel:input.channel,
      partyId:input.partyId??null,
      lines:input.lines.map(l=>({skuId:l.skuId,quantityMilli:BigInt(l.quantityMilli).toString()}))
    };
    const fingerprint=createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const scopedKey="retail:"+input.locationId+":"+key;
    // Sales order already has a deterministic idempotency fingerprint.
    // Every retry uses the same scope/lines, even after a process crash.
    const order=await this.sales.create(ctx,{
      partyId:input.partyId,currency:"RUB",
      notes:input.channel==="COUNTER"?"Продажа в торговой точке, оплата ожидается":
        "Самовывоз из торговой точки, оплата ожидается",
      idempotencyKey:scopedKey,
      lines:input.lines
    });
    const state=await this.db.withTenantTransaction(ctx,async client=>{
      const r=await client.query<{order_status:string;version:number;warehouse_id:string|null}>(
        `SELECT order_status,version,warehouse_id FROM sales_order
         WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,order.id]);
      return r.rows[0];
    });
    if(!state)throw new ConflictException("Созданный заказ недоступен");
    if(state.warehouse_id&&state.warehouse_id!==loc.warehouse_id)
      throw new ConflictException("Заказ уже закреплён за другим складом");
    if(state.order_status==="DRAFT")
      await this.sales.confirm(ctx,order.id,state.version);
    else if(state.order_status!=="CONFIRMED")
      throw new ConflictException("Заказ нельзя резервировать в данном статусе");
    await this.sales.reserve(ctx,order.id,"retail-reserve:"+order.id,loc.warehouse_id);
    await this.db.withTenantTransaction(ctx,async client=>{
      const prior=await client.query<{fingerprint:string;location_id:string}>(
        `SELECT fingerprint,location_id FROM retail_order_link
         WHERE tenant_id=$1 AND sales_order_id=$2 FOR UPDATE`,
        [ctx.tenantId,order.id]);
      if(prior.rows[0] && (
        prior.rows[0].fingerprint!==fingerprint||
        prior.rows[0].location_id!==input.locationId))
        throw new ConflictException("Заказ уже связан с другим оформлением");
      if(!prior.rows[0])await client.query(
        `INSERT INTO retail_order_link(
           tenant_id,location_id,sales_order_id,channel,idempotency_key,
           fingerprint,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.tenantId,input.locationId,order.id,input.channel,
          scopedKey,fingerprint,ctx.membershipId]);
    });
    return {
      orderId:order.id,orderNumber:order.number,warehouseId:loc.warehouse_id,
      status:"RESERVED_AWAITING_PAYMENT",
      notice:"Склад зарезервирован. Оплату и фискальный чек необходимо провести и подтвердить отдельно."
    };
  }

  async serialized(ctx:TenantContext,locationId:string){
    await this.permit(ctx,"inventory.read");
    this.uuid(locationId);
    return this.db.withTenantTransaction(ctx,async client=>{
      const location=await client.query(
        "SELECT 1 FROM retail_location WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId,locationId]);
      if(!location.rowCount)throw new NotFoundException("Торговая точка не найдена");
      const r=await client.query(
        `SELECT u.id,u.sku_id,u.serial_number,u.imei,u.gtin,
           u.marking_product_group,u.marking_state,u.stock_state,
           (u.marking_code_hash IS NOT NULL) AS marking_code_present,
           u.created_at,s.code AS sku_code
         FROM retail_serial_unit u
         JOIN sku s ON s.tenant_id=u.tenant_id AND s.id=u.sku_id
         WHERE u.tenant_id=$1 AND u.location_id=$2
         ORDER BY u.created_at DESC LIMIT 200`,
        [ctx.tenantId,locationId]);
      return r.rows;
    });
  }

  async registerSerialized(ctx:TenantContext,locationId:string,input:{
    skuId:string;serialNumber:string;imei?:string;
    gtin?:string;markingProductGroup?:string;markingCode?:string
  }){
    await this.permit(ctx,"inventory.write");
    this.uuid(locationId);
    if(!input||typeof input!=="object"||!validUuidLike(input.skuId))
      throw new BadRequestException("Укажите SKU товара");
    const serial=typeof input.serialNumber==="string"
      ?input.serialNumber.trim().toUpperCase():"";
    if(!/^[A-Z0-9._/-]{4,100}$/.test(serial))
      throw new BadRequestException("Некорректный серийный номер");
    const imei=input.imei?.trim()||null;
    if(imei && !validImei(imei))
      throw new BadRequestException("IMEI должен состоять из 15 цифр с корректной контрольной суммой");
    const gtin=input.gtin?.trim()||null;
    if(gtin&&!/^\d{14}$/.test(gtin))
      throw new BadRequestException("GTIN должен содержать 14 цифр");
    const code=input.markingCode??null;
    if(code!==null && (
      typeof code!=="string"||code.length<15||code.length>512
    ))throw new BadRequestException("Некорректный код маркировки");
    const group=input.markingProductGroup?.trim()||null;
    if(group&&group.length>80)
      throw new BadRequestException("Слишком длинный код товарной группы");
    if(code!==null && (!gtin||!group))
      throw new BadRequestException("Для Data Matrix укажите GTIN и товарную группу");
    const ciphertext=code?sealMerchantSecret(code):null;
    const hash=code?createHash("sha256").update(code).digest("hex"):null;
    return this.db.withTenantTransaction(ctx,async client=>{
      const loc=await client.query<{warehouse_id:string}>(
        `SELECT warehouse_id FROM retail_location
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [ctx.tenantId,locationId]);
      const wh=loc.rows[0]?.warehouse_id;
      if(!wh)throw new NotFoundException("Точка не найдена");
      const balance=await client.query<{physical_milli:string}>(
        `SELECT physical_milli::text FROM inventory_balance
         WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3 FOR UPDATE`,
        [ctx.tenantId,wh,input.skuId]);
      if(!balance.rows[0]||BigInt(balance.rows[0].physical_milli)<1000n)
        throw new ConflictException("Для серийного товара требуется подтверждённый приход");
      const count=await client.query<{count:string}>(
        `SELECT count(*)::text AS count FROM retail_serial_unit
         WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3
           AND stock_state IN ('REGISTERED','RESERVED','RETURNED')`,
        [ctx.tenantId,wh,input.skuId]);
      if((BigInt(count.rows[0]?.count??"0")+1n)*1000n >
         BigInt(balance.rows[0].physical_milli))
        throw new ConflictException("Серийных единиц больше, чем фактический складской остаток");
      const result=await client.query<{id:string;serial_number:string}>(
        `INSERT INTO retail_serial_unit(
          tenant_id,location_id,warehouse_id,sku_id,serial_number,imei,gtin,
          marking_product_group,marking_code_hash,marking_code_ciphertext,
          created_by_membership_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id,serial_number`,
        [ctx.tenantId,locationId,wh,input.skuId,serial,imei,gtin,group,hash,
          ciphertext,ctx.membershipId]);
      return {id:result.rows[0]!.id,serialNumber:serial,imei,gtin,
        markingCodePresent:Boolean(code),markingState:"NOT_CHECKED",
        warning:"Этот регистр не подтверждает проверку ГИС МТ или выбытие товара."};
    });
  }

  async shift(ctx:TenantContext,locationId:string,action:"OPEN"|"CLOSE",
    openingCashMinor?:string,closingCashMinor?:string){
    await this.permit(ctx,"finance.write");
    this.uuid(locationId);
    const raw=action==="OPEN"?openingCashMinor??"0":closingCashMinor;
    if(!raw||!/^\d+$/.test(raw)||BigInt(raw)>1000000000000n)
      throw new BadRequestException("Некорректная сумма наличных");
    return this.db.withTenantTransaction(ctx,async client=>{
      const loc=await client.query(
        `SELECT 1 FROM retail_location
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [ctx.tenantId,locationId]);
      if(!loc.rowCount)throw new NotFoundException("Точка недоступна");
      if(action==="OPEN"){
        const prior=await client.query(
          `SELECT 1 FROM retail_cash_shift WHERE tenant_id=$1
           AND location_id=$2 AND status='OPEN' FOR UPDATE`,
          [ctx.tenantId,locationId]);
        if(prior.rowCount)throw new ConflictException("В этой точке уже открыта смена");
        const r=await client.query(
          `INSERT INTO retail_cash_shift(
             tenant_id,location_id,opened_by_membership_id,opening_cash_minor
           ) VALUES($1,$2,$3,$4) RETURNING *`,
          [ctx.tenantId,locationId,ctx.membershipId,raw]);
        return r.rows[0];
      }
      const r=await client.query(
        `UPDATE retail_cash_shift SET status='CLOSED',
           closing_cash_minor=$3,closed_by_membership_id=$4,closed_at=now()
         WHERE tenant_id=$1 AND location_id=$2 AND status='OPEN'
         RETURNING *`,
        [ctx.tenantId,locationId,raw,ctx.membershipId]);
      if(!r.rows[0])throw new ConflictException("Нет открытой смены");
      return r.rows[0];
    });
  }
}