import {
  BadRequestException,
  Injectable
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { RuntimePressureService } from "../../platform/runtime-pressure/runtime-pressure.service";

type SearchItem = {
  type: "PARTY" | "DEAL" | "SALES_ORDER" | "SKU" | "PURCHASE_ORDER";
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

@Injectable()
export class GlobalSearchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: RuntimePressureService
  ) {}

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
    if (query.length < 3) {
      throw new BadRequestException("Введите минимум 3 символа");
    }
    if (query.length > 100) {
      throw new BadRequestException("Слишком длинный поисковый запрос");
    }

    const lease = await this.runtime.acquire(context, {
      operation: "global_search",
      scope: "MEMBERSHIP",
      limit: 2,
      ttlSeconds: 15,
      retryAfterSeconds: 3
    });

    try {
      return await this.database.withTenantTransaction(context, async (client) => {
      const permissionRows = await client.query<{
        permission_code:string;scope:"own"|"team"|"branch"|"all";
      }>(
        `SELECT rp.permission_code,rp.scope
         FROM membership_role mr
         JOIN role_permission rp
           ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
         JOIN tenant_membership tm
           ON tm.tenant_id=mr.tenant_id AND tm.id=mr.membership_id
         WHERE mr.tenant_id=$1 AND mr.membership_id=$2
           AND tm.user_id=$3 AND tm.status='ACTIVE'`,
        [context.tenantId,context.membershipId,context.userId]
      );
      const rank:Record<string,number>={own:1,team:2,branch:3,all:4};
      const effective=new Map<string,string>();
      for(const row of permissionRows.rows){
        if((rank[row.scope]??0)>(rank[effective.get(row.permission_code)??""]??0))
          effective.set(row.permission_code,row.scope);
      }
      const scope=(code:string):string|null=>{
        const exact=effective.get(code);
        const wildcard=effective.get("*");
        if(!exact)return wildcard??null;
        if(!wildcard)return exact;
        return rank[exact]>=rank[wildcard]?exact:wildcard;
      };
      const allowed=(code:string)=>scope(code)!==null;
      const scopedMembers=async(code:string):Promise<string[]|null>=>{
        const permissionScope=scope(code);
        if(permissionScope==="all")return null;
        if(!permissionScope)return [];
        if(permissionScope==="own")return [context.membershipId];
        const [team,branch]=await Promise.all([
          client.query<{membership_id:string}>(`
            SELECT DISTINCT members.membership_id FROM team_membership actor
            JOIN team_membership members
              ON members.tenant_id=actor.tenant_id AND members.team_id=actor.team_id
            WHERE actor.tenant_id=$1 AND actor.membership_id=$2
          `,[context.tenantId,context.membershipId]),
          permissionScope==="branch"?
            client.query<{membership_id:string}>(`
              SELECT DISTINCT peers.membership_id
              FROM team_membership actor
              JOIN team teams ON teams.tenant_id=actor.tenant_id AND teams.id=actor.team_id
              JOIN team peers_teams ON peers_teams.tenant_id=teams.tenant_id
                AND peers_teams.branch_id=teams.branch_id
              JOIN team_membership peers ON peers.tenant_id=peers_teams.tenant_id
                AND peers.team_id=peers_teams.id
              WHERE actor.tenant_id=$1 AND actor.membership_id=$2
                AND teams.branch_id IS NOT NULL
            `,[context.tenantId,context.membershipId])
            :Promise.resolve({rows:[] as Array<{membership_id:string}>})
        ]);
        return [...new Set([context.membershipId,
          ...team.rows.map(r=>r.membership_id),...branch.rows.map(r=>r.membership_id)])];
      };
      const crmIds=await scopedMembers("crm.read");
      const salesIds=await scopedMembers("sales.read");
      const procurementIds=await scopedMembers("procurement.read");

      const pattern = "%" + query.replace(/[\\%_]/g,"\\$&") + "%";
      const items: SearchItem[] = [];

      if (allowed("crm.read")) {
        const [parties,deals] = await Promise.all([
          client.query<{
            id: string;
            display_name: string;
            type: string;
          }>(
            `SELECT p.id,p.display_name,p.type
             FROM party p
             WHERE p.tenant_id=$1
               AND p.status='ACTIVE'
               AND p.display_name ILIKE $2
               AND ($4::uuid[] IS NULL
                 OR p.responsible_membership_id=ANY($4::uuid[]))
             ORDER BY p.display_name
             LIMIT 5`,
            [context.tenantId, pattern, context.membershipId, crmIds]
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
               AND ($4::uuid[] IS NULL
                 OR d.responsible_membership_id=ANY($4::uuid[]))
             ORDER BY d.updated_at DESC
             LIMIT 5`,
            [context.tenantId, pattern, context.membershipId, crmIds]
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
             AND ($4::uuid[] IS NULL
               OR o.responsible_membership_id=ANY($4::uuid[]))
           ORDER BY o.created_at DESC
           LIMIT 5`,
          [context.tenantId,pattern,context.membershipId,salesIds]
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

      if (scope("catalog.read")==="all") {
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
             AND ($4::uuid[] IS NULL
               OR po.responsible_membership_id=ANY($4::uuid[]))
           ORDER BY po.created_at DESC
           LIMIT 5`,
          [context.tenantId,pattern,context.membershipId,procurementIds]
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
    } finally {
      await this.runtime.release(context, lease.leaseKey);
    }
  }
}
