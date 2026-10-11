import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {PoolClient} from "pg";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class CatalogService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext): Promise<Array<{
    productId: string;
    productName: string;
    imageUrl: string | null;
    kind: string;
    variantId: string;
    variantName: string;
    skuId: string;
    sku: string;
    barcode: string | null;
    salePriceMinor: string;
    costPriceMinor: string | null;
    currency: string;
    trackInventory: boolean;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const canReadCost=await this.mayReadCost(client,context);
      const result = await client.query<{
        product_id: string;
        product_name: string;
        image_url: string | null;
        kind: string;
        variant_id: string;
        variant_name: string;
        sku_id: string;
        sku_code: string;
        barcode: string | null;
        sale_price_minor: string;
        cost_price_minor: string;
        currency: string;
        track_inventory: boolean;
      }>(
        `SELECT
           p.id AS product_id,
           p.name AS product_name,
           p.image_url,
           p.kind,
           v.id AS variant_id,
           v.name AS variant_name,
           s.id AS sku_id,
           s.code AS sku_code,
           s.barcode,
           s.sale_price_minor::text,
           s.cost_price_minor::text,
           s.currency,
           s.track_inventory
         FROM product p
         JOIN product_variant v
           ON v.tenant_id = p.tenant_id
          AND v.product_id = p.id
          AND v.status = 'ACTIVE'
         JOIN sku s
           ON s.tenant_id = v.tenant_id
          AND s.variant_id = v.id
          AND s.status = 'ACTIVE'
         WHERE p.tenant_id = $1
           AND p.status = 'ACTIVE'
         ORDER BY p.updated_at DESC, v.created_at ASC
         LIMIT 1000`,
        [context.tenantId]
      );

      return result.rows.map((row) => ({
        productId: row.product_id,
        productName: row.product_name,
        imageUrl: row.image_url,
        kind: row.kind,
        variantId: row.variant_id,
        variantName: row.variant_name,
        skuId: row.sku_id,
        sku: row.sku_code,
        barcode: row.barcode,
        salePriceMinor: row.sale_price_minor,
        costPriceMinor: canReadCost?row.cost_price_minor:null,
        currency: row.currency,
        trackInventory: row.track_inventory
      }));
    });
  }


  /**
   * Keyset pagination for large catalogs. No OFFSET scans, no COUNT(*),
   * and no accidental cross-tenant or unbounded payloads.
   */
  async page(
    context:TenantContext,
    input:{limit?:number;cursor?:string;query?:string}
  ){
    const limit=input.limit??100;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)
      throw new BadRequestException("Размер страницы: от 1 до 200 товаров");
    const cursor=input.cursor?.trim()||null;
    if(cursor&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor))
      throw new BadRequestException("Неверный курсор страницы каталога");
    const query=input.query?.trim()??"";
    const safeQuery=query.replace(/[\\%_]/g,"\\$&");
    if(query.length>100||(query.length>0&&query.length<3))
      throw new BadRequestException("Для поиска укажите от 3 до 100 символов");
    return this.database.withTenantTransaction(context,async client=>{
      const canReadCost=await this.mayReadCost(client,context);
      const result=await client.query<{
        product_id:string;product_name:string;image_url:string|null;kind:string;
        variant_id:string;variant_name:string;sku_id:string;
        sku_code:string;barcode:string|null;sale_price_minor:string;
        cost_price_minor:string;currency:string;track_inventory:boolean;
      }>(
        `SELECT p.id AS product_id,p.name AS product_name,p.image_url,p.kind,
          v.id AS variant_id,v.name AS variant_name,
          s.id AS sku_id,s.code AS sku_code,s.barcode,
          s.sale_price_minor::text,s.cost_price_minor::text,
          s.currency,s.track_inventory
         FROM sku s
         JOIN product_variant v ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
         JOIN product p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE s.tenant_id=$1 AND s.status='ACTIVE'
           AND v.status='ACTIVE' AND p.status='ACTIVE'
           AND ($2::uuid IS NULL OR s.id>$2::uuid)
           AND ($3::text IS NULL OR s.code ILIKE '%'||$3||'%'
             OR coalesce(s.barcode,'') ILIKE '%'||$3||'%'
             OR p.name ILIKE '%'||$3||'%')
         ORDER BY s.id
         LIMIT $4`,
        [context.tenantId,cursor,safeQuery||null,limit+1]
      );
      const hasMore=result.rows.length>limit;
      const rows=result.rows.slice(0,limit);
      return {
        items:rows.map(row=>({
          productId:row.product_id,productName:row.product_name,
          imageUrl:row.image_url,kind:row.kind,
          variantId:row.variant_id,variantName:row.variant_name,
          skuId:row.sku_id,sku:row.sku_code,barcode:row.barcode,
          salePriceMinor:row.sale_price_minor,
          costPriceMinor:canReadCost?row.cost_price_minor:null,
          currency:row.currency,trackInventory:row.track_inventory
        })),
        hasMore,
        nextCursor:hasMore?rows[rows.length-1]?.sku_id??null:null
      };
    });
  }

  private async mayReadCost(client:PoolClient,context:TenantContext):Promise<boolean>{
    const result=await client.query<{allowed:boolean}>(
      `SELECT EXISTS(
        SELECT 1 FROM membership_role mr
        JOIN role_permission rp ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
        WHERE mr.tenant_id=$1 AND mr.membership_id=$2
          AND rp.scope='all'
          AND rp.permission_code IN ('*','finance.read','catalog.cost.read')
      ) AS allowed`,
      [context.tenantId,context.membershipId]
    );
    return result.rows[0]?.allowed===true;
  }

  async create(
    context: TenantContext,
    input: {
      name: string;
      kind?: "STOCKABLE" | "NON_STOCK";
      sku?: string;
      barcode?: string;
      salePriceMinor?: string;
      costPriceMinor?: string;
      categoryId?: string;
      description?: string;
      imageUrl?: string;
    }
  ): Promise<{ productId: string; variantId: string; skuId: string; sku: string }> {
    if(!input||typeof input.name!=="string")
      throw new BadRequestException("Укажите название товара");
    const name=input.name.trim();
    if(name.length<2||name.length>240)
      throw new BadRequestException("Некорректное название товара");
    if(input.kind!==undefined&&!["STOCKABLE","NON_STOCK"].includes(input.kind))
      throw new BadRequestException("Некорректный тип товара");

    const salePriceMinor=input.salePriceMinor??"0";
    const costPriceMinor=input.costPriceMinor??"0";
    // PostgreSQL bigint must never receive out-of-range user input.
    if(!/^\d{1,18}$/.test(salePriceMinor)||!/^\d{1,18}$/.test(costPriceMinor)||
       BigInt(salePriceMinor)>9223372036854775807n||
       BigInt(costPriceMinor)>9223372036854775807n)
      throw new BadRequestException("Некорректная цена");

    const imageUrl=this.validImageUrl(input.imageUrl);
    const skuCode=input.sku?.trim()||
      `SKU-${randomUUID().replaceAll("-","").slice(0,10).toUpperCase()}`;
    if(skuCode.length>128||skuCode.length===0||
       (input.barcode!==undefined&&input.barcode.trim().length>128)||
       (input.description!==undefined&&input.description.length>10000))
      throw new BadRequestException("Слишком длинный артикул, штрихкод или описание");

    return this.database.withTenantTransaction(context, async (client) => {
      // Catalog editors may set retail prices, but cost is a confidential
      // financial input. Check this at the trusted service boundary, not UI.
      if(BigInt(costPriceMinor)>0n && !await this.mayReadCost(client,context))
        throw new ForbiddenException("Для указания себестоимости требуются финансовые права");
      if (input.categoryId) {
        const category = await client.query(
          `SELECT 1 FROM catalog_category
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'ACTIVE'`,
          [context.tenantId, input.categoryId]
        );

        if (!category.rowCount) {
          throw new NotFoundException("Категория не найдена");
        }
      }

      const duplicate = await client.query(
        "SELECT 1 FROM sku WHERE tenant_id = $1 AND code = $2",
        [context.tenantId, skuCode]
      );

      if (duplicate.rowCount) {
        throw new BadRequestException("SKU уже используется");
      }

      const productResult = await client.query<{ id: string }>(
        `INSERT INTO product(
           tenant_id, category_id, name, kind, description, image_url
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          input.categoryId ?? null,
          name,
          input.kind ?? "STOCKABLE",
          input.description?.trim() || null,
          imageUrl
        ]
      );

      const product = productResult.rows[0];
      if (!product) throw new Error("PRODUCT_CREATE_FAILED");

      const variantResult = await client.query<{ id: string }>(
        `INSERT INTO product_variant(
           tenant_id, product_id, name
         ) VALUES ($1,$2,'Основной')
         RETURNING id`,
        [context.tenantId, product.id]
      );

      const variant = variantResult.rows[0];
      if (!variant) throw new Error("VARIANT_CREATE_FAILED");

      const skuResult = await client.query<{ id: string; code: string }>(
        `INSERT INTO sku(
           tenant_id, variant_id, code, barcode,
           sale_price_minor, cost_price_minor,
           track_inventory
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, code`,
        [
          context.tenantId,
          variant.id,
          skuCode,
          input.barcode?.trim() || null,
          salePriceMinor,
          costPriceMinor,
          (input.kind ?? "STOCKABLE") === "STOCKABLE"
        ]
      );

      const sku = skuResult.rows[0];
      if (!sku) throw new Error("SKU_CREATE_FAILED");

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id, after_data
         ) VALUES ($1,$2,$3,'catalog.product_created','product',$4,$5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          product.id,
          JSON.stringify({ name, sku: sku.code })
        ]
      );

      return {
        productId: product.id,
        variantId: variant.id,
        skuId: sku.id,
        sku: sku.code
      };
    });
  }
  /** Image links are only displayed by browsers; never server-side fetched. */
  private validImageUrl(value:unknown):string|null {
    if(value===undefined || value===null || value==="") return null;
    if(typeof value!=="string" || value.length>2048)
      throw new BadRequestException("Некорректная ссылка на изображение");
    const normalized=value.trim();
    if(!normalized)return null;
    try {
      const url=new URL(normalized);
      if(url.protocol!=="https:" || !url.hostname || url.username || url.password)
        throw new Error("INVALID_URL");
      return normalized;
    } catch {
      throw new BadRequestException("Изображение должно быть доступно по HTTPS");
    }
  }

  async updateImage(
    context:TenantContext,
    productId:string,
    input:{imageUrl?:string|null}
  ):Promise<{updated:true;imageUrl:string|null}> {
    if(!input || typeof input!=="object" || Array.isArray(input) ||
       !Object.prototype.hasOwnProperty.call(input,"imageUrl"))
      throw new BadRequestException("Укажите ссылку на изображение или null");
    const imageUrl=this.validImageUrl(input.imageUrl);
    return this.database.withTenantTransaction(context,async client=>{
      const updated=await client.query(
        `UPDATE product SET image_url=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
         RETURNING id`,
        [context.tenantId,productId,imageUrl]
      );
      if(!updated.rowCount)throw new NotFoundException("Товар не найден");
      await client.query(
        `INSERT INTO audit_event(tenant_id,actor_user_id,actor_membership_id,
          action,resource_type,resource_id,after_data)
         VALUES ($1,$2,$3,'catalog.product_image_updated','product',$4,$5)`,
        [context.tenantId,context.userId,context.membershipId,productId,
          JSON.stringify({imageUrl})]
      );
      return {updated:true,imageUrl};
    });
  }

}
