import {
  BadRequestException,
  Injectable
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type SearchItem = {
  type: "PARTY" | "DEAL" | "SALES_ORDER" | "SKU" | "PURCHASE_ORDER";
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

@Injectable()
export class GlobalSearchService {
  constructor(private readonly database: DatabaseService) {}

  async search(
    context: TenantContext,
    queryInput: string
  ): Promise<{
    query: string;
    items: SearchItem[];
    quickActions: Array<{
      key: string;
      label: string;
      href: string;
    }>;
  }> {
    const query = String(queryInput ?? "").trim();
    if (query.length < 2) {
      throw new BadRequestException("Введите минимум 2 символа");
    }
    if (query.length > 100) {
      throw new BadRequestException("Слишком длинный поисковый запрос");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const permissionRows = await client.query<{
        permission_code: string;
      }>(
        `SELECT DISTINCT rp.permission_code
         FROM membership_role mr
         JOIN role_permission rp
           ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
         WHERE mr.tenant_id=$1 AND mr.membership_id=$2`,
        [context.tenantId, context.membershipId]
      );

      const permissions = new Set(
        permissionRows.rows.map((row) => row.permission_code)
      );
      const allowed = (code: string) =>
        permissions.has("*") || permissions.has(code);

      const pattern = "%" + query + "%";
      const items: SearchItem[] = [];

      if (allowed("crm.read")) {
        const [parties,deals] = await Promise.all([
          client.query<{
            id: string;
            display_name: string;
            type: string;
          }>(
            `SELECT id,display_name,type
             FROM party
             WHERE tenant_id=$1
               AND status='ACTIVE'
               AND display_name ILIKE $2
             ORDER BY display_name
             LIMIT 5`,
            [context.tenantId, pattern]
          ),
          client.query<{
            id: string;
            title: string;
            party_name: string | null;
          }>(
            `SELECT d.id,d.title,p.display_name AS party_name
             FROM crm_deal d
             LEFT JOIN party p
               ON p.tenant_id=d.tenant_id AND p.id=d.party_id
             WHERE d.tenant_id=$1
               AND (
                 d.title ILIKE $2
                 OR p.display_name ILIKE $2
               )
               AND (
                 d.responsible_membership_id=$3
                 OR EXISTS(
                   SELECT 1
                   FROM membership_role mr
                   JOIN role_permission rp
                     ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
                   WHERE mr.tenant_id=d.tenant_id
                     AND mr.membership_id=$3
                     AND rp.permission_code IN ('*','crm.read')
                     AND rp.scope='all'
                 )
               )
             ORDER BY d.updated_at DESC
             LIMIT 5`,
            [context.tenantId, pattern, context.membershipId]
          )
        ]);

        for (const row of parties.rows) {
          items.push({
            type: "PARTY",
            id: row.id,
            title: row.display_name,
            subtitle: row.type === "ORGANIZATION" ? "Организация" : "Клиент",
            href: "/app/crm/deals?party=" + row.id
          });
        }

        for (const row of deals.rows) {
          items.push({
            type: "DEAL",
            id: row.id,
            title: row.title,
            subtitle: row.party_name ? "Сделка · " + row.party_name : "Сделка",
            href: "/app/crm/deals?deal=" + row.id
          });
        }
      }

      if (allowed("sales.read")) {
        const orders = await client.query<{
          id: string;
          business_number: string;
          party_name: string | null;
        }>(
          `SELECT o.id,o.business_number,p.display_name AS party_name
           FROM sales_order o
           LEFT JOIN party p
             ON p.tenant_id=o.tenant_id AND p.id=o.party_id
           WHERE o.tenant_id=$1
             AND (
               o.business_number ILIKE $2
               OR p.display_name ILIKE $2
             )
             AND (
               o.responsible_membership_id=$3
               OR o.responsible_membership_id IS NULL
               OR EXISTS(
                 SELECT 1
                 FROM membership_role mr
                 JOIN role_permission rp
                   ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
                 WHERE mr.tenant_id=o.tenant_id
                   AND mr.membership_id=$3
                   AND rp.permission_code IN ('*','sales.read')
                   AND rp.scope='all'
               )
             )
           ORDER BY o.created_at DESC
           LIMIT 5`,
          [context.tenantId, pattern, context.membershipId]
        );

        for (const row of orders.rows) {
          items.push({
            type: "SALES_ORDER",
            id: row.id,
            title: row.business_number,
            subtitle: row.party_name ? "Заказ · " + row.party_name : "Заказ",
            href: "/app/sales/orders?order=" + row.id
          });
        }
      }

      if (allowed("catalog.read")) {
        const sku = await client.query<{
          sku_id: string;
          sku_code: string;
          product_name: string;
        }>(
          `SELECT s.id AS sku_id,s.code AS sku_code,p.name AS product_name
           FROM sku s
           JOIN product_variant v
             ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
           JOIN product p
             ON p.tenant_id=v.tenant_id AND p.id=v.product_id
           WHERE s.tenant_id=$1
             AND s.status='ACTIVE'
             AND p.status='ACTIVE'
             AND (
               s.code ILIKE $2
               OR p.name ILIKE $2
               OR COALESCE(s.barcode,'') ILIKE $2
             )
           ORDER BY p.name,s.code
           LIMIT 5`,
          [context.tenantId, pattern]
        );

        for (const row of sku.rows) {
          items.push({
            type: "SKU",
            id: row.sku_id,
            title: row.product_name,
            subtitle: "SKU " + row.sku_code,
            href: "/app/catalog/products?sku=" + row.sku_id
          });
        }
      }

      if (allowed("procurement.read")) {
        const purchases = await client.query<{
          id: string;
          business_number: string;
          supplier_name: string;
        }>(
          `SELECT po.id,po.business_number,p.display_name AS supplier_name
           FROM purchase_order po
           JOIN party p
             ON p.tenant_id=po.tenant_id AND p.id=po.supplier_party_id
           WHERE po.tenant_id=$1
             AND (
               po.business_number ILIKE $2
               OR p.display_name ILIKE $2
             )
             AND (
               po.responsible_membership_id=$3
               OR po.responsible_membership_id IS NULL
               OR EXISTS(
                 SELECT 1
                 FROM membership_role mr
                 JOIN role_permission rp
                   ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
                 WHERE mr.tenant_id=po.tenant_id
                   AND mr.membership_id=$3
                   AND rp.permission_code IN ('*','procurement.read')
                   AND rp.scope='all'
               )
             )
           ORDER BY po.created_at DESC
           LIMIT 5`,
          [context.tenantId, pattern, context.membershipId]
        );

        for (const row of purchases.rows) {
          items.push({
            type: "PURCHASE_ORDER",
            id: row.id,
            title: row.business_number,
            subtitle: "Закупка · " + row.supplier_name,
            href: "/app/purchases?purchase=" + row.id
          });
        }
      }

      const quickActions: Array<{
        key: string;
        label: string;
        href: string;
      }> = [];

      const action = (
        permission: string,
        key: string,
        label: string,
        href: string
      ) => {
        if (allowed(permission)) {
          quickActions.push({ key, label, href });
        }
      };

      action("crm.write","new-deal","Создать сделку","/app/crm/deals?create=1");
      action("tasks.write","new-task","Создать задачу","/app/tasks?create=1");
      action("sales.write","new-order","Создать заказ","/app/sales/orders?create=1");
      action("catalog.write","new-product","Создать товар","/app/catalog/products?create=1");
      action("procurement.write","new-purchase","Создать закупку","/app/purchases?create=1");
      action("service.write","new-booking","Создать запись клиента","/app/service/bookings?create=1");

      return {
        query,
        items: items.slice(0, 25),
        quickActions
      };
    });
  }
}
