import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class CatalogService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext): Promise<Array<{
    productId: string;
    productName: string;
    kind: string;
    variantId: string;
    variantName: string;
    skuId: string;
    sku: string;
    barcode: string | null;
    salePriceMinor: string;
    costPriceMinor: string;
    currency: string;
    trackInventory: boolean;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        product_id: string;
        product_name: string;
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
        kind: row.kind,
        variantId: row.variant_id,
        variantName: row.variant_name,
        skuId: row.sku_id,
        sku: row.sku_code,
        barcode: row.barcode,
        salePriceMinor: row.sale_price_minor,
        costPriceMinor: row.cost_price_minor,
        currency: row.currency,
        trackInventory: row.track_inventory
      }));
    });
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
    }
  ): Promise<{ productId: string; variantId: string; skuId: string; sku: string }> {
    const name = input.name.trim();

    if (name.length < 2 || name.length > 240) {
      throw new BadRequestException("Некорректное название товара");
    }

    const salePriceMinor = input.salePriceMinor ?? "0";
    const costPriceMinor = input.costPriceMinor ?? "0";

    if (!/^\d+$/.test(salePriceMinor) || !/^\d+$/.test(costPriceMinor)) {
      throw new BadRequestException("Некорректная цена");
    }

    const skuCode =
      input.sku?.trim() ||
      `SKU-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

    return this.database.withTenantTransaction(context, async (client) => {
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
           tenant_id, category_id, name, kind, description
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [
          context.tenantId,
          input.categoryId ?? null,
          name,
          input.kind ?? "STOCKABLE",
          input.description?.trim() || null
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
}
