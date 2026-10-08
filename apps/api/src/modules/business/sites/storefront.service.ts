import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { PartyService } from "../party/party.service";
import { SalesService } from "../sales/sales.service";

@Injectable()
export class StorefrontService {
  constructor(
    private readonly database: DatabaseService,
    private readonly parties: PartyService,
    private readonly sales: SalesService
  ) {}

  async configure(
    context:TenantContext,
    siteId:string,
    input:{enabled?:boolean;responsibleMembershipId?:string;currency?:string}
  ):Promise<void>{
    const responsible=input.responsibleMembershipId??context.membershipId;
    const currency=(input.currency??"RUB").trim().toUpperCase();
    if(!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException("Некорректная валюта");

    await this.database.withTenantTransaction(context,async client=>{
      const site=await client.query(
        `SELECT 1 FROM site WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,siteId]
      );
      if(!site.rowCount) throw new NotFoundException("Сайт не найден");
      const member=await client.query(
        `SELECT 1 FROM tenant_membership WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,responsible]
      );
      if(!member.rowCount) throw new NotFoundException("Ответственный недоступен");

      await client.query(
        `INSERT INTO storefront_config(
           site_id,tenant_id,enabled,responsible_membership_id,currency
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (site_id)
         DO UPDATE SET
           enabled=EXCLUDED.enabled,
           responsible_membership_id=EXCLUDED.responsible_membership_id,
           currency=EXCLUDED.currency,
           updated_at=now()`,
        [siteId,context.tenantId,input.enabled??true,responsible,currency]
      );
    });
  }

  async catalog(siteCode:string):Promise<Record<string,unknown>>{
    const sf=await this.resolveStorefront(siteCode);
    return this.database.withTenantTransaction(
      this.systemContext(sf.tenant_id),
      async client=>{
        const products=await client.query(
          `SELECT
             p.id AS product_id,p.name AS product_name,p.description,
             s.id AS sku_id,s.code AS sku_code,s.barcode,
             s.sale_price_minor::text,s.currency,
             COALESCE(sum(
               GREATEST(
                 COALESCE(b.physical_milli,0)-COALESCE(b.reserved_milli,0)-COALESCE(ip.safety_stock_milli,0),
                 0
               )
             ),0)::text AS atp_milli
           FROM product p
           JOIN product_variant v
             ON v.tenant_id=p.tenant_id AND v.product_id=p.id AND v.status='ACTIVE'
           JOIN sku s
             ON s.tenant_id=v.tenant_id AND s.variant_id=v.id AND s.status='ACTIVE'
           LEFT JOIN inventory_balance b
             ON b.tenant_id=s.tenant_id AND b.sku_id=s.id
           LEFT JOIN inventory_policy ip
             ON ip.tenant_id=b.tenant_id AND ip.warehouse_id=b.warehouse_id AND ip.sku_id=b.sku_id
           WHERE p.tenant_id=$1
             AND p.status='ACTIVE'
           GROUP BY p.id,s.id
           ORDER BY p.updated_at DESC,p.name,s.code
           LIMIT 1000`,
          [sf.tenant_id]
        );
        return {siteId:sf.site_id,currency:sf.currency,products:products.rows};
      }
    );
  }

  async createCart(siteCode:string):Promise<{cartKey:string}>{
    const sf=await this.resolveStorefront(siteCode);
    const cartKey="cart_"+randomBytes(24).toString("base64url");
    await this.database.withTenantTransaction(
      this.systemContext(sf.tenant_id),
      async client=>{
        await client.query(
          `INSERT INTO storefront_cart(tenant_id,site_id,public_key)
           VALUES ($1,$2,$3)`,
          [sf.tenant_id,sf.site_id,cartKey]
        );
      }
    );
    return {cartKey};
  }

  async cart(cartKey:string):Promise<Record<string,unknown>>{
    const cart=await this.resolveCart(cartKey);
    return this.database.withTenantTransaction(
      this.systemContext(cart.tenant_id),
      async client=>{
        const lines=await client.query(
          `SELECT
             l.sku_id,s.code AS sku_code,p.name AS product_name,
             l.quantity_milli::text,
             s.sale_price_minor::text,s.currency,
             ((s.sale_price_minor*l.quantity_milli+500)/1000)::text AS line_total_minor
           FROM storefront_cart_line l
           JOIN sku s ON s.tenant_id=l.tenant_id AND s.id=l.sku_id AND s.status='ACTIVE'
           JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
           JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id AND p.status='ACTIVE'
           WHERE l.tenant_id=$1 AND l.cart_id=$2
           ORDER BY l.created_at`,
          [cart.tenant_id,cart.cart_id]
        );
        return {
          cartKey,
          status:cart.status,
          lines:lines.rows,
          totalMinor:lines.rows.reduce((s:any,r:any)=>s+BigInt(r.line_total_minor),0n).toString()
        };
      }
    );
  }

  async setLine(
    cartKey:string,
    input:{skuId:string;quantityMilli:string}
  ):Promise<Record<string,unknown>>{
    if(!/^\d+$/.test(input.quantityMilli)){
      throw new BadRequestException("Некорректное количество");
    }
    const quantity=BigInt(input.quantityMilli);
    const cart=await this.resolveCart(cartKey);
    if(cart.status!=="OPEN"||new Date(cart.expires_at)<new Date()){
      throw new ConflictException("Корзина закрыта или истекла");
    }

    await this.database.withTenantTransaction(
      this.systemContext(cart.tenant_id),
      async client=>{
        const sku=await client.query(
          `SELECT 1 FROM sku s
           JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
           JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
           WHERE s.tenant_id=$1 AND s.id=$2
             AND s.status='ACTIVE' AND p.status='ACTIVE'`,
          [cart.tenant_id,input.skuId]
        );
        if(!sku.rowCount) throw new NotFoundException("Товар недоступен");

        if(quantity===0n){
          await client.query(
            `DELETE FROM storefront_cart_line
             WHERE tenant_id=$1 AND cart_id=$2 AND sku_id=$3`,
            [cart.tenant_id,cart.cart_id,input.skuId]
          );
        }else{
          if(quantity>1000000000n) throw new BadRequestException("Слишком большое количество");
          await client.query(
            `INSERT INTO storefront_cart_line(
               tenant_id,cart_id,sku_id,quantity_milli
             ) VALUES ($1,$2,$3,$4)
             ON CONFLICT (cart_id,sku_id)
             DO UPDATE SET quantity_milli=EXCLUDED.quantity_milli,updated_at=now()`,
            [cart.tenant_id,cart.cart_id,input.skuId,quantity.toString()]
          );
        }
      }
    );

    return this.cart(cartKey);
  }

  async checkout(
    cartKey:string,
    input:{
      idempotencyKey:string;
      name:string;
      phone?:string;
      email?:string;
      comment?:string;
    }
  ):Promise<Record<string,unknown>>{
    if(!input.idempotencyKey?.trim()||input.idempotencyKey.length>160){
      throw new BadRequestException("Требуется idempotencyKey");
    }

    const cart=await this.resolveCart(cartKey);
    if(cart.status==="CHECKED_OUT"&&cart.sales_order_id){
      return {accepted:true,salesOrderId:cart.sales_order_id,reused:true};
    }
    if(cart.status!=="OPEN"||new Date(cart.expires_at)<new Date()){
      throw new ConflictException("Корзина закрыта или истекла");
    }

    const sf=await this.database.query<{
      responsible_membership_id:string;
      currency:string;
    }>(
      `SELECT responsible_membership_id,currency
       FROM storefront_config
       WHERE tenant_id=$1 AND site_id=$2 AND enabled=true`,
      [cart.tenant_id,cart.site_id]
    );
    const config=sf.rows[0];
    if(!config) throw new NotFoundException("Магазин отключён");

    const actor=await this.database.withTenantTransaction(
      this.systemContext(cart.tenant_id),
      async client=>(await client.query<{user_id:string}>(
        `SELECT user_id FROM tenant_membership
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [cart.tenant_id,config.responsible_membership_id]
      )).rows[0]??null
    );
    if(!actor) throw new ConflictException("Ответственный магазина недоступен");

    const context:TenantContext={
      tenantId:cart.tenant_id,
      userId:actor.user_id,
      membershipId:config.responsible_membership_id
    };

    const lines=await this.database.withTenantTransaction(
      this.systemContext(cart.tenant_id),
      async client=>(await client.query<{
        sku_id:string;quantity_milli:string;
      }>(
        `SELECT sku_id,quantity_milli::text
         FROM storefront_cart_line
         WHERE tenant_id=$1 AND cart_id=$2
         ORDER BY created_at`,
        [cart.tenant_id,cart.cart_id]
      )).rows
    );

    if(!lines.length) throw new BadRequestException("Корзина пуста");

    const customer=await this.parties.create(context,{
      displayName:input.name,
      ...(input.phone?.trim()?{phone:input.phone.trim()}:{}),
      ...(input.email?.trim()?{email:input.email.trim()}:{}),
      responsibleMembershipId:config.responsible_membership_id
    });

    const order=await this.sales.create(context,{
      partyId:customer.id,
      responsibleMembershipId:config.responsible_membership_id,
      currency:config.currency,
      notes:input.comment?.trim()||"Заказ с сайта",
      idempotencyKey:"storefront:"+cart.cart_id+":"+input.idempotencyKey.trim(),
      lines:lines.map(line=>({
        skuId:line.sku_id,
        quantityMilli:line.quantity_milli
      }))
    });

    const confirmed=await this.sales.confirm(context,order.id,order.version);

    await this.database.withTenantTransaction(
      context,
      async client=>{
        await client.query(
          `UPDATE storefront_cart
           SET status='CHECKED_OUT',sales_order_id=$3,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [cart.tenant_id,cart.cart_id,order.id]
        );
      }
    );

    return {
      accepted:true,
      salesOrderId:order.id,
      number:order.number,
      orderStatus:confirmed.orderStatus
    };
  }

  private async resolveStorefront(siteCode:string):Promise<{
    site_id:string;tenant_id:string;responsible_membership_id:string;currency:string;
  }>{
    const result=await this.database.query<any>(
      "SELECT * FROM corebiz_resolve_public_storefront($1)",
      [siteCode]
    );
    if(!result.rows[0]) throw new NotFoundException("Магазин не найден");
    return result.rows[0];
  }

  private async resolveCart(cartKey:string):Promise<{
    cart_id:string;tenant_id:string;site_id:string;status:string;expires_at:Date;sales_order_id:string|null;
  }>{
    const publicResult=await this.database.query<{
      cart_id:string;tenant_id:string;site_id:string;status:string;expires_at:Date;
    }>(
      "SELECT * FROM corebiz_resolve_public_cart($1)",
      [cartKey]
    );
    const resolved=publicResult.rows[0];
    if(!resolved) throw new NotFoundException("Корзина не найдена");

    const row=await this.database.withTenantTransaction(
      this.systemContext(resolved.tenant_id),
      async client=>(await client.query<{sales_order_id:string|null}>(
        `SELECT sales_order_id
         FROM storefront_cart
         WHERE tenant_id=$1 AND id=$2`,
        [resolved.tenant_id,resolved.cart_id]
      )).rows[0]??null
    );

    return {
      ...resolved,
      sales_order_id:row?.sales_order_id??null
    };
  }

  private systemContext(tenantId:string):TenantContext{
    return {
      tenantId,
      userId:"00000000-0000-0000-0000-000000000000",
      membershipId:"00000000-0000-0000-0000-000000000000"
    };
  }
}
